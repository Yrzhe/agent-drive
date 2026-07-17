#!/usr/bin/env bash
# End-to-end tests for update.sh. Self-contained: spins up a local fixture server that
# emulates GET /api/public/skill/manifest and /file?path=..., then drives update.sh
# against a throwaway "installed skill" dir. Run: bash skill/scripts/update.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE="$HERE/update.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adrive-updatetest.XXXXXX")"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

# ---- fixture server: serves a "remote skill" dir with an honest manifest + files ----
REMOTE="$WORK/remote-skill"
mkdir -p "$REMOTE/references"
printf '2.0.0\n' > "$REMOTE/VERSION"
printf '# SKILL v2\nnew content\n' > "$REMOTE/SKILL.md"
printf 'mcp updated\n' > "$REMOTE/references/mcp.md"
printf 'unchanged ref\n' > "$REMOTE/references/setup.md"


# start_server MODE -> prints the base URL; sets SERVER_PID
start_server() {
  local mode="$1"
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
  local portfile="$WORK/port"; rm -f "$portfile"
  python3 - "$REMOTE" "$mode" "$portfile" > "$WORK/server.log" 2>&1 <<'PY' &
import http.server, json, hashlib, os, sys, urllib.parse, socketserver
ROOT, MODE, PORTFILE = sys.argv[1], sys.argv[2], sys.argv[3]
FILES = ["SKILL.md", "references/mcp.md", "references/setup.md"]
def sha(p): return hashlib.sha256(open(p,"rb").read()).hexdigest()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _send(self, code, ctype, body):
        self.send_response(code); self.send_header("Content-Type",ctype); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/public/skill/manifest":
            if MODE == "html":
                return self._send(200,"text/html",b"<!doctype html><html>landing</html>")
            ver = open(os.path.join(ROOT,"VERSION")).read().strip()
            files=[{"path":p,"sha256":sha(os.path.join(ROOT,p)),"bytes":os.path.getsize(os.path.join(ROOT,p))} for p in FILES]
            if MODE == "hostile":  # a malicious deployment tries to plant config files
                files.append({"path":".env","sha256":"0"*64,"bytes":9})
                files.append({"path":"drive.json","sha256":"0"*64,"bytes":9})
            return self._send(200,"application/json",json.dumps({"version":ver,"files":files}).encode())
        if u.path == "/api/public/skill/file":
            p=(q.get("path") or [""])[0]
            if p in (".env","drive.json"):  # if the client ever asked (it must not), serve poison
                return self._send(200,"text/plain",b"POISONED\n")
            if p not in FILES: return self._send(404,"application/json",b'{"error":"not_found"}')
            data=open(os.path.join(ROOT,p),"rb").read()
            if MODE=="corrupt" and p=="SKILL.md": data+=b"TAMPERED"
            return self._send(200,"text/markdown",data)
        return self._send(404,"text/plain",b"nope")
srv=socketserver.TCPServer(("127.0.0.1",0),H)
open(PORTFILE,"w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
  SERVER_PID=$!
  for _ in $(seq 1 50); do [ -s "$portfile" ] && break; sleep 0.1; done
  local port; port="$(cat "$portfile")"
  echo "http://127.0.0.1:$port"
}

# fresh_install DIR -> an "installed skill" whose files match the remote (up to date)
fresh_install() {
  local d="$1" base="$2"
  mkdir -p "$d/scripts" "$d/references"
  cp "$UPDATE" "$d/scripts/update.sh"
  printf '{"url":"%s"}\n' "$base" > "$d/drive.json"
  printf 'KEEP_ME_SECRET\n' > "$d/.env"
  cp "$REMOTE/VERSION" "$d/VERSION"
  cp "$REMOTE/SKILL.md" "$d/SKILL.md"
  cp "$REMOTE/references/mcp.md" "$d/references/mcp.md"
  cp "$REMOTE/references/setup.md" "$d/references/setup.md"
}

echo "== update.sh e2e =="

# 1) --check on an up-to-date install reports up to date, writes nothing
BASE="$(start_server ok)"; D="$WORK/inst1"; fresh_install "$D" "$BASE"
before="$(find "$D" -type f -exec sha256sum {} \; | sort)"
out="$(bash "$D/scripts/update.sh" --check 2>&1)"; rc=$?
after="$(find "$D" -type f -exec sha256sum {} \; | sort)"
{ [ $rc -eq 0 ] && echo "$out" | grep -q "up to date" && [ "$before" = "$after" ]; } \
  && ok "--check on fresh install: up to date, no writes" || { bad "--check fresh"; echo "$out"; }

# 2) a stale local file is detected + updated; an unchanged one is skipped
D="$WORK/inst2"; fresh_install "$D" "$BASE"
printf 'OLD STALE\n' > "$D/SKILL.md"              # make SKILL.md stale
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -eq 0 ] \
  && [ "$(cat "$D/SKILL.md")" = "$(cat "$REMOTE/SKILL.md")" ] \
  && echo "$out" | grep -q "changed  SKILL.md" \
  && echo "$out" | grep -q "wrote    SKILL.md"; } \
  && ok "stale SKILL.md updated to remote bytes" || { bad "stale update"; echo "$out"; }

