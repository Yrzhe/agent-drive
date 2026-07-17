#!/usr/bin/env bash
# End-to-end tests for update.sh. Self-contained: writes a fixture server that emulates
# GET /api/public/skill/manifest and /file?path=..., then drives update.sh against a
# throwaway "installed skill" dir. Run: bash skill/scripts/update.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE="$HERE/update.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adrive-updatetest.XXXXXX")"
SERVER_PID=""; SERVER_URL=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
# Portable content hash of a whole dir (python3 is a hard dep of update.sh anyway).
snap() { python3 - "$1" <<'PY'
import hashlib, os, sys
root=sys.argv[1]; out=[]
for dp,_,fs in os.walk(root):
    for f in sorted(fs):
        p=os.path.join(dp,f)
        out.append(os.path.relpath(p,root)+":"+hashlib.sha256(open(p,"rb").read()).hexdigest())
print("\n".join(sorted(out)))
PY
}

# ---- fixture "remote skill" the server publishes ----
REMOTE="$WORK/remote-skill"; mkdir -p "$REMOTE/references"
printf '2.0.0\n' > "$REMOTE/VERSION"
printf '# SKILL v2\nnew content\n' > "$REMOTE/SKILL.md"
printf 'mcp updated\n' > "$REMOTE/references/mcp.md"
printf 'unchanged ref\n' > "$REMOTE/references/setup.md"

cat > "$WORK/server.py" <<'PY'
import http.server, json, hashlib, os, sys, urllib.parse, socketserver
ROOT, MODE, PORTFILE = sys.argv[1], sys.argv[2], sys.argv[3]
FILES = ["SKILL.md", "references/mcp.md", "references/setup.md"]
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _s(self, code, ctype, body):
        self.send_response(code); self.send_header("Content-Type", ctype); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/public/skill/manifest":
            if MODE == "html":
                return self._s(200, "text/html", b"<!doctype html><html>landing</html>")
            ver = open(os.path.join(ROOT, "VERSION")).read().strip()
            files = [{"path": p, "sha256": sha(os.path.join(ROOT, p)), "bytes": os.path.getsize(os.path.join(ROOT, p))} for p in FILES]
            if MODE == "hostile":          # tries to plant config
                files += [{"path": ".env", "sha256": "0"*64, "bytes": 9},
                          {"path": "drive.json", "sha256": "0"*64, "bytes": 9}]
            if MODE == "traversal":        # tries to escape the skill dir
                files += [{"path": "../../../../tmp/ADRIVE_EVIL", "sha256": "0"*64, "bytes": 4}]
            return self._s(200, "application/json", json.dumps({"version": ver, "files": files}).encode())
        if u.path == "/api/public/skill/file":
            p = (q.get("path") or [""])[0]
            if p in FILES:
                data = open(os.path.join(ROOT, p), "rb").read()
                if MODE == "corrupt" and p == "SKILL.md": data += b"TAMPERED"
                return self._s(200, "text/markdown", data)
            return self._s(200, "text/plain", b"POISONED\n")   # anything off-manifest: poison, to prove it's never fetched
        return self._s(404, "text/plain", b"nope")
srv = socketserver.TCPServer(("127.0.0.1", 0), H)
open(PORTFILE, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY

start_server() {  # sets SERVER_URL + SERVER_PID in the PARENT shell (no subshell -> no orphans)
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
  local pf="$WORK/port"; rm -f "$pf"
  python3 "$WORK/server.py" "$REMOTE" "$1" "$pf" > "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do [ -s "$pf" ] && break; sleep 0.1; done
  [ -s "$pf" ] || { echo "server failed to start"; cat "$WORK/server.log"; exit 1; }
  SERVER_URL="http://127.0.0.1:$(cat "$pf")"
}

fresh_install() {  # an installed skill matching the remote (up to date)
  local d="$1"
  mkdir -p "$d/scripts" "$d/references"
  cp "$UPDATE" "$d/scripts/update.sh"
  printf '{"url":"%s"}\n' "$SERVER_URL" > "$d/drive.json"
  printf 'KEEP_ME_SECRET\n' > "$d/.env"
  cp "$REMOTE/VERSION" "$d/VERSION"; cp "$REMOTE/SKILL.md" "$d/SKILL.md"
  cp "$REMOTE/references/mcp.md" "$d/references/mcp.md"; cp "$REMOTE/references/setup.md" "$d/references/setup.md"
}

echo "== update.sh e2e =="

# 1) --check on an up-to-date install: up to date, no writes
start_server ok; D="$WORK/i1"; fresh_install "$D"
b="$(snap "$D")"; out="$(bash "$D/scripts/update.sh" --check 2>&1)"; rc=$?; a="$(snap "$D")"
{ [ $rc -eq 0 ] && grep -q "up to date" <<<"$out" && [ "$b" = "$a" ]; } \
  && ok "--check fresh: up to date, no writes" || { bad "--check fresh"; echo "$out"; }

# 2) a stale local file is updated to the remote bytes
D="$WORK/i2"; fresh_install "$D"; printf 'OLD STALE\n' > "$D/SKILL.md"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -eq 0 ] && [ "$(cat "$D/SKILL.md")" = "$(cat "$REMOTE/SKILL.md")" ] \
  && grep -q "changed  SKILL.md" <<<"$out" && grep -q "wrote    SKILL.md" <<<"$out"; } \
  && ok "stale SKILL.md updated to remote bytes" || { bad "stale update"; echo "$out"; }

