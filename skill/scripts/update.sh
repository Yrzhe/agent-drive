#!/usr/bin/env bash
#
# Self-update this installed agent-drive skill from its own deployment.
#
#   update.sh --check     report local vs remote version + changed files; write nothing
#   update.sh             apply: download changed/new files, verify, then swap in
#   update.sh --force     re-download every manifest file even if the sha256 matches
#
# The deployment URL is read from the skill's own drive.json ("url") — never hardcoded,
# so every owner's copy updates from their own drive. Files are verified by sha256
# against the manifest and staged in a temp dir; nothing is written unless every file
# verifies. Local config (drive.json, .env) is never touched, even if a manifest lists it.
#
# Requires: bash, curl, python3.

set -euo pipefail

MODE="apply"
case "${1:-}" in
  --check) MODE="check" ;;
  --force) MODE="force" ;;
  "")      MODE="apply" ;;
  -h|--help)
    sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "update.sh: unknown option '$1' (use --check, --force, or no argument)" >&2; exit 2 ;;
esac

# skill root = the directory that contains this scripts/ dir.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRIVE_JSON="$SKILL_DIR/drive.json"

die() { echo "update.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
need curl; need python3

[ -f "$DRIVE_JSON" ] || die "no drive.json at $DRIVE_JSON — this must run inside an installed skill"

URL="$(python3 - "$DRIVE_JSON" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(f"drive.json is not valid JSON: {e}")
u = (d.get("url") or "").rstrip("/")
if not u.startswith(("http://", "https://")):
    sys.exit("drive.json has no valid 'url'")
print(u)
PY
)" || die "could not read 'url' from drive.json"

BASE="$URL/api/public/skill"
sha256() { python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }

# ---- fetch + strictly validate the manifest (must be JSON, not the SPA HTML page) ----
TMP="$(mktemp -d "${TMPDIR:-/tmp}/adrive-skill.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
MANIFEST="$TMP/manifest.json"

curl -fsS "$BASE/manifest" -o "$MANIFEST" \
  || die "could not fetch $BASE/manifest (HTTP error) — nothing changed"

# Parse strictly AND validate every path against a hard allowlist BEFORE any of it can
# reach the shell. Fail-closed: one bad entry aborts the whole run, so a hostile or
# corrupt manifest can never write outside the skill dir or touch config. Done in Python
# (no shell-quoting/word-splitting risk) and enforced here rather than trusting the server.
ROWS="$(python3 - "$MANIFEST" <<'PY'
import json, re, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    sys.exit("remote manifest is not valid JSON (a wrong URL or the SPA fallback page?) — aborting")
if not isinstance(m, dict) or "version" not in m or not isinstance(m.get("files"), list):
    sys.exit("remote manifest has an unexpected shape — aborting")

# The server serves exactly these shapes; the client re-enforces them.
ALLOW = re.compile(r"^(SKILL\.md|references/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\.md)$")
SHA = re.compile(r"^[0-9a-f]{64}$")

def reject(p, why):
    sys.exit(f"manifest path {p!r} rejected ({why}) — aborting, nothing changed")

seen = set()
rows = []
for f in m["files"]:
    if not isinstance(f, dict) or "path" not in f or "sha256" not in f:
        sys.exit("a manifest file entry is malformed — aborting")
    p, s = str(f["path"]), str(f["sha256"])
    # Belt-and-suspenders before the allowlist even runs.
    if p.startswith("/") or p.startswith("-") or ".." in p or "\\" in p or "\x00" in p or "\n" in p:
        reject(p, "unsafe path")
    if not ALLOW.match(p):
        reject(p, "not an allowlisted skill file")
    # Case-insensitive config guard (macOS/Windows filesystems fold case).
    base = p.rsplit("/", 1)[-1].lower()
    if base in (".env", "drive.json") or p.lower() in (".env", "drive.json"):
        reject(p, "would touch local config")
    if not SHA.match(s):
        reject(p, "sha256 is not 64 lowercase hex")
    if p in seen:
        reject(p, "duplicate path")
    seen.add(p)
    rows.append((p, s))

print("VERSION\t" + str(m["version"]))
for p, s in rows:
    print(p + "\t" + s)
PY
)" || exit 1

