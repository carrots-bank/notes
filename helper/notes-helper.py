#!/usr/bin/env python3
"""Notes helper: lets the notes website ask the 🫏 assistant through the AI account on *this* computer.

It listens on 127.0.0.1 only, accepts requests only from the notes website, and passes each question (with the
lecture's slides, transcript and notes, assembled by the website) to the locally installed Claude Code (your Claude
subscription) or Codex (your ChatGPT subscription). Answers stream back to the page. Nothing is stored or logged.
Install/uninstall with install.sh / uninstall.sh next to this file. Needs only the Python that ships with macOS.

Relay: phones/iPads paired with this Mac (from the website's 🫏 panel) can send questions while away. They drop an
encrypted job in the person's mailbox on the notes' Cloudflare worker; this helper picks it up, answers with the same
local AI tool, and sends encrypted chunks back. Only the paired device and this Mac hold the key (HMAC-SHA256 in
counter mode + HMAC tag, stdlib only; mirrored in donkey.js). Settings: relay.json next to this file.
"""
import base64
import hashlib
import hmac
import time
import urllib.error
import urllib.request
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "4"
PORT = int(os.environ.get("NOTES_HELPER_PORT", "47321"))
ORIGINS = {o.strip() for o in os.environ.get("NOTES_HELPER_ORIGINS", "https://carrots-bank.github.io").split(",") if o.strip()}
LOCAL = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$")
MAX_BODY = 4 * 1024 * 1024
HOME = os.path.expanduser("~")
EXTRA_PATH = [f"{HOME}/.local/bin", f"{HOME}/.claude/local", "/opt/homebrew/bin", "/usr/local/bin",
              f"{HOME}/.npm-global/bin", f"{HOME}/.bun/bin", f"{HOME}/.volta/bin"]
SEARCH_PATH = os.pathsep.join([os.environ.get("PATH", "")] + EXTRA_PATH)
BUSY = threading.Semaphore(2)
WORKERS = {w.strip().rstrip("/") for w in os.environ.get("NOTES_HELPER_WORKERS", "").split(",") if w.strip()}
CONFIG = os.environ.get("NOTES_HELPER_CONFIG") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay.json")
CONFIG_LOCK = threading.Lock()
POLL_SECONDS = 3  # how often the Mac checks its relay mailbox


# ---------- end-to-end encryption for relayed jobs ----------
def _subkeys(key):
    return hmac.new(key, b"enc", hashlib.sha256).digest(), hmac.new(key, b"mac", hashlib.sha256).digest()


def _stream(kenc, nonce, n):
    blocks = (n + 31) // 32
    return b"".join(hmac.new(kenc, nonce + i.to_bytes(4, "big"), hashlib.sha256).digest() for i in range(blocks))[:n]


def _xor(a, b):
    return (int.from_bytes(a, "big") ^ int.from_bytes(b, "big")).to_bytes(len(a), "big") if a else b""


def seal(key, text):
    kenc, kmac = _subkeys(key)
    nonce, pt = os.urandom(16), text.encode()
    ct = _xor(pt, _stream(kenc, nonce, len(pt)))
    tag = hmac.new(kmac, nonce + ct, hashlib.sha256).digest()
    return base64.b64encode(nonce + ct + tag).decode()


def unseal(key, data):
    raw = base64.b64decode(data)
    nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
    kenc, kmac = _subkeys(key)
    if not hmac.compare_digest(tag, hmac.new(kmac, nonce + ct, hashlib.sha256).digest()):
        raise ValueError("bad tag")
    return _xor(ct, _stream(kenc, nonce, len(ct))).decode()


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    with CONFIG_LOCK:
        tmp = CONFIG + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cfg, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONFIG)


def engines():
    found = {}
    for name in ("claude", "codex"):
        path = shutil.which(name, path=SEARCH_PATH)
        if path:
            found[name] = path
    return found


def child_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDECODE", "CLAUDE_CODE_"))}
    env["PATH"] = SEARCH_PATH
    return env


def run_claude(path, system, prompt, model):
    """Yield text chunks from Claude Code in print mode, with all tools switched off."""
    cmd = [path, "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
           "--tools", "", "--system-prompt", system, "--no-session-persistence", "--strict-mcp-config"]
    if model:
        cmd += ["--model", model]
    with tempfile.TemporaryDirectory() as cwd:
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd=cwd, env=child_env(), text=True, bufsize=1)
        try:
            p.stdin.write(prompt)
            p.stdin.close()
            streamed = False
            for line in p.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "stream_event":
                    e = ev.get("event", {})
                    d = e.get("delta", {})
                    if e.get("type") == "content_block_delta" and d.get("type") == "text_delta":
                        streamed = True
                        yield d.get("text", "")
                elif ev.get("type") == "result":
                    if ev.get("is_error"):
                        raise RuntimeError(ev.get("result") or "Claude returned an error")
                    if not streamed:
                        yield ev.get("result", "")
            p.wait(timeout=30)
            if p.returncode:
                raise RuntimeError(_explain(p.stderr.read()))
        finally:
            if p.poll() is None:
                p.kill()


