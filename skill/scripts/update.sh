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

# Never overwrite the owner's config, regardless of what a manifest claims. Client-side
# rule, not a server omission — a hostile manifest must not be able to plant a token.
is_protected() {
  case "$1" in
    drive.json|.env|*/drive.json|*/.env) return 0 ;;
    *) return 1 ;;
  esac
}

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

# Parse strictly; emit TSV rows "path<TAB>sha256". Rejects HTML / wrong shape / protected paths.
ROWS="$(python3 - "$MANIFEST" <<'PY'
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    sys.exit("remote manifest is not valid JSON (a wrong URL or the SPA fallback page?) — aborting")
if not isinstance(m, dict) or "version" not in m or not isinstance(m.get("files"), list):
    sys.exit("remote manifest has an unexpected shape — aborting")
print("VERSION\t" + str(m["version"]))
for f in m["files"]:
    if not isinstance(f, dict) or "path" not in f or "sha256" not in f:
        sys.exit("a manifest file entry is malformed — aborting")
    print(str(f["path"]) + "\t" + str(f["sha256"]))
PY
)" || exit 1

REMOTE_VERSION=""
declare -a PATHS=() SHAS=()
while IFS=$'\t' read -r p s; do
  if [ "$p" = "VERSION" ]; then REMOTE_VERSION="$s"; continue; fi
  PATHS+=("$p"); SHAS+=("$s")
done <<< "$ROWS"

LOCAL_VERSION="$(cat "$SKILL_DIR/VERSION" 2>/dev/null || echo "unknown")"

# ---- classify each file: added / changed / unchanged / skipped(protected) ----
declare -a TO_FETCH=()
added=0; changed=0; unchanged=0; skipped=0
echo "agent-drive skill update — local v$LOCAL_VERSION → remote v$REMOTE_VERSION"
echo "  source: $BASE"
for i in "${!PATHS[@]}"; do
  p="${PATHS[$i]}"; want="${SHAS[$i]}"; local_file="$SKILL_DIR/$p"
  if is_protected "$p"; then
    echo "  skip     $p (protected local config)"; skipped=$((skipped+1)); continue
  fi
  if [ ! -f "$local_file" ]; then
    echo "  added    $p"; added=$((added+1)); TO_FETCH+=("$i")
  elif [ "$(sha256 "$local_file")" != "$want" ]; then
    echo "  changed  $p"; changed=$((changed+1)); TO_FETCH+=("$i")
  else
    if [ "$MODE" = "force" ]; then TO_FETCH+=("$i"); fi
    unchanged=$((unchanged+1))
  fi
done
echo "  summary: $added added, $changed changed, $unchanged unchanged, $skipped skipped"

if [ "$MODE" = "check" ]; then
  [ $((added+changed)) -eq 0 ] && echo "  up to date." || echo "  run without --check to apply."
  exit 0
fi
if [ "${#TO_FETCH[@]}" -eq 0 ]; then echo "  nothing to do."; exit 0; fi

# ---- download every target into the staging dir and verify sha256 BEFORE any swap ----
for i in "${TO_FETCH[@]}"; do
  p="${PATHS[$i]}"; want="${SHAS[$i]}"; staged="$TMP/files/$p"
  mkdir -p "$(dirname "$staged")"
  enc_p="$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$p")"
  curl -fsS "$BASE/file?path=$enc_p" -o "$staged" \
    || die "download failed for $p — nothing changed"
  got="$(sha256 "$staged")"
  [ "$got" = "$want" ] || die "sha256 mismatch for $p (expected $want, got $got) — nothing changed"
done

# ---- all verified: swap into place ----
for i in "${TO_FETCH[@]}"; do
  p="${PATHS[$i]}"; staged="$TMP/files/$p"; dest="$SKILL_DIR/$p"
  mkdir -p "$(dirname "$dest")"
  cp "$staged" "$dest"
  echo "  wrote    $p"
done

# Refresh the local VERSION marker last, once files are in place.
[ -n "$REMOTE_VERSION" ] && printf '%s\n' "$REMOTE_VERSION" > "$SKILL_DIR/VERSION"
echo "  done — now at v$REMOTE_VERSION (${#TO_FETCH[@]} file(s) written)."