REMOTE_VERSION=""
declare -a PATHS=() SHAS=()
while IFS=$'\t' read -r p s; do
  if [ "$p" = "VERSION" ]; then REMOTE_VERSION="$s"; continue; fi
  PATHS+=("$p"); SHAS+=("$s")
done <<< "$ROWS"

LOCAL_VERSION="$(cat "$SKILL_DIR/VERSION" 2>/dev/null || echo "unknown")"

# ---- classify each file: added / changed / unchanged ----
# Paths are already allowlisted (SKILL.md | references/*.md) — no config, no traversal.
declare -a TO_FETCH=()
added=0; changed=0; unchanged=0
echo "agent-drive skill update — local v$LOCAL_VERSION → remote v$REMOTE_VERSION"
echo "  source: $BASE"
for i in "${!PATHS[@]}"; do
  p="${PATHS[$i]}"; want="${SHAS[$i]}"; local_file="$SKILL_DIR/$p"
  if [ ! -f "$local_file" ]; then
    echo "  added    $p"; added=$((added+1)); TO_FETCH+=("$i")
  elif [ "$(sha256 "$local_file")" != "$want" ]; then
    echo "  changed  $p"; changed=$((changed+1)); TO_FETCH+=("$i")
  else
    [ "$MODE" = "force" ] && TO_FETCH+=("$i")
    unchanged=$((unchanged+1))
  fi
done
# A version-only release (content identical, VERSION bumped) still needs the marker refreshed.
version_only=0
if [ "${#TO_FETCH[@]}" -eq 0 ] && [ -n "$REMOTE_VERSION" ] && [ "$REMOTE_VERSION" != "$LOCAL_VERSION" ]; then
  version_only=1
fi
echo "  summary: $added added, $changed changed, $unchanged unchanged"

if [ "$MODE" = "check" ]; then
  if [ $((added+changed)) -eq 0 ] && [ "$version_only" -eq 0 ]; then echo "  up to date."; else echo "  run without --check to apply."; fi
  exit 0
fi
if [ "${#TO_FETCH[@]}" -eq 0 ] && [ "$version_only" -eq 0 ]; then echo "  nothing to do."; exit 0; fi

# curl safety: bounded time + size + explicit redirect refusal. Non-loopback must be https.
case "$URL" in
  https://*) : ;;
  http://127.0.0.1*|http://localhost*|http://[::1]*) : ;;  # loopback only (dev/tests)
  http://*) die "refusing plaintext http for a non-loopback drive URL: $URL" ;;
esac
CURL=(curl -fsS --max-time 60 --max-filesize 10000000 --proto-redir "-all")

# ---- download every target into staging and verify sha256 BEFORE touching the skill ----
for i in ${TO_FETCH[@]+"${TO_FETCH[@]}"}; do
  p="${PATHS[$i]}"; want="${SHAS[$i]}"; staged="$TMP/files/$p"
  mkdir -p "$(dirname "$staged")"
  enc_p="$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$p")"
  "${CURL[@]}" "$BASE/file?path=$enc_p" -o "$staged" \
    || die "download failed for $p — nothing changed"
  got="$(sha256 "$staged")"
  [ "$got" = "$want" ] || die "sha256 mismatch for $p (expected $want, got $got) — nothing changed"
done

# ---- all verified: swap in with a per-file atomic rename (never write in place) ----
for i in ${TO_FETCH[@]+"${TO_FETCH[@]}"}; do
  p="${PATHS[$i]}"; staged="$TMP/files/$p"; dest="$SKILL_DIR/$p"
  [ -L "$dest" ] && die "refusing to overwrite a symlink: $dest"
  mkdir -p "$(dirname "$dest")"
  tmp_dest="$(dirname "$dest")/.update.$$.$RANDOM.tmp"
  cp "$staged" "$tmp_dest" && mv -f "$tmp_dest" "$dest" \
    || { rm -f "$tmp_dest"; die "failed writing $p — some files may already be updated; re-run to finish"; }
  echo "  wrote    $p"
done

# Refresh the local VERSION marker last, once every file is in place.
if [ -n "$REMOTE_VERSION" ] && { [ "${#TO_FETCH[@]}" -gt 0 ] || [ "$version_only" -eq 1 ]; }; then
  printf '%s\n' "$REMOTE_VERSION" > "$SKILL_DIR/VERSION"
fi
echo "  done — now at v$REMOTE_VERSION (${#TO_FETCH[@]} file(s) written)."