def run_codex(path, system, prompt, model):
    """Codex (ChatGPT subscription) in exec mode, read-only, nothing saved; yields each finished message."""
    with tempfile.TemporaryDirectory() as cwd:
        out = os.path.join(cwd, "answer.md")
        cmd = [path, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--color", "never",
               "--json", "-o", out]
        if model:
            cmd += ["--model", model]
        p = subprocess.Popen(cmd + ["-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd=cwd, env=child_env(), text=True, bufsize=1)
        try:
            p.stdin.write(f"{system}\n\n{prompt}")
            p.stdin.close()
            said, error = False, ""
            for line in p.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                item = ev.get("item") or {}
                if ev.get("type") == "item.completed" and item.get("type") == "agent_message" and item.get("text"):
                    yield ("\n\n" if said else "") + item["text"]
                    said = True
                elif ev.get("type") in ("error", "turn.failed"):
                    error = str(ev.get("message") or (ev.get("error") or {}).get("message") or "Codex reported an error")
            p.wait(timeout=60)
            if not said and os.path.exists(out):
                with open(out) as f:
                    text = f.read().strip()
                if text:
                    said = True
                    yield text
            if not said:
                raise RuntimeError(_explain(error or p.stderr.read()))
        finally:
            if p.poll() is None:
                p.kill()


def _explain(err):
    err = (err or "").strip()
    if re.search(r"log ?in|auth|credential|401", err, re.I):
        return "Not logged in: open Terminal, run `claude` (or `codex login`) once and sign in, then try again."
    return err[-600:] or "The AI tool stopped unexpectedly."


class Handler(BaseHTTPRequestHandler):
    server_version = "NotesHelper/" + VERSION

    def log_message(self, *a):  # keep nothing
        pass

    def _origin_ok(self):
        o = self.headers.get("Origin", "")
        return o in ORIGINS or bool(LOCAL.match(o)), o

    def _cors(self, origin):
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")

    def _json(self, code, obj, origin=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        if origin:
            self._cors(origin)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        ok, origin = self._origin_ok()
        self.send_response(204 if ok else 403)
        if ok:
            self._cors(origin)
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        ok, origin = self._origin_ok()
        if self.path.split("?")[0] == "/connect":  # opened as a page (Safari can't call the helper from the site)
            body = CONNECT_PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)
        if self.path == "/relay/config" and ok:
            cfg = load_config()
            return self._json(200, {"configured": bool(cfg.get("mailbox")), "mailbox": cfg.get("mailbox"),
                                    "devices": len(cfg.get("devices", {})), "worker": cfg.get("worker")}, origin)
        if self.path != "/status":
            return self._json(404, {"error": "not found"}, origin if ok else None)
        if not ok:
            return self._json(403, {"error": "this helper only answers the notes website"})
        self._json(200, {"ok": True, "version": VERSION, "engines": sorted(engines())}, origin)

    def do_POST(self):
        ok, origin = self._origin_ok()
        if not ok:
            return self._json(403, {"error": "this helper only answers the notes website"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "request too large"}, origin)
        if self.path.startswith("/relay/"):
            return self._relay_setup(origin, self.rfile.read(n))
        if self.path != "/ask":
            return self._json(404, {"error": "not found"}, origin)
        try:
            req = json.loads(self.rfile.read(n))
            system, prompt = str(req["system"]), str(req["prompt"])
        except (ValueError, KeyError):
            return self._json(400, {"error": "bad request"}, origin)
        found = engines()
        name = req.get("engine") if req.get("engine") in found else next(iter(found), None)
        if not name:
            return self._json(503, {"error": "No AI tool found on this computer. Install Claude Code (or Codex) first."}, origin)
        if not BUSY.acquire(blocking=False):
            return self._json(429, {"error": "The helper is already answering two questions; try again in a moment."}, origin)
        try:
            self.send_response(200)
            self._cors(origin)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            send = lambda obj: (self.wfile.write((json.dumps(obj) + "\n").encode()), self.wfile.flush())
            send({"engine": name})
            run = run_claude if name == "claude" else run_codex
            try:
                for chunk in run(found[name], system, prompt, str(req.get("model") or "")):
                    if chunk:
                        send({"t": chunk})
                send({"done": True})
            except (BrokenPipeError, ConnectionResetError):
                pass  # the page went away; the generator's cleanup stops the AI tool
            except Exception as e:  # noqa: BLE001 - report any failure to the page
                try:
                    send({"error": str(e)})
                except OSError:
                    pass
        finally:
            BUSY.release()


    def _relay_setup(self, origin, raw):
        try:
            req = json.loads(raw or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad request"}, origin)
        cfg = load_config()
        if self.path == "/relay/connect":  # this person's mailbox (+ optionally one newly paired device)
            worker = str(req.get("worker", "")).rstrip("/")
            local_worker = re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", worker)
            if not (worker in WORKERS or (local_worker and not WORKERS)):
                return self._json(403, {"error": "this helper only connects to its own notes site"}, origin)
            if not (re.fullmatch(r"[0-9a-f]{32}", str(req.get("mailbox"))) and re.fullmatch(r"[0-9a-f]{64}", str(req.get("mac")))):
                return self._json(400, {"error": "bad request"}, origin)
            same = cfg.get("mailbox") == req["mailbox"] and cfg.get("worker") == worker
            cfg = {"worker": worker, "mailbox": req["mailbox"], "mac": req["mac"], "devices": cfg.get("devices", {}) if same else {}}
            if req.get("device"):
                if not (re.fullmatch(r"[0-9a-f]{64}", str(req.get("device"))) and re.fullmatch(r"[0-9a-f]{64}", str(req.get("key")))):
                    return self._json(400, {"error": "bad request"}, origin)
                cfg["devices"][req["device"]] = req["key"]
        elif self.path == "/relay/unpair-all":
            cfg["devices"] = {}
        else:
            return self._json(404, {"error": "not found"}, origin)
        save_config(cfg)
        return self._json(200, {"ok": True}, origin)


CONNECT_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect the donkey</title>
<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#1d1d1f;background:#f7f6f3}
@media(prefers-color-scheme:dark){body{color:#e8e6e3;background:#151618}}
button{font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#2f5bd3;color:#fff;cursor:pointer}
.muted{opacity:.7;font-size:14px}</style></head><body>
<h1>🫏 Connect the donkey</h1>
<p id="what">Checking…</p>
<p><button id="go" hidden>Connect</button></p>
<p id="msg" class="muted"></p>
<script>
const msg = document.getElementById("msg"), go = document.getElementById("go"), what = document.getElementById("what");
let req = null;
try { req = JSON.parse(atob(location.hash.slice(1).replace(/-/g, "+").replace(/_/g, "/"))); } catch {}
history.replaceState(null, "", location.pathname);
if (!req || !req.worker) { what.textContent = "This link is incomplete. Go back to the notes and try again."; }
else {
  what.innerHTML = "Let your notes (<b>" + new URL(req.site || req.worker).host + "</b>) send 🫏 questions to this Mac's helper, answered with this Mac's AI account" + (req.device ? ", including from the browser or device you are pairing now." : ".");
  go.hidden = false;
}
go.onclick = async () => {
  go.disabled = true;
  const r = await fetch("/relay/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { what.textContent = "✓ Connected. You can close this tab and go back to the notes."; go.hidden = true; msg.textContent = ""; }
  else { msg.textContent = "Couldn't connect: " + (j.error || r.status); go.disabled = false; }
};
</script></body></html>"""


# ---------- relay loop: answer jobs from paired devices ----------
def _call(cfg, method, path, body=None, timeout=35):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(cfg["worker"] + "/v1/relay/" + path, data=data, method=method,
                                 headers={"authorization": "Bearer " + cfg["mac"], "content-type": "application/json",
                                          "user-agent": "NotesHelper/" + VERSION})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def answer_job(cfg, job):
    key = cfg.get("devices", {}).get(job["device"])
    post = lambda body: _call(cfg, "POST", f"job/{job['id']}/out", body, timeout=20)
    if not key:
        return post({"error": True, "chunk": ""})
    key = bytes.fromhex(key)
    try:
        req = json.loads(unseal(key, job["data"]))
        found = engines()
        name = req.get("engine") if req.get("engine") in found else next(iter(found), None)
        if not name:
            raise RuntimeError("No AI tool found on the Mac.")
        post({"chunk": seal(key, json.dumps({"engine": name}))})
        run = run_claude if name == "claude" else run_codex
        buf, last = "", time.time()
        for chunk in run(found[name], str(req["system"]), str(req["prompt"]), str(req.get("model") or "")):
            buf += chunk
            if buf and (time.time() - last > 0.7 or len(buf) > 600):
                post({"chunk": seal(key, json.dumps({"t": buf}))})
                buf, last = "", time.time()
        if buf:
            post({"chunk": seal(key, json.dumps({"t": buf}))})
        post({"done": True})
    except Exception as e:  # noqa: BLE001 - tell the device what went wrong
        try:
            post({"error": True, "chunk": seal(key, json.dumps({"error": str(e)}))})
        except Exception:  # noqa: BLE001
            pass


def relay_loop():
    while True:
        cfg = load_config()
        if not cfg.get("mailbox"):
            time.sleep(5)
            continue
        try:
            job = _call(cfg, "GET", "next?mailbox=" + cfg["mailbox"], timeout=15)
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(10)  # offline or asleep: try again later
            continue
        if not job:
            time.sleep(POLL_SECONDS)
            continue
        if BUSY.acquire(timeout=60):
            def work(j=job):
                try:
                    answer_job(cfg, j)
                finally:
                    BUSY.release()
            threading.Thread(target=work, daemon=True).start()


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    found = engines()
    print(f"Notes helper {VERSION} on http://127.0.0.1:{PORT} · AI tools: {', '.join(found) or 'none found'}", flush=True)
    threading.Thread(target=relay_loop, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
