// 🫏 The study assistant. Questions go to the helper on this computer (helper/notes-helper.py), which passes them to
// the person's own Claude Code or Codex login, so answers come from their own subscription and never through anyone
// else's account. Every question carries the lecture's slide text, transcript and the person's notes, so answers stay
// grounded in the lecture. Without a helper, the same package can be copied into claude.ai or chatgpt.com.
(() => {
  const HELPER = "http://127.0.0.1:47321";
  const SITE = location.origin + location.pathname.replace(/[^/]*$/, "");
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = s => DOMPurify.sanitize(marked.parse(s || ""));
  const A = () => window.Annotate?.api;
  const pref = { get: () => { try { return localStorage.getItem("donkey_engine") || "auto"; } catch { return "auto"; } },
                 set: v => { try { localStorage.setItem("donkey_engine", v); } catch {} } };

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
  function showEngine() {
    const el = $(".donkey-engine"), e = chosenEngine();
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
    checkHelper(true).then(renderLog);
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
    if (!helper || !chosenEngine()) html += fallbackBox();
    if (!list.length && helper && chosenEngine()) html += `<p class="muted donkey-hint">Ask anything about this lecture: “explain this more simply”, “give me an example”, “add a paragraph on …”, “make 3 exam questions on this section”. I read the slides, the transcript and your notes first.</p>`;
    log.innerHTML = html;
    log.scrollTop = log.scrollHeight;
  }
  function fallbackBox() {
    return `<div class="donkey-fallback">
      <p><strong>No donkey helper on this device.</strong> You can still ask your own Claude or ChatGPT: type your question below, then press a button. I copy the question with this lecture's slides, transcript and your notes, and open the chat for you: just paste (⌘V) and send.</p>
      <div class="donkey-row"><button class="btn" data-d="ext-claude">Ask in Claude</button><button class="btn" data-d="ext-chatgpt">Ask in ChatGPT</button>
        <button class="btn ghost" data-d="setup">Set up on this laptop</button></div>
      <details class="donkey-paste"><summary>Paste the answer here to save it</summary>
        <textarea rows="4" placeholder="Paste the answer from Claude or ChatGPT"></textarea>
        <button class="btn" data-d="pasted">Use this answer</button></details>
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
  function updateLast(msg) {
    const els = panel.querySelectorAll(".donkey-msg.ai");
    const el = els[els.length - 1];
    if (el) { el.innerHTML = md(msg.text); const log = $(".donkey-log"); log.scrollTop = log.scrollHeight; }
  }

  async function external(which) {
    const q = $(".donkey-form textarea").value.trim();
    if (!q) { $(".donkey-form textarea").focus(); $(".donkey-form textarea").placeholder = "Type your question first, then press the button"; return; }
    const api = A(), path = api.path(), list = (chats[path] = chats[path] || []);
    // Open the tab and start the copy within the click itself; browsers block both once we've awaited anything.
    const text = buildPrompt(q, about).then(p => SYSTEM + "\n\n" + p);
    let copied = false;
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(t => new Blob([t], { type: "text/plain" })) })])
          .then(() => (copied = true)).catch(() => {});
      }
    } catch {}
    const tab = window.open(which === "claude" ? "https://claude.ai/new" : "https://chatgpt.com/", "_blank");
    list.push({ role: "user", text: q, about: { ...about } });
    const t = await text;
    await new Promise(r => setTimeout(r, 300));
    if (!copied) { try { await navigator.clipboard.writeText(t); copied = true; } catch {} }
    if (!copied) list.push({ role: "ai", error: "Couldn't copy automatically. Press ⌘C after selecting the box below, then paste it into the chat.", done: true });
    if (!tab) list.push({ role: "ai", error: "The browser blocked the new tab: allow pop-ups for this site, or open claude.ai yourself and paste (⌘V).", done: true });
    $(".donkey-form textarea").value = "";
    renderLog();
    const d = panel.querySelector(".donkey-paste");
    if (d) d.open = true;
  }

  function lastAnswer(btn) {
    const i = +btn.closest(".donkey-msg").dataset.i;
    return (chats[A().path()] || [])[i];
  }
  function saved(btn, label) { btn.textContent = "✓ " + label; btn.disabled = true; }

  panel.addEventListener("click", async e => {
    const b = e.target.closest("[data-d]");
    if (!b || b.tagName === "SELECT") return;
    const api = A();
    switch (b.dataset.d) {
      case "close": return close();
      case "stop": return abort?.abort();
      case "clear": chats[api.path()] = []; return renderLog();
      case "unabout": about = { key: about?.key || api.sectionInView() }; about.quote = null; return renderAbout();
      case "ext-claude": return external("claude");
      case "ext-chatgpt": return external("chatgpt");
      case "setup": return setupBox();
      case "back": return renderLog();
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
    if (!helper || !chosenEngine()) return external("claude");
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

  window.Donkey = { open };
})();
