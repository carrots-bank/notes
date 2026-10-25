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

VERSION = "5"
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
HELPER_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_PY = os.path.join(HELPER_DIR, "venv", "bin", "python")
MAKER = os.path.join(HELPER_DIR, "notes-maker.py")
JOBS_DIR = os.path.join(tempfile.gettempdir(), "notes-maker-jobs")
JOBS = {}  # id -> {state, steps, error, note, words}
SELF_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
MAX_UPLOAD = 8 * 1024 ** 3


def maker_ready():
    return os.path.exists(VENV_PY) and os.path.exists(MAKER)


def run_maker_job(jid):
    job, d = JOBS[jid], os.path.join(JOBS_DIR, jid)
    job["state"] = "running"
    try:
        p = subprocess.Popen([VENV_PY, MAKER, d], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env=child_env(), cwd=d)
        for line in p.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("step"):
                job["steps"].append(ev["step"])
            if ev.get("error"):
                job["error"] = ev["error"]
            if ev.get("done"):
                job["note"], job["words"] = ev["id"], ev.get("words")
        p.wait()
        if not job.get("note") and not job.get("error"):
            job["error"] = (p.stderr.read() or "The note maker stopped unexpectedly.")[-600:]
    except Exception as e:  # noqa: BLE001
        job["error"] = str(e)
    job["state"] = "done" if job.get("note") else "failed"
    shutil.rmtree(d, ignore_errors=True)  # recordings and files never stay on disk
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

    def _page(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- note maker (pages and calls from the helper's own /maker page only) ----------
    def _maker(self, method):
        path = self.path.split("?")[0]
        if method == "GET" and path == "/maker":
            return self._page(MAKER_PAGE)
        if method == "GET" and path == "/maker/status":
            return self._json(200, {"ready": maker_ready(), "engines": sorted(engines()), "version": VERSION})
        m = re.fullmatch(r"/maker/job/([0-9a-f]{32})", path)
        if method == "GET" and m:
            job = JOBS.get(m.group(1))
            return self._json(200, job) if job else self._json(404, {"error": "not found"})
        if self.headers.get("Origin", "") not in SELF_ORIGINS:
            return self._json(403, {"error": "forbidden"})
        if method == "POST" and path == "/maker/job":
            n = int(self.headers.get("Content-Length") or 0)
            try:
                req = json.loads(self.rfile.read(min(n, MAX_BODY)))
            except ValueError:
                return self._json(400, {"error": "bad request"})
            worker = str(req.get("worker", "")).rstrip("/")
            if not (worker in WORKERS or (not WORKERS and re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", worker))):
                return self._json(403, {"error": "this helper only works with its own notes site"})
            if not re.fullmatch(r"[0-9a-f]{64}", str(req.get("secret", ""))):
                return self._json(400, {"error": "bad request"})
            found = engines()
            engine = req.get("engine") if req.get("engine") in found else next(iter(found), None)
            if not engine:
                return self._json(503, {"error": "No AI tool found: install Claude Code (or Codex) and sign in."})
            if not maker_ready():
                return self._json(503, {"error": "Note-making isn't installed on this laptop yet."})
            jid = os.urandom(16).hex()
            d = os.path.join(JOBS_DIR, jid)
            os.makedirs(os.path.join(d, "files"))
            job = {k: str(req.get(k, ""))[:600] for k in ("secret", "worker", "uni", "branch", "topic", "title", "date", "site",
                                                          "mode", "company", "kind", "view", "focus")}
            job["test"] = bool(req.get("test"))
            skills = req.get("skills") or {}
            if job["mode"] == "pitch":  # Finance Town: the skill text comes from the person's (decrypted) site, never from disk
                if not isinstance(skills, dict) or not skills or sum(len(str(v)) for v in skills.values()) > 400_000:
                    return self._json(400, {"error": "Julian's skills didn't arrive. Start again from Finance Town."})
                os.makedirs(os.path.join(d, "skills"))
                for name, text in skills.items():
                    if re.fullmatch(r"[a-z0-9-]{1,60}\.md", str(name)):
                        with open(os.path.join(d, "skills", name), "w") as f:
                            f.write(str(text))
            job.update(engine=engine, engine_path=found[engine], model="opus" if engine == "claude" else "")
            with open(os.path.join(d, "job.json"), "w") as f:
                json.dump(job, f)
            os.chmod(os.path.join(d, "job.json"), 0o600)
            JOBS[jid] = {"state": "uploading", "steps": [], "error": None, "note": None, "engine": engine}
            return self._json(200, {"id": jid})
        m = re.fullmatch(r"/maker/job/([0-9a-f]{32})/(file|start)", path)
        if not m or m.group(1) not in JOBS or JOBS[m.group(1)]["state"] != "uploading":
            return self._json(404, {"error": "not found"})
        d = os.path.join(JOBS_DIR, m.group(1))
        if method == "PUT" and m.group(2) == "file":
            from urllib.parse import parse_qs, urlparse
            name = os.path.basename(parse_qs(urlparse(self.path).query).get("name", ["file"])[0])[:120] or "file"
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_UPLOAD:
                return self._json(413, {"error": "file too large"})
            with open(os.path.join(d, "files", name), "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            return self._json(200, {"ok": True})
        if method == "POST" and m.group(2) == "start":
            threading.Thread(target=run_maker_job, args=(m.group(1),), daemon=True).start()
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "not found"})

    def do_PUT(self):
        if self.path.startswith("/maker/"):
            return self._maker("PUT")
        self._json(405, {"error": "method not allowed"})

    def do_GET(self):
        if self.path.startswith("/maker"):
            return self._maker("GET")
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
        self._json(200, {"ok": True, "version": VERSION, "engines": sorted(engines()), "maker": maker_ready()}, origin)

    def do_POST(self):
        if self.path.startswith("/maker/"):
            return self._maker("POST")
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


MAKER_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Make notes</title>
<style>
:root{--bg:#f7f6f3;--s:#fff;--t:#1d1d1f;--m:#6b6b70;--b:#e3e1dc;--a:#2f5bd3;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#151618;--s:#1d1f22;--t:#e8e6e3;--m:#9a9aa0;--b:#2e3034;--a:#7aa2ff}}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--t);margin:0;padding:24px 16px}
main{max-width:620px;margin:0 auto;background:var(--s);border:1px solid var(--b);border-radius:14px;padding:24px}
h1{margin:0 0 4px;font-size:24px}.m{color:var(--m);font-size:14px}
label{display:grid;gap:4px;font-weight:600;margin:12px 0}
input,select{font:15px inherit;padding:9px 10px;border-radius:8px;border:1px solid var(--b);background:var(--bg);color:var(--t);font-weight:400}
.drop{border:2px dashed var(--b);border-radius:12px;padding:14px;margin:12px 0}
.drop strong{display:block;margin-bottom:4px}
button{font:600 15px inherit;padding:11px 18px;border-radius:10px;border:0;background:var(--a);color:#fff;cursor:pointer;margin-top:8px}
button:disabled{opacity:.5}
ol{padding-left:20px}li.now{font-weight:600}.err{color:var(--bad)}
progress{width:100%}
</style></head><body><main>
<h1>Make notes</h1>
<p class="m">Runs on this laptop with <span id="eng">your AI account</span>. Files stay here; only the finished notes and slide images are saved, encrypted, to your space.</p>
<div id="form">
<label>Branch <input id="branch"></label>
<label>Topic <input id="topic"></label>
<label>Title <input id="title"></label>
<label>Date <input id="date" type="date"></label>
<label id="engwrap" hidden>Written by <select id="engine"></select></label>
<div class="drop"><strong>Recording</strong><span class="m">Audio or video of the lecture (optional if you have slides).</span><br>
<input id="rec" type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.mp4,.mov"></div>
<div class="drop"><strong>Slides and documents</strong><span class="m">PDF, PowerPoint, Word, text or images (optional if you have a recording).</span><br>
<input id="docs" type="file" multiple accept=".pdf,.pptx,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"></div>
<button id="go">Make notes</button>
<p id="msg" class="m"></p>
</div>
<div id="run" hidden><progress id="bar"></progress><ol id="steps"></ol><p id="end"></p></div>
</main><script>
const $ = id => document.getElementById(id);
let P = null;
try { P = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1).replace(/-/g, "+").replace(/_/g, "/"))))); } catch {}
history.replaceState(null, "", location.pathname);
if (!P || !P.secret) { $("form").innerHTML = "<p>Open this page from the notes website: My space &rarr; <strong>New notes</strong>.</p>"; }
else { for (const k of ["branch", "topic", "title", "date"]) $(k).value = P[k] || ""; }
const PITCH = P && P.mode === "pitch";
if (PITCH) {  // Finance Town: Julian's stock-pitch skill
  document.querySelector("h1").textContent = "Company pitch";
  for (const id of ["branch", "topic", "title", "date"]) $(id).closest("label").hidden = true;
  $("rec").closest(".drop").hidden = true;
  const d = $("docs").closest(".drop");
  d.querySelector("strong").textContent = "Filings and documents (optional)";
  d.querySelector(".m").textContent = "Annual reports, 10-K/20-F, transcripts, broker notes, investor decks. Otherwise the research uses public sources.";
  d.insertAdjacentHTML("beforebegin", `<p><strong>${(P.company || "").replace(/</g, "&lt;")}</strong> · ${{ quick: "Non-financial (quick pitch)", fig: "Financial (FIG pitch)" }[P.kind] || "Type chosen automatically"} · ${{ long: "Long view", short: "Short view" }[P.view] || "No prior view"}${P.focus ? " · Focus: " + P.focus.replace(/</g, "&lt;") : ""}</p>`);
  $("go").textContent = "Prepare the pitch";
}
function getSkills() {  // from the notes tab that opened this page (it holds the decrypted skills)
  return new Promise((ok, bad) => {
    if (!window.opener) return bad(new Error("open this page from Finance Town in the notes website, and keep that tab open"));
    const origin = new URL(P.site).origin, t = setTimeout(() => bad(new Error("the notes tab didn't answer: keep it open and try again")), 15000);
    addEventListener("message", e => { if (e.origin === origin && e.data && e.data.type === "notes-maker:skills") { clearTimeout(t); ok(e.data.skills); } });
    window.opener.postMessage({ type: "notes-maker:need-skills" }, origin);
  });
}
fetch("/maker/status").then(r => r.json()).then(s => {
  const names = { claude: "Claude", codex: "ChatGPT" };
  if (!s.ready) { $("msg").innerHTML = "<span class=err>Note-making isn't installed on this laptop yet.</span> In Terminal run the install command shown on the New notes page (it ends with <code>--maker</code>)."; $("go").disabled = true; }
  if (!s.engines.length) { $("msg").innerHTML = "<span class=err>No AI tool found.</span> Install Claude Code (<code>curl -fsSL https://claude.ai/install.sh | bash</code>, then run <code>claude</code> once) or Codex."; $("go").disabled = true; }
  $("engine").innerHTML = s.engines.map(e => `<option value="${e}">your ${names[e]}</option>`).join("");
  $("engwrap").hidden = s.engines.length < 2;
  $("eng").textContent = "your " + (s.engines.map(e => names[e]).join(" or ") || "AI account");
});
function put(id, file) {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("PUT", `/maker/job/${id}/file?name=${encodeURIComponent(file.name)}`);
    x.upload.onprogress = e => { if (e.lengthComputable) { $("bar").max = e.total; $("bar").value = e.loaded; } };
    x.onload = () => x.status === 200 ? ok() : bad(new Error("upload failed"));
    x.onerror = () => bad(new Error("upload failed"));
    x.send(file);
  });
}
$("go").onclick = async () => {
  const files = [...$("rec").files, ...$("docs").files];
  if (!PITCH && !files.length) return $("msg").textContent = "Add a recording, slides or a document first.";
  if (!PITCH && !$("title").value.trim()) return $("msg").textContent = "Give the notes a title.";
  $("go").disabled = true; $("msg").textContent = "Starting…";
  try {
    const job = { ...P, branch: $("branch").value, topic: $("topic").value, title: $("title").value, date: $("date").value, engine: $("engine").value };
    if (PITCH) job.skills = await getSkills();
    const r = await fetch("/maker/job", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $("form").hidden = true; $("run").hidden = false;
    for (const f of files) { $("steps").innerHTML = `<li class=now>Copying ${f.name}…</li>`; await put(j.id, f); }
    $("bar").removeAttribute("value"); $("bar").removeAttribute("max");
    await fetch(`/maker/job/${j.id}/start`, { method: "POST" });
    const tick = async () => {
      const s = await (await fetch(`/maker/job/${j.id}`)).json();
      $("steps").innerHTML = s.steps.map((t, i) => `<li class="${i === s.steps.length - 1 && s.state === "running" ? "now" : ""}">${t.replace(/</g, "&lt;")}</li>`).join("");
      if (s.state === "done") { $("bar").max = 1; $("bar").value = 1; $("end").innerHTML = `Done: about ${s.words} words. <a href="${P.site}#/space/${s.note}">Open ${PITCH ? "the pitch" : "your notes"}</a>`; return; }
      if (s.state === "failed") { $("bar").hidden = true; $("end").innerHTML = `<span class=err>Couldn't make the notes: ${(s.error || "").replace(/</g, "&lt;")}</span>`; return; }
      setTimeout(tick, 2500);
    };
    tick();
  } catch (e) { $("msg").textContent = "Couldn't start: " + e.message; $("go").disabled = false; }
};
</script></body></html>"""


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
