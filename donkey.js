// 🫏 The study assistant. Questions go to the helper on this computer (helper/notes-helper.py), which passes them to
// the person's own Claude Code or Codex login, so answers come from their own subscription and never through anyone
// else's account. Every question carries the lecture's slide text, transcript and the person's notes, so answers stay
// grounded in the lecture. Without a helper, the same package can be copied into claude.ai or chatgpt.com.
// A phone/iPad paired with a Mac (QR code from the Mac's panel) sends its questions to that Mac through an encrypted
// mailbox on the notes' Cloudflare worker; only the device and the Mac hold the key (format mirrored in the helper).
(() => {
  const HELPER = "http://127.0.0.1:47321";
  const SITE = location.origin + location.pathname.replace(/[^/]*$/, "");
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = s => DOMPurify.sanitize(marked.parse(s || ""));
  const A = () => window.Annotate?.api;
  const pref = { get: () => { try { return localStorage.getItem("donkey_engine") || "auto"; } catch { return "auto"; } },
                 set: v => { try { localStorage.setItem("donkey_engine", v); } catch {} } };

  // ---------- relay: pairing and end-to-end encryption (HMAC-SHA256 counter mode + HMAC tag) ----------
  const te = s => new TextEncoder().encode(s);
  const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const fromHex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
  const rnd = n => crypto.getRandomValues(new Uint8Array(n));
  function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hkey = raw => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sign = async (k, data) => new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
  async function subkeys(keyHex) { const k = await hkey(fromHex(keyHex)); return [await hkey(await sign(k, te("enc"))), await hkey(await sign(k, te("mac")))]; }
  async function stream(kenc, nonce, n) {
    const parts = [];
    for (let i = 0; i < Math.ceil(n / 32); i++) {
      const blk = new Uint8Array(20); blk.set(nonce); new DataView(blk.buffer).setUint32(16, i);
      parts.push(sign(kenc, blk));
    }
    const out = new Uint8Array(parts.length * 32);
    (await Promise.all(parts)).forEach((p, i) => out.set(p, i * 32));
    return out.subarray(0, n);
  }
  async function seal(keyHex, text) {
    const [kenc, kmac] = await subkeys(keyHex), nonce = rnd(16), pt = te(text), ks = await stream(kenc, nonce, pt.length);
    const body = new Uint8Array(16 + pt.length); body.set(nonce);
    for (let i = 0; i < pt.length; i++) body[16 + i] = pt[i] ^ ks[i];
    const tag = await sign(kmac, body), all = new Uint8Array(body.length + 32);
    all.set(body); all.set(tag, body.length);
    return b64(all);
  }
  async function unseal(keyHex, data) {
    const raw = unb64(data), body = raw.subarray(0, raw.length - 32), tag = raw.subarray(raw.length - 32);
    const [kenc, kmac] = await subkeys(keyHex), want = await sign(kmac, body);
    if (want.length !== tag.length || want.some((x, i) => x !== tag[i])) throw new Error("bad tag");
    const nonce = body.subarray(0, 16), ct = body.subarray(16), ks = await stream(kenc, nonce, ct.length);
    return new TextDecoder().decode(ct.map((x, i) => x ^ ks[i]));
  }
  const sha256hex = async s => toHex(await crypto.subtle.digest("SHA-256", te(s)));
  const paired = { get: () => { try { return JSON.parse(localStorage.getItem("donkey_relay")); } catch { return null; } },
                   set: v => { try { v ? localStorage.setItem("donkey_relay", JSON.stringify(v)) : localStorage.removeItem("donkey_relay"); } catch {} } };
  let justPaired = false;
  if (location.hash.startsWith("#pair=")) {  // opened from the QR code shown on the Mac
    try {
      const p = JSON.parse(atob(location.hash.slice(6).replace(/-/g, "+").replace(/_/g, "/")));
      if (/^[0-9a-f]{64}$/.test(p.t) && /^[0-9a-f]{64}$/.test(p.k)) { paired.set({ t: p.t, k: p.k }); justPaired = true; }
    } catch {}
    history.replaceState(null, "", location.pathname);
  }
  let relayState = null;  // {seen, now} from the worker

  const SYSTEM = `You are the study assistant (a friendly donkey 🫏) inside a university student's lecture-notes app.
You are given one lecture's materials: the text of every slide, the transcript of the lecture recording (machine
transcription, so names and terms may be misheard: trust the spelling on the slides), and the student's notes (their
current version, which may include their own edits).
Rules:
1. Base the answer on these materials first. Point to where things come from: "slide 12", "[34:10]" in the transcript,
   or the notes section.
2. If the materials don't cover something, say so plainly, then give the standard textbook answer, clearly labelled as
   going beyond the lecture. Never invent what the lecturer said.
3. Explain clearly for a university student, using the course's terminology; give a concrete example when it helps.
4. Write Markdown. Be focused: short paragraphs, lists where useful, no preamble and no closing offers.
5. If asked to write or rewrite text for the notes, write it in the notes' own style, ready to paste in.
6. Reply in the language of the question.`;

  const fab = document.createElement("button");
  fab.className = "donkey-fab";
  fab.title = "Ask the donkey";
  fab.textContent = "🫏";
  fab.hidden = true;
  const panel = document.createElement("aside");
  panel.className = "donkey annot-ui";
  panel.hidden = true;
  panel.innerHTML = `
    <header class="donkey-head"><strong>🫏 Ask the donkey</strong><span class="donkey-engine muted"></span>
      <button class="icon" data-d="close" aria-label="Close">✕</button></header>
    <div class="donkey-about"></div>
    <div class="donkey-log"></div>
    <form class="donkey-form">
      <textarea rows="3" placeholder="Ask about this lecture, or ask me to add to your notes… (Enter to send)"></textarea>
      <div class="donkey-row"><button class="btn primary" type="submit">Ask</button>
        <button class="btn ghost" type="button" data-d="stop" hidden>Stop</button><span class="spacer"></span>
        <button class="btn ghost" type="button" data-d="clear" title="Start a new conversation">New</button></div>
    </form>`;
  document.addEventListener("DOMContentLoaded", () => document.body.append(fab, panel));

  const $ = s => panel.querySelector(s);
  let about = null;        // {quote, key} the conversation is about
  const chats = {};        // path -> [{role, text, about}]
  let helper = null, helperChecked = 0, abort = null;

  async function checkHelper(force = false) {
    if (!force && Date.now() - helperChecked < 30000) return helper;
    helperChecked = Date.now();
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(HELPER + "/status", { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      helper = r.ok ? await r.json() : null;
    } catch { helper = null; }
    showEngine();
    return helper;
  }
  function chosenEngine() {
    const p = pref.get(), list = helper?.engines || [];
    return list.includes(p) ? p : list[0] || null;
  }
  const relayUrl = () => A()?.relayAuth().url;
  function mode() {
    if (helper && chosenEngine()) return "local";
    if (paired.get() && relayUrl()) return "relay";
    return "fallback";
  }
  async function relayCall(method, path, body) {
    const r = await fetch(relayUrl() + "/v1/relay/" + path, { method, cache: "no-store",
      headers: { authorization: "Bearer " + paired.get().t, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { paired.set(null); throw new Error("This device isn't paired any more. Pair it again from your Mac."); }
    if (!r.ok) throw new Error(j.error || "relay " + r.status);
    return j;
  }
  async function checkRelay() {
    if (mode() !== "relay") return;
    try { relayState = await relayCall("GET", "status"); } catch { relayState = null; }
    showEngine();
  }
  const macOnline = () => relayState && relayState.now - relayState.seen < 60000;
  function showEngine() {
    const el = $(".donkey-engine"), e = chosenEngine();
    if (mode() === "relay") {
      el.innerHTML = !relayState || !relayState.seen ? "· via your Mac" : macOnline() ? "· via your Mac (online)" : "· your Mac seems offline (is it on and awake?)";
      return;
    }
    if (!helper) { el.textContent = "· no helper on this device"; return; }
    if (!e) { el.textContent = "· helper found, no AI tool"; return; }
    const names = { claude: "your Claude", codex: "your ChatGPT" };
    el.innerHTML = helper.engines.length > 1
      ? `· <select data-d="engine">${helper.engines.map(x => `<option value="${x}"${x === e ? " selected" : ""}>${names[x]}</option>`).join("")}</select>`
      : `· via ${names[e]}`;
  }

  // ---------- lecture context ----------
  async function materials() {
    const api = A();
    const [slidesRaw, transcript] = await Promise.all([api.load("images.json"), api.load("transcript.txt")]);
    let slides = "";
    try {
      slides = JSON.parse(slidesRaw || "[]").map((s, i) =>
        `${s.label || "Slide " + (i + 1)}: ${(s.text || "").replace(/\s+/g, " ").trim()}`).join("\n");
    } catch {}
    return { title: api.title(), slides, transcript: (transcript || "").trim(), notes: api.notes() };
  }
  async function buildPrompt(question, ctx) {
    const m = await materials(), api = A();
    const parts = [`# Lecture: ${m.title}`];
    parts.push("## Slides (text of each slide)\n" + (m.slides || "(no slide text available)"));
    parts.push("## Transcript of the recording\n" + (m.transcript || "(no recording for this lecture: rely on the slides and notes)"));
    parts.push("## The student's notes\n" + m.notes);
    const history = (chats[api.path()] || []).slice(0, -1).filter(x => x.text);
    if (history.length) parts.push("## Conversation so far\n" + history.map(x => `${x.role === "user" ? "Student" : "You"}: ${x.text}`).join("\n\n"));
    const where = ctx?.key ? ` (in the section "${api.sectionHeading(ctx.key)}")` : "";
    if (ctx?.quote) parts.push(`## The passage the student selected${where}\n"${ctx.quote.exact}"`);
    else if (ctx?.key) parts.push(`## The student is reading the section "${api.sectionHeading(ctx.key)}"`);
    parts.push("## The student's question or request\n" + question);
    return parts.join("\n\n");
  }

  // ---------- panel ----------
  function open(ctx = {}) {
    const api = A();
    if (!api?.ready()) return;
    about = ctx.quote || ctx.key ? ctx : { key: api.sectionInView() };
    panel.hidden = false;
    document.body.classList.add("donkey-open");
    renderAbout();
    renderLog();
    checkHelper(true).then(() => { renderLog(); checkRelay(); });
    setTimeout(() => $("textarea").focus(), 50);
  }
  function close() { panel.hidden = true; document.body.classList.remove("donkey-open"); }
  function renderAbout() {
    const api = A(), q = about?.quote?.exact;
    $(".donkey-about").innerHTML = q
      ? `<div class="donkey-chip">About: “${escH(q.length > 160 ? q.slice(0, 160) + "…" : q)}” <button class="icon" data-d="unabout" title="Ask about the whole lecture">✕</button></div>`
      : about?.key ? `<div class="donkey-chip muted">Section: ${escH(api.sectionHeading(about.key))} · whole lecture as context</div>` : "";
  }
  function renderLog() {
    const log = $(".donkey-log"), list = chats[A()?.path()] || [];
    let html = list.map((m, i) => m.role === "user"
      ? `<div class="donkey-msg user">${escH(m.text)}</div>`
      : `<div class="donkey-msg ai${m.error ? " error" : ""}" data-i="${i}">${m.error ? escH(m.error) : md(m.text) || '<span class="muted">Thinking…</span>'}
          ${m.done && !m.error ? `<div class="donkey-actions">
            <button class="btn ghost" data-d="side">💬 Keep as side note</button>
            <button class="btn ghost" data-d="note">📝 Add as my note</button>
            <button class="btn ghost" data-d="weave">✍️ Add into the text</button>
            <button class="btn ghost" data-d="copy">Copy</button></div>` : ""}</div>`).join("");
    if (justPaired) html = `<div class="donkey-fallback"><strong>✓ This device is paired with your Mac.</strong> Questions you ask here are answered by your Mac (it needs to be on and awake).</div>` + html;
    if (mode() === "fallback") html += fallbackBox();
    if (mode() === "local" && helper && !list.length) html += `<p class="donkey-row"><button class="btn ghost" data-d="pair">📱 Use from phone or iPad</button></p>`;
    if (mode() === "relay" && !list.length) html += `<p class="muted donkey-hint">Answered by your Mac, through your own Claude. <button class="btn ghost" data-d="unpair-me">Unpair this device</button></p>`;
    if (!list.length && mode() !== "fallback") html += `<p class="muted donkey-hint">Ask anything about this lecture: “explain this more simply”, “give me an example”, “add a paragraph on …”, “make 3 exam questions on this section”. I read the slides, the transcript and your notes first.</p>`;
    log.innerHTML = html;
    log.scrollTop = log.scrollHeight;
  }
  function fallbackBox() {
    const desk = matchMedia("(pointer: fine)").matches;
    return `<div class="donkey-fallback">
      <p><strong>This device isn't connected to an AI yet.</strong> To get answers right here, connect it to the donkey helper on your Mac:</p>
      <div class="donkey-row">${desk ? `<button class="btn primary" data-d="connect-me">Connect this browser to my Mac</button>` : ""}
        <button class="btn ghost" data-d="setup">Set up the helper on a laptop</button></div>
      ${desk ? "" : `<p class="muted">On a phone or iPad: on your Mac, press 🫏 → <em>Use from phone or iPad</em> and scan the code (or open your personal pairing link here).</p>`}
      <details class="donkey-ext"><summary>Or ask in Claude / ChatGPT yourself (copy and paste)</summary>
        <p class="muted">Type your question below, then press a button: I copy it with this lecture's slides, transcript and your notes, and open the chat; just paste (⌘V) and send.</p>
        <div class="donkey-row"><a class="btn" data-d="ext" href="https://claude.ai/new" target="_blank" rel="noopener">Ask in Claude</a>
          <a class="btn" data-d="ext" href="https://chatgpt.com/" target="_blank" rel="noopener">Ask in ChatGPT</a></div>
        <details class="donkey-paste"><summary>Paste the answer here to save it</summary>
          <textarea rows="4" placeholder="Paste the answer from Claude or ChatGPT"></textarea>
          <button class="btn" data-d="pasted">Use this answer</button></details></details>
    </div>`;
  }
  function setupBox() {
    const cmd = `curl -fsSL ${SITE}helper/install.sh | bash`;
    $(".donkey-log").innerHTML = `<div class="donkey-setup">
      <h4>Set up the donkey on your Mac (once, about 5 minutes)</h4>
      <p>Answers then come from <em>your own</em> Claude or ChatGPT subscription, right here in the notes.</p>
      <ol>
        <li><strong>Install an AI tool and sign in once</strong> (in the Terminal app):
          <ul><li>Claude (Pro or Max plan): <code>curl -fsSL https://claude.ai/install.sh | bash</code>, then run <code>claude</code> and log in.</li>
              <li>or ChatGPT (Plus or Pro): <code>brew install codex</code>, then run <code>codex login</code>.</li></ul></li>
        <li><strong>Install the helper:</strong> <code>${escH(cmd)}</code> <button class="btn ghost" data-d="copycmd">Copy</button></li>
        <li><strong>Reload this page</strong> and press 🫏. If the browser asks to allow access to devices on your network, click <em>Allow</em> (that's the helper on your own laptop).</li>
      </ol>
      <p class="muted">The helper starts by itself when you log in, only answers this website, and stores nothing. To remove it: <code>curl -fsSL ${SITE}helper/uninstall.sh | bash</code></p>
      <button class="btn" data-d="back">Back</button></div>`;
  }

  async function ask(question) {
    const api = A(), path = api.path();
    const list = (chats[path] = chats[path] || []);
    const ctx = about ? { ...about } : {};
    list.push({ role: "user", text: question, about: ctx });
    const msg = { role: "ai", text: "", about: ctx, done: false };
    list.push(msg);
    renderLog();
    const engine = chosenEngine();
    $("[data-d=stop]").hidden = false;
    abort = new AbortController();
    if (mode() === "relay") return askRelay(question, ctx, msg);
    try {
      const r = await fetch(HELPER + "/ask", { method: "POST", signal: abort.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine, system: SYSTEM, prompt: await buildPrompt(question, ctx) }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `The helper answered ${r.status}`);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", last = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.t) msg.text += ev.t;
          if (ev.error) throw new Error(ev.error);
        }
        if (Date.now() - last > 120) { last = Date.now(); updateLast(msg); }
      }
      if (!msg.text) throw new Error("The AI returned an empty answer.");
    } catch (e) {
      if (e.name === "AbortError") { msg.text += msg.text ? "\n\n*(stopped)*" : "*(stopped)*"; }
      else { msg.error = "Couldn't get an answer: " + e.message; helperChecked = 0; }
    }
    msg.done = true;
    abort = null;
    $("[data-d=stop]").hidden = true;
    renderLog();
  }
  async function askRelay(question, ctx, msg) {
    const sig = abort.signal, key = paired.get().k;
    try {
      const data = await seal(key, JSON.stringify({ engine: pref.get() === "auto" ? "" : pref.get(), system: SYSTEM, prompt: await buildPrompt(question, ctx) }));
      const job = await relayCall("POST", "job", { data });
      let from = 0, started = Date.now(), picked = false;
      for (;;) {
        if (sig.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" });
        await new Promise(r => setTimeout(r, 800));
        const st = await relayCall("GET", `job/${job.id}?from=${from}`);
        for (const c of st.chunks) {
          const ev = JSON.parse(await unseal(key, c));
          if (ev.t) msg.text += ev.t;
          if (ev.error) throw new Error(ev.error);
        }
        from += st.chunks.length;
        if (st.status !== "new" && !picked) { picked = true; relayState = { seen: Date.now(), now: Date.now() }; showEngine(); }
        updateLast(msg);
        if (st.status === "done") break;
        if (st.status === "error") throw new Error("Your Mac couldn't answer. Try pairing this device again.");
        if (!picked && Date.now() - started > 45000) throw new Error("Your Mac didn't pick up the question. Is it switched on, awake and online?");
      }
      if (!msg.text) throw new Error("The AI returned an empty answer.");
    } catch (e) {
      if (e.name === "AbortError") msg.text += msg.text ? "\n\n*(stopped)*" : "*(stopped)*";
      else msg.error = "Couldn't get an answer: " + e.message;
    }
    msg.done = true;
    abort = null;
    $("[data-d=stop]").hidden = true;
    renderLog();
  }

  // Connect this person's mailbox to the helper on this Mac, and pair either a phone/iPad (QR code) or this browser
  // itself (for Safari, which can't call the helper directly). Chrome hands the details to the helper straight away;
  // otherwise a link opens the helper's own page, where one click finishes it.
  async function connect(thisDevice) {
    const log = $(".donkey-log");
    log.innerHTML = `<p class="muted">Preparing…</p>`;
    try {
      const { url, token } = A().relayAuth();
      if (!url || !token) throw new Error("Sync isn't switched on for this account.");
      const remote = (path, body) => fetch(url + "/v1/relay/" + path, { method: "POST", headers: { authorization: "Bearer " + token,
        "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.ok ? r.json() : Promise.reject(new Error("relay " + r.status)));
      const box = await remote("mailbox", {});
      const secret = toHex(rnd(32)), key = toHex(rnd(32)), device = await sha256hex(secret);
      await remote("device", { mailbox: box.mailbox, device, label: thisDevice ? "browser on the Mac" : "phone/iPad" });
      const payload = { site: SITE, worker: url, mailbox: box.mailbox, mac: box.mac, device, key };
      let direct = false;
      try {
        const r = await fetch(HELPER + "/relay/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        direct = r.ok;
      } catch {}
      const b64url = o => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const finish = direct ? "" : `<li><strong>Finish on this Mac:</strong> <a class="btn primary" href="${HELPER}/connect#${b64url(payload)}" target="_blank" rel="noopener">Open the helper</a>
          and click <em>Connect</em> on the page that opens (it's the helper on this Mac, so it only works here).</li>`;
      if (thisDevice) {
        paired.set({ t: secret, k: key });
        relayState = null;
        log.innerHTML = `<div class="donkey-setup"><h4>🔗 Connect this browser to the helper on this Mac</h4><ol>${finish}
          <li>Then come back here and ask: questions go to this Mac's helper through the encrypted relay (a few seconds slower than Chrome).</li></ol>
          ${direct ? "<p>✓ Connected.</p>" : ""}<button class="btn" data-d="back">Done</button></div>`;
        return;
      }
      const link = SITE + "#pair=" + b64url({ t: secret, k: key });
      let qr = "";
      if (window.qrcode) { const q = qrcode(0, "M"); q.addData(link); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
      log.innerHTML = `<div class="donkey-setup">
        <h4>📱 Pair a phone or iPad with this Mac</h4>
        <ol>${finish}<li>On the phone or iPad, scan this code with the camera (or send yourself the link and open it).</li>
            <li>Open it in the browser you use for the notes, and sign in there if asked.</li>
            <li>That's it: 🫏 on that device now asks this Mac, using your Claude. Keep the Mac on and awake.</li></ol>
        <div class="donkey-qr">${qr}</div>
        <p><button class="btn" data-d="copylink">Copy link</button> <span class="muted">This code pairs one device; make a new one for each.</span></p>
        <p class="muted">Pair only your own devices: whoever uses a paired device asks with your Claude account.</p>
        <p><button class="btn ghost" data-d="unpair-all">Unpair all devices</button> <button class="btn" data-d="back">Done</button></p></div>`;
      log.querySelector("[data-d=copylink]").dataset.link = link;
    } catch (e) {
      log.innerHTML = `<div class="donkey-msg ai error">Couldn't connect: ${escH(e.message)}</div><button class="btn" data-d="back">Back</button>`;
    }
  }
  async function unpairAll() {
    const { url, token } = A().relayAuth();
    const cfg = await fetch(HELPER + "/relay/config").then(r => r.json()).catch(() => ({}));
    if (cfg.mailbox) await fetch(url + "/v1/relay/unpair", { method: "POST", headers: { authorization: "Bearer " + token,
      "content-type": "application/json" }, body: JSON.stringify({ mailbox: cfg.mailbox }) }).catch(() => {});
    await fetch(HELPER + "/relay/unpair-all", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
    $(".donkey-log").innerHTML = `<div class="donkey-fallback">All phones and iPads are unpaired from this Mac.</div><button class="btn" data-d="back">Back</button>`;
  }

  function updateLast(msg) {
    const els = panel.querySelectorAll(".donkey-msg.ai");
    const el = els[els.length - 1];
    if (el) { el.innerHTML = md(msg.text); const log = $(".donkey-log"); log.scrollTop = log.scrollHeight; }
  }

  // Called from the "Ask in Claude/ChatGPT" links: the link itself opens the tab (browsers never block that), we only
  // copy the question with the lecture material, starting the copy inside the click so Safari allows it.
  function external(e) {
    const ta = $(".donkey-form textarea"), q = ta.value.trim();
    if (!q) { e.preventDefault(); ta.focus(); ta.placeholder = "Type your question first, then press the button"; return; }
    const api = A(), path = api.path(), list = (chats[path] = chats[path] || []);
    const text = buildPrompt(q, about).then(p => SYSTEM + "\n\n" + p);
    let copied = false;
    try {
      if (window.ClipboardItem && navigator.clipboard?.write)
        navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(t => new Blob([t], { type: "text/plain" })) })])
          .then(() => (copied = true)).catch(() => {});
    } catch {}
    list.push({ role: "user", text: q, about: { ...about } });
    ta.value = "";
    text.then(async t => {
      await new Promise(r => setTimeout(r, 400));
      if (!copied) { try { await navigator.clipboard.writeText(t); copied = true; } catch {} }
      if (!copied) list.push({ role: "ai", error: "Couldn't copy automatically: your browser didn't allow it. Try the other browser, or use Chrome.", done: true });
      renderLog();
      const d = panel.querySelector(".donkey-paste");
      if (d) d.open = true;
    });
  }

  function lastAnswer(btn) {
    const i = +btn.closest(".donkey-msg").dataset.i;
    return (chats[A().path()] || [])[i];
  }
  function saved(btn, label) { btn.textContent = "✓ " + label; btn.disabled = true; }

  panel.addEventListener("click", e => {
    const b = e.target.closest("[data-d]");
    if (!b || b.tagName === "SELECT") return;
    const api = A();
    switch (b.dataset.d) {
      case "close": return close();
      case "stop": return abort?.abort();
      case "clear": chats[api.path()] = []; return renderLog();
      case "unabout": about = { key: about?.key || api.sectionInView() }; about.quote = null; return renderAbout();
      case "ext": return external(e);
      case "connect-me": return connect(true);
      case "setup": return setupBox();
      case "pair": return connect(false);
      case "unpair-all": if (confirm("Unpair every phone and iPad from this Mac?")) unpairAll(); return;
      case "unpair-me": paired.set(null); return renderLog();
      case "copylink": navigator.clipboard?.writeText(b.dataset.link); return saved(b, "Copied");
      case "back": showEngine(); renderLog(); return checkRelay();
      case "copycmd": navigator.clipboard?.writeText(b.previousElementSibling.textContent); return saved(b, "Copied");
      case "pasted": {
        const t = b.previousElementSibling.value.trim();
        if (!t) return;
        (chats[api.path()] = chats[api.path()] || []).push({ role: "ai", text: t, about: { ...about }, done: true });
        return renderLog();
      }
      case "copy": navigator.clipboard?.writeText(lastAnswer(b).text); return saved(b, "Copied");
      case "side": { const m = lastAnswer(b); if (api.addComment(m.about?.quote, m.about?.key || api.sectionInView(), "🫏 " + m.text)) saved(b, "Kept as side note"); return; }
      case "note": { const m = lastAnswer(b); if (api.addNote(m.about?.quote, m.about?.key || api.sectionInView(), m.text)) saved(b, "Added as my note"); return; }
      case "weave": { const m = lastAnswer(b); if (api.insertIntoSection(m.about?.key || api.sectionInView(), m.about?.quote?.exact, m.text)) saved(b, "Added into the text"); return; }
    }
  });
  panel.addEventListener("change", e => { if (e.target.dataset.d === "engine") { pref.set(e.target.value); showEngine(); } });
  $(".donkey-form").addEventListener("submit", e => {
    e.preventDefault();
    const ta = $(".donkey-form textarea"), q = ta.value.trim();
    if (!q || abort) return;
    if (mode() === "fallback") {  // no AI on this device: point at the two links (they must be clicked to open a tab)
      panel.querySelector(".donkey-ext")?.setAttribute("open", "");
      panel.querySelectorAll("[data-d=ext], [data-d=connect-me]").forEach(a => { a.classList.add("pulse"); setTimeout(() => a.classList.remove("pulse"), 1600); });
      return;
    }
    justPaired = false;
    ta.value = "";
    ask(q);
  });
  $(".donkey-form textarea").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $(".donkey-form").requestSubmit(); }
  });
  fab.addEventListener("click", () => (panel.hidden ? open() : close()));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) close(); });

  // Show the button on lecture pages only (where annotations are attached).
  setInterval(() => { const ok = !!A()?.ready(); fab.hidden = !ok; if (!ok && !panel.hidden) close(); }, 700);
  addEventListener("hashchange", () => { about = null; if (!panel.hidden) setTimeout(() => open(), 400); });

  if (justPaired) setTimeout(function wait() { A()?.ready() ? open() : setTimeout(wait, 500); }, 500);

  window.Donkey = { open };
})();