# 3) an HTML manifest aborts, nothing changed
start_server html; D="$WORK/i3"; fresh_install "$D"; printf 'OLD\n' > "$D/SKILL.md"; s="$(snap "$D")"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(snap "$D")" = "$s" ] && grep -qi "not valid json\|aborting" <<<"$out"; } \
  && ok "HTML manifest aborts, nothing changed" || { bad "html abort"; echo "rc=$rc"; echo "$out"; }

# 4) a sha256 mismatch aborts, skill untouched
start_server corrupt; D="$WORK/i4"; fresh_install "$D"; printf 'OLD\n' > "$D/SKILL.md"; s="$(snap "$D")"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(snap "$D")" = "$s" ] && grep -qi "sha256 mismatch" <<<"$out"; } \
  && ok "sha256 mismatch aborts, nothing changed" || { bad "sha mismatch"; echo "rc=$rc"; echo "$out"; }

# 5) CRITICAL: a manifest with a ../ traversal path is rejected — nothing written, nothing escapes
rm -f /tmp/ADRIVE_EVIL
start_server traversal; D="$WORK/i5"; fresh_install "$D"; printf 'OLD\n' > "$D/SKILL.md"; s="$(snap "$D")"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(snap "$D")" = "$s" ] && [ ! -e /tmp/ADRIVE_EVIL ] && grep -qi "rejected\|aborting" <<<"$out"; } \
  && ok "path traversal rejected — nothing written or escaped" || { bad "TRAVERSAL"; echo "rc=$rc"; echo "$out"; ls -l /tmp/ADRIVE_EVIL 2>/dev/null; }

# 6) a hostile manifest listing .env/drive.json is rejected (fail-closed) — config intact
start_server hostile; D="$WORK/i6"; fresh_install "$D"
env_b="$(cat "$D/.env")"; dj_b="$(cat "$D/drive.json")"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(cat "$D/.env")" = "$env_b" ] && [ "$(cat "$D/drive.json")" = "$dj_b" ] \
  && grep -qi "config\|rejected\|aborting" <<<"$out"; } \
  && ok "hostile config manifest rejected, .env/drive.json intact" || { bad "config guard"; echo "rc=$rc"; echo "$out"; }

# 7) a destination symlink is refused (never followed to overwrite outside the skill)
start_server ok; D="$WORK/i7"; fresh_install "$D"; printf 'OLD\n' > "$D/SKILL.md"
outside="$WORK/outside.txt"; printf 'DO NOT TOUCH\n' > "$outside"
ln -sf "$outside" "$D/SKILL.md.link" 2>/dev/null
rm -f "$D/SKILL.md"; ln -sf "$outside" "$D/SKILL.md"   # SKILL.md is now a symlink out of the tree
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(cat "$outside")" = "DO NOT TOUCH" ] && grep -qi "symlink" <<<"$out"; } \
  && ok "destination symlink refused, outside file intact" || { bad "symlink dest"; echo "rc=$rc"; echo "$out"; }

# 8) version-only bump (identical content, higher VERSION) refreshes the local marker
start_server ok; D="$WORK/i8"; fresh_install "$D"; printf '1.0.0\n' > "$D/VERSION"  # behind on version, files identical
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -eq 0 ] && [ "$(cat "$D/VERSION")" = "2.0.0" ]; } \
  && ok "version-only bump refreshes local VERSION" || { bad "version-only"; echo "rc=$rc"; echo "$out"; }

# 9) no hardcoded production host anywhere in the shipped script
grep -qE "edgespark\.app|large-gator" "$UPDATE" \
  && bad "hardcoded host in update.sh" || ok "no hardcoded host — URL from drive.json"

# 10) missing drive.json fails clearly, writes nothing
D="$WORK/i10"; mkdir -p "$D/scripts"; cp "$UPDATE" "$D/scripts/update.sh"
out="$(bash "$D/scripts/update.sh" --check 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && grep -qi "no drive.json" <<<"$out"; } \
  && ok "missing drive.json -> clear failure" || { bad "missing drive.json"; echo "$out"; }

# 11) no orphaned fixture servers left behind (the harness must clean up after itself)
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
leaked="$(pgrep -f "$WORK/server.py" 2>/dev/null | wc -l | tr -d ' ')"
[ "$leaked" = "0" ] && ok "no orphaned fixture server processes" || bad "leaked $leaked server process(es)"

echo "== $pass passed, $fail failed =="
[ $fail -eq 0 ]