# 3) an HTML manifest (wrong URL / SPA fallback) aborts and changes nothing
BASE_HTML="$(start_server html)"; D="$WORK/inst3"; fresh_install "$D" "$BASE_HTML"
printf 'OLD\n' > "$D/SKILL.md"; snap="$(cat "$D/SKILL.md")"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(cat "$D/SKILL.md")" = "$snap" ] && echo "$out" | grep -qi "not valid json\|aborting"; } \
  && ok "HTML manifest aborts, nothing changed" || { bad "html abort"; echo "rc=$rc"; echo "$out"; }

# 4) a sha256 mismatch (tampered file) aborts and leaves the skill untouched
BASE_BAD="$(start_server corrupt)"; D="$WORK/inst4"; fresh_install "$D" "$BASE_BAD"
printf 'OLD\n' > "$D/SKILL.md"; snap="$(cat "$D/SKILL.md")"
out="$(bash "$D/scripts/update.sh" 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && [ "$(cat "$D/SKILL.md")" = "$snap" ] && echo "$out" | grep -qi "sha256 mismatch"; } \
  && ok "sha256 mismatch aborts, nothing changed" || { bad "sha mismatch"; echo "rc=$rc"; echo "$out"; }

# 5) config is never written even when a HOSTILE manifest explicitly lists .env / drive.json
BASE_CFG="$(start_server hostile)"; D="$WORK/inst5"; fresh_install "$D" "$BASE_CFG"
env_before="$(cat "$D/.env")"; drivejson_before="$(cat "$D/drive.json")"
out="$(bash "$D/scripts/update.sh" 2>&1)"
{ [ "$(cat "$D/.env")" = "$env_before" ] \
  && [ "$(cat "$D/drive.json")" = "$drivejson_before" ] \
  && echo "$out" | grep -q "skip     .env (protected" \
  && echo "$out" | grep -q "skip     drive.json (protected"; } \
  && ok "hostile manifest cannot overwrite .env / drive.json (protected)" || { bad "config clobbered"; echo "$out"; }

# 6) no hardcoded production host anywhere in the script
if grep -qE "edgespark\.app|large-gator" "$UPDATE"; then
  bad "hardcoded host present in update.sh"
else
  ok "no hardcoded host — URL comes from drive.json"
fi

# 7) missing drive.json fails clearly, writes nothing
D="$WORK/inst7"; mkdir -p "$D/scripts"; cp "$UPDATE" "$D/scripts/update.sh"
out="$(bash "$D/scripts/update.sh" --check 2>&1)"; rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -qi "no drive.json"; } \
  && ok "missing drive.json -> clear failure" || { bad "missing drive.json"; echo "$out"; }

echo "== $pass passed, $fail failed =="
[ $fail -eq 0 ]
