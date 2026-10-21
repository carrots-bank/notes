#!/usr/bin/env python3
"""Notes helper: lets the notes website ask the 🫏 assistant through the AI account on *this* computer.

It listens on 127.0.0.1 only, accepts requests only from the notes website, and passes each question (with the
lecture's slides, transcript and notes, assembled by the website) to the locally installed Claude Code (your Claude
subscription) or Codex (your ChatGPT subscription). Answers stream back to the page. Nothing is stored or logged.
Install/uninstall with install.sh / uninstall.sh next to this file. Needs only the Python that ships with macOS.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1"
PORT = int(os.environ.get("NOTES_HELPER_PORT", "47321"))
ORIGINS = {o.strip() for o in os.environ.get("NOTES_HELPER_ORIGINS", "https://carrots-bank.github.io").split(",") if o.strip()}
LOCAL = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$")
MAX_BODY = 4 * 1024 * 1024
HOME = os.path.expanduser("~")
EXTRA_PATH = [f"{HOME}/.local/bin", f"{HOME}/.claude/local", "/opt/homebrew/bin", "/usr/local/bin",
              f"{HOME}/.npm-global/bin", f"{HOME}/.bun/bin", f"{HOME}/.volta/bin"]
SEARCH_PATH = os.pathsep.join([os.environ.get("PATH", "")] + EXTRA_PATH)
BUSY = threading.Semaphore(2)


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
    """Codex (ChatGPT) has no token stream in exec mode: yield the final message once."""
    with tempfile.TemporaryDirectory() as cwd:
        out = os.path.join(cwd, "answer.md")
        cmd = [path, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", out]
        if model:
            cmd += ["--model", model]
        p = subprocess.run(cmd + ["-"], input=f"{system}\n\n{prompt}", capture_output=True, text=True,
                           cwd=cwd, env=child_env(), timeout=600)
        if p.returncode or not os.path.exists(out):
            raise RuntimeError(_explain(p.stderr or p.stdout))
        with open(out) as f:
            yield f.read()


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
        if self.path != "/status":
            return self._json(404, {"error": "not found"}, origin if ok else None)
        if not ok:
            return self._json(403, {"error": "this helper only answers the notes website"})
        self._json(200, {"ok": True, "version": VERSION, "engines": sorted(engines())}, origin)

    def do_POST(self):
        ok, origin = self._origin_ok()
        if not ok:
            return self._json(403, {"error": "this helper only answers the notes website"})
        if self.path != "/ask":
            return self._json(404, {"error": "not found"}, origin)
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "request too large"}, origin)
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


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    found = engines()
    print(f"Notes helper {VERSION} on http://127.0.0.1:{PORT} · AI tools: {', '.join(found) or 'none found'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
