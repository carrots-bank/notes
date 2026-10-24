// "My space" and "World": the two halves of the notes site.
//
// My space (private to each person, encrypted with their personal key through annotate.js `records`):
//   space:index            {v:1, items:{id: item}}; items merge by `updated` across devices
//                          note     {kind:"note", title, branch, topic, date, world?:{id}}   (made by the note maker)
//                          bookmark {kind:"bookmark", ref:"#/doc/…" | "#/world/<id>", title}
//                          deleted items stay as tombstones {id, deleted:true, updated}
//   space:note:<id>        {md, transcript, slides, meta}
//   space:asset:<id>:<p>   {type, b64}   one image per record (p = "assets/slide-001.jpg")
// Library courses listed in the person's bundle (`m`) also appear in My space.
//
// World (everyone with a password; encrypted with the site-wide world key `w`; worker /v1/world/*):
//   approved community notes + the shared library. People submit their own notes; the admin reviews them.
(() => {
  const HELPER = "http://127.0.0.1:47321";
  const te = new TextEncoder(), td = new TextDecoder();
  const b64e = buf => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const fromHex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
  const V = () => window.Viewer, R = () => window.Annotate?.records;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const now = () => Date.now();
  const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");

  let B = null, SITE = null, WKEY = null, sidebar = null;
  let loadedP = Promise.resolve();
  let index = { items: {} }, indexLoaded = false, worldItems = [], worldAdmin = false, worldLoaded = false;
  const assetUrls = new Map();

  // ---------- setup ----------
  async function init(bundle, site) {
    B = bundle; SITE = site;
    loadedP = (async () => {
      WKEY = B?.w ? await crypto.subtle.importKey("raw", fromHex(B.w), "AES-GCM", false, ["encrypt", "decrypt"]) : null;
      await refresh();
    })();
  }
  const enabled = () => !!(SITE?.annotations && B?.a);
  async function refresh() {
    if (enabled() && await R()?.ready()) {
      try { const r = await R().get("space:index"); index = r.value || { items: {} }; index.items ||= {}; } catch {}
      indexLoaded = true;
      try { await loadWorld(); } catch {}
    }
    rerender();
  }
  function rerender() { if (sidebar) renderSidebar(sidebar); }

  // ---------- index ----------
  const live = () => Object.values(index.items).filter(it => !it.deleted);
  function mergeIdx(a, b) {
    const out = { v: 1, items: { ...(a.items || {}) } };
    for (const [id, it] of Object.entries(b.items || {})) if (!out.items[id] || (it.updated || 0) > (out.items[id].updated || 0)) out.items[id] = it;
    return out;
  }
  async function saveItems(...items) {
    const patch = { v: 1, items: Object.fromEntries(items.map(it => [it.id, { ...it, updated: now() }])) };
    index = mergeIdx(index, patch);
    rerender();
    const r = await R().put("space:index", mergeIdx(index, patch), null, (theirs, mine) => mergeIdx(theirs, mine));
    index = r.value;
    rerender();
  }

  // ---------- world ----------
  async function wseal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return b64e(iv) + "." + b64e(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, WKEY, te.encode(JSON.stringify(obj))));
  }
  async function wopen(s) {
    const [iv, ct] = s.split(".").map(b64d);
    return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, WKEY, ct)));
  }
  async function wcall(method, path, body) {
    const { url, token } = window.Annotate.api.relayAuth();
    const r = await fetch(`${url}/v1/world/${path}`, { method, cache: "no-store",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "world " + r.status);
    return j;
  }
  async function loadWorld() {
    if (!WKEY) return;
    const r = await wcall("GET", "list");
    worldAdmin = !!r.admin;
    worldItems = [];
    for (const row of r.items) { try { worldItems.push({ id: row.id, status: row.status, mine: !!row.mine, updated: row.updated, ...(await wopen(row.meta)) }); } catch {} }
    worldLoaded = true;
  }

  // ---------- sidebar ----------
  const tab = () => ls.get("space_tab", "mine");
  function renderSidebar(el) {
    sidebar = el;
    const M = V().manifest();
    if (!M) return;
    const t = tab();
    el.innerHTML = `<div class="sp-tabs"><button data-tab="mine" class="${t === "mine" ? "on" : ""}">My space</button>
      <button data-tab="world" class="${t === "world" ? "on" : ""}">World</button></div>
      <div class="sp-body">${t === "mine" ? mineHTML(M) : worldHTML(M)}</div>`;
    markActive();
  }
  function libTree(courses) {
    return courses.map(c => `
      <details><summary><a href="#/doc/${V().enc(c.name + "/README.md")}">${esc(c.name)}</a></summary>
        ${c.modules.map(m => `
          <details><summary><a href="#/doc/${V().enc(`${c.name}/${m.name}/README.md`)}">${esc(m.name)}</a></summary>
            <ul>${m.lectures.map(l => `<li data-q="${esc((c.name + " " + m.name + " " + l.title).toLowerCase())}"><a href="#/doc/${V().enc(l.path + "/notes.md")}">${esc(l.date ? l.date + " · " : "")}${esc(l.title)}</a>
              ${l.ru ? `<a class="lang" href="#/doc/${V().enc(l.path + "/notes.ru.md")}">RU</a>` : ""}</li>`).join("")}</ul>
          </details>`).join("")}
      </details>`).join("");
  }
  function group(items, link) {
    const by = {};
    for (const it of items) ((by[it.branch || "Unsorted"] ||= {})[it.topic || "General"] ||= []).push(it);
    return Object.keys(by).sort().map(b => `<details><summary>${esc(b)}</summary>${Object.keys(by[b]).sort().map(t => `
      <details><summary>${esc(t)}</summary><ul>${by[b][t].sort((x, y) => (y.date || "").localeCompare(x.date || "")).map(it =>
        `<li data-q="${esc(`${b} ${t} ${it.title}`.toLowerCase())}"><a href="${link(it)}">${esc(it.date ? it.date + " · " : "")}${esc(it.title || "Untitled")}</a>${badge(it)}</li>`).join("")}</ul></details>`).join("")}</details>`).join("");
  }
  function badge(it) {
    const w = it.world && worldItems.find(x => x.id === it.world.id);
    const st = w?.status || (it.status && it.status !== "approved" ? it.status : "");
    return st && st !== "draft" ? `<span class="sp-badge ${st}">${{ pending: "in review", approved: "in World", rejected: "not accepted" }[st] || st}</span>` : "";
  }
  function mineHTML(M) {
    const mine = (B?.m || []);
    const own = live().filter(it => it.kind === "note");
    const marks = live().filter(it => it.kind === "bookmark");
    const courses = M.tree.filter(c => mine.includes(c.name));
    let h = enabled() ? `<a class="btn primary sp-new" href="#/new">＋ New notes</a>` : "";
    if (!enabled()) h += `<p class="muted sp-hint">Press <strong>Lock</strong> and sign in again to switch on your own space.</p>`;
    if (own.length) h += `<h3 class="sp-h">My notes</h3>` + group(own, it => `#/space/${it.id}`);
    else if (enabled() && indexLoaded) h += `<p class="muted sp-hint">Your own notes will appear here. Press <strong>＋ New notes</strong> to make some from a recording and slides.</p>`;
    if (marks.length) h += `<h3 class="sp-h">Saved</h3><ul class="sp-list">${marks.sort((a, b) => b.updated - a.updated).map(m =>
      `<li><a href="${esc(m.ref)}">${esc(m.title)}</a><button class="icon sp-x" data-unsave="${esc(m.id)}" title="Remove from My space">✕</button></li>`).join("")}</ul>`;
    if (courses.length) h += `<h3 class="sp-h">My courses</h3>` + libTree(courses);
    return h;
  }
  function worldHTML(M) {
    const shared = M.tree.filter(c => !c.restricted);
    const community = worldItems.filter(x => x.status === "approved");
    const pending = worldItems.filter(x => x.status === "pending");
    let h = `<input class="sp-search" type="search" placeholder="Search the World…" value="${esc(ls.get("space_q", ""))}">`;
    if (worldAdmin && pending.length) h += `<a class="btn sp-review" href="#/review">Review queue <span class="sp-count">${pending.length}</span></a>`;
    if (community.length) h += `<h3 class="sp-h">Community notes</h3>` + group(community, it => `#/world/${it.id}`);
    if (shared.length) h += `<h3 class="sp-h">Library</h3>` + libTree(shared);
    if (!enabled()) h += `<p class="muted sp-hint">Press <strong>Lock</strong> and sign in again to see community notes.</p>`;
    return h;
  }
  function filterWorld(q) {
    ls.set("space_q", q);
    q = q.trim().toLowerCase();
    sidebar.querySelectorAll(".sp-body li[data-q]").forEach(li => (li.hidden = !!q && !q.split(/\s+/).every(w => li.dataset.q.includes(w))));
    sidebar.querySelectorAll(".sp-body details").forEach(d => {
      const any = [...d.querySelectorAll("li[data-q]")].some(li => !li.hidden);
      d.hidden = !!q && !any;
      if (q && any) d.open = true;
    });
  }
  function markActive() {
    if (!sidebar) return;
    sidebar.querySelectorAll("a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === location.hash));
    // Folders start closed; open only the ones leading to the page being read.
    for (let d = sidebar.querySelector("a.active")?.closest("details"); d; d = d.parentElement.closest("details")) d.open = true;
    const q = sidebar.querySelector(".sp-search");
    if (q && q.value) filterWorld(q.value);
  }
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-tab]");
    if (t && sidebar?.contains(t)) { ls.set("space_tab", t.dataset.tab); return rerender(); }
    const x = e.target.closest("[data-unsave]");
    if (x && sidebar?.contains(x)) { const it = index.items[x.dataset.unsave]; if (it) saveItems({ ...it, deleted: true }); }
  });
  document.addEventListener("input", e => { if (e.target.classList?.contains("sp-search")) filterWorld(e.target.value); });

  // ---------- pages ----------
  function route(h) {
    let m;
    if ((m = h.match(/^\/space\/([0-9a-f]{24})$/))) return showOwn(m[1]), true;
    if ((m = h.match(/^\/world\/([0-9a-f]{32})$/))) return showWorld(m[1]), true;
    if (h === "/review") return showReview(), true;
    if (h === "/new") return showNew(), true;
    return false;
  }
  function home() {
    const own = live().filter(it => it.kind === "note")[0];
    const M = V().manifest();
    const first = (B?.m?.length ? M.tree.filter(c => B.m.includes(c.name)) : M.tree)[0]?.modules.flatMap(x => x.lectures)[0];
    if (first) location.replace("#/doc/" + V().enc(first.path + "/notes.md"));
    else if (own) location.replace("#/space/" + own.id);
    else location.replace("#/new");
  }
  const page = html => { V().main.innerHTML = html; window.scrollTo(0, 0); return V().main; };
  const loading = () => page(`<p class="muted pad">Loading…</p>`);

  async function blobUrl(cacheKey, getter) {
    if (assetUrls.has(cacheKey)) return assetUrls.get(cacheKey);
    const p = (async () => {
      const v = await getter();
      if (!v?.b64) return null;
      return URL.createObjectURL(new Blob([b64d(v.b64)], { type: v.type || "image/jpeg" }));
    })().catch(() => null);
    assetUrls.set(cacheKey, p);
    return p;
  }
  function renderNote(note, path, toolbar, resolve) {
    const el = page(`<div class="sp-bar">${toolbar}</div><article class="notes"></article>`);
    const article = el.querySelector("article.notes");
    const secs = V().splitSections(note.md || "");
    V().renderNotes(article, secs, path, { resolve });
    window.Annotate?.attach(path, article, { secs, render: (x, parts, opts) => V().renderNotes(x, parts, path, { ...opts, resolve }),
      load: async name => name === "transcript.txt" ? note.transcript || null : name === "images.json" ? JSON.stringify(note.slides || []) : null });
    return el;
  }

  async function showOwn(id) {
    loading();
    if (!(await R()?.ready())) return page(`<section class="panel"><p>Sign in again to open your notes.</p></section>`);
    await loadedP;
    if (!index.items[id]) await refresh();  // e.g. just made on this laptop
    const it = index.items[id];
    let note;
    try { note = (await R().get("space:note:" + id)).value; } catch (e) { return page(`<section class="panel"><p>Couldn't open this note: ${esc(e.message)}</p></section>`); }
    if (!note || note.deleted) return page(`<section class="panel"><p>This note isn't available any more.</p></section>`);
    const w = it?.world && worldItems.find(x => x.id === it.world.id);
    const bar = `<span class="sp-crumb">${esc(it?.branch || "Unsorted")} › ${esc(it?.topic || "General")}</span><span class="spacer"></span>
      ${w ? `<span class="sp-badge ${w.status}">${{ pending: "In review", approved: "In the World", rejected: "Not accepted" }[w.status] || w.status}</span>` : ""}
      ${!w || w.status === "rejected" ? `<button class="btn" data-sp="share">Share to World</button>` : ""}
      <button class="btn ghost" data-sp="move">Move</button><button class="btn ghost" data-sp="download">Download</button>
      <button class="btn ghost" data-sp="delete">Delete</button>`;
    const el = renderNote(note, `space/${id}/notes.md`, bar, target => {
      const m = target.match(/^space\/[0-9a-f]+\/(.+)$/);
      return m ? blobUrl(`own:${id}:${m[1]}`, async () => (await R().get(`space:asset:${id}:${m[1]}`)).value) : null;
    });
    el.querySelector(".sp-bar").addEventListener("click", e => {
      const a = e.target.closest("[data-sp]")?.dataset.sp;
      if (a === "share") shareToWorld(id, note, it);
      if (a === "move") moveNote(it);
      if (a === "delete") deleteNote(it);
      if (a === "download") download(`${it?.title || "notes"}.md`, note.md);
    });
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = name.replace(/[\\/:*?"<>|]/g, "-");
    a.click();
  }
  async function moveNote(it) {
    if (!it) return;
    const branch = prompt("Branch (e.g. a course or subject):", it.branch || ""); if (branch === null) return;
    const topic = prompt("Topic (e.g. a module or theme):", it.topic || ""); if (topic === null) return;
    await saveItems({ ...it, branch: branch.trim(), topic: topic.trim() });
  }
  async function deleteNote(it) {
    if (!it || !confirm(`Delete "${it.title}" from your space? This can't be undone.`)) return;
    await saveItems({ id: it.id, deleted: true });
    R().remove("space:note:" + it.id).catch(() => {});
    location.hash = "#/";
  }

  async function shareToWorld(id, note, it) {
    if (!WKEY) return alert("Sign in again to share notes.");
    it = it || index.items[id] || { id, kind: "note", ...(note.meta || {}) };
    const by = prompt(worldAdmin ? "Publish to the World. Show it as written by (optional):" :
      "Send these notes to the admin for review. Once approved, everyone on the site can read them.\n\nShow it as written by (optional):", "");
    if (by === null) return;
    const bar = V().main.querySelector(".sp-bar");
    const say = t => { bar.querySelector(".sp-progress")?.remove(); bar.insertAdjacentHTML("beforeend", `<span class="sp-progress muted">${esc(t)}</span>`); };
    try {
      say("Preparing…");
      const meta = { title: it?.title || "Untitled", branch: it?.branch || "", topic: it?.topic || "", date: it?.date || "", by: by.trim() };
      const { id: wid } = await wcall("POST", "item", { meta: await wseal(meta), body: await wseal({ md: note.md, transcript: note.transcript || "", slides: note.slides || [] }) });
      const names = [...new Set([...(note.md || "").matchAll(/\]\((assets\/[^)\s]+)\)/g)].map(m => m[1]))];
      for (let i = 0; i < names.length; i++) {
        say(`Uploading images ${i + 1}/${names.length}…`);
        const v = (await R().get(`space:asset:${id}:${names[i]}`)).value;
        if (v) await wcall("PUT", `item/${wid}/blob/${encodeURIComponent(names[i])}`, { data: await wseal(v) });
      }
      const r = await wcall("POST", `item/${wid}/submit`);
      await saveItems({ ...it, world: { id: wid } });
      await loadWorld();
      say(r.status === "approved" ? "Published to the World." : "Sent for review.");
      showOwn(id);
    } catch (e) { say("Couldn't share: " + e.message); }
  }

  async function showWorld(wid) {
    loading();
    await loadedP;
    if (!WKEY || !enabled()) return page(`<section class="panel"><p>Sign in again to open World notes.</p></section>`);
    let row, meta, body;
    try { row = await wcall("GET", `item/${wid}`); meta = await wopen(row.meta); body = await wopen(row.body); }
    catch (e) { return page(`<section class="panel"><p>Couldn't open this note: ${esc(e.message)}</p></section>`); }
    const saved = live().find(it => it.kind === "bookmark" && it.ref === `#/world/${wid}`);
    const bar = `<span class="sp-crumb">World › ${esc(meta.branch || "Unsorted")} › ${esc(meta.topic || "General")}${meta.by ? ` · by ${esc(meta.by)}` : ""}</span><span class="spacer"></span>
      ${row.status !== "approved" ? `<span class="sp-badge ${row.status}">${esc(row.status)}</span>` : ""}
      ${worldAdmin && row.status === "pending" ? `<button class="btn primary" data-w="approve">Approve</button><button class="btn" data-w="reject">Reject</button>` : ""}
      ${worldAdmin && row.status === "approved" ? `<button class="btn ghost" data-w="unpublish">Unpublish</button>` : ""}
      ${worldAdmin ? `<button class="btn ghost" data-w="delete">Delete</button>` : ""}
      ${row.status === "approved" ? `<button class="btn ${saved ? "" : "ghost"}" data-w="save">${saved ? "★ In My space" : "☆ Save to My space"}</button>` : ""}`;
    const el = renderNote(body, `world/${wid}/notes.md`, bar, target => {
      const m = target.match(/^world\/[0-9a-f]+\/(.+)$/);
      return m ? blobUrl(`world:${wid}:${m[1]}`, async () => wopen((await wcall("GET", `item/${wid}/blob/${encodeURIComponent(m[1])}`)).data)) : null;
    });
    el.querySelector(".sp-bar").addEventListener("click", async e => {
      const a = e.target.closest("[data-w]")?.dataset.w;
      if (!a) return;
      if (a === "save") { saved ? await saveItems({ ...saved, deleted: true }) : await saveItems({ id: "bm:" + wid, kind: "bookmark", ref: `#/world/${wid}`, title: meta.title }); return showWorld(wid); }
      if (a === "delete" && !confirm("Delete this item from the World for everyone?")) return;
      if (a === "delete") { await wcall("DELETE", `item/${wid}`); await loadWorld(); rerender(); location.hash = "#/review"; return; }
      await wcall("POST", `item/${wid}/review`, { action: a });
      await loadWorld(); rerender(); showWorld(wid);
    });
  }

  async function showReview() {
    await loadedP;
    if (!worldAdmin) return page(`<section class="panel"><p>Only the site admin can review submissions.</p></section>`);
    loading();
    try { await loadWorld(); } catch {}
    rerender();
    const rows = worldItems.filter(x => x.status !== "draft").sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || b.updated - a.updated);
    page(`<section class="panel sp-review-page"><h1>Review queue</h1>
      <p class="muted">Open a submission to read it, then approve or reject it. Approved notes appear in everyone's World tab.</p>
      ${rows.length ? `<table><thead><tr><th>Notes</th><th>Where</th><th>Status</th></tr></thead><tbody>${rows.map(r =>
        `<tr><td><a href="#/world/${r.id}">${esc(r.title)}</a>${r.by ? ` <span class="muted">by ${esc(r.by)}</span>` : ""}</td><td>${esc(r.branch)} › ${esc(r.topic)}</td><td><span class="sp-badge ${r.status}">${esc(r.status)}</span></td></tr>`).join("")}</tbody></table>` : `<p>Nothing to review yet.</p>`}</section>`);
  }

  // ---------- making new notes (on this laptop, through the helper) ----------
  function showNew() {
    const own = live().filter(it => it.kind === "note");
    const branches = [...new Set(own.map(it => it.branch).filter(Boolean))].sort();
    const topics = [...new Set(own.map(it => it.topic).filter(Boolean))].sort();
    const el = page(`<section class="panel sp-new-page"><h1>New notes</h1>
      <p>Turn a lecture recording and its slides (or any documents) into detailed notes in the same format as the course notes, written by <em>your</em> Claude or ChatGPT on this laptop. They're saved privately in My space; you can share them to the World later.</p>
      <form class="sp-form">
        <label>Branch <small class="muted">(a course, subject or area)</small>
          <input name="branch" list="sp-branches" required placeholder="e.g. Land Economy IB" value="${esc(ls.get("space_branch", ""))}"></label>
        <datalist id="sp-branches">${branches.map(b => `<option value="${esc(b)}">`).join("")}</datalist>
        <label>Topic <small class="muted">(a module, paper or theme)</small>
          <input name="topic" list="sp-topics" required placeholder="e.g. Paper 3 Land law" value="${esc(ls.get("space_topic", ""))}"></label>
        <datalist id="sp-topics">${topics.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
        <label>Title <input name="title" required placeholder="e.g. Lecture 4: Easements"></label>
        <label>Date <input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <button class="btn primary" type="submit">Continue: choose the files</button>
      </form>
      <div class="sp-need muted">
        <p><strong>Needs:</strong> a Mac with Apple Silicon, the 🫏 helper with note-making installed, and Claude Pro (or ChatGPT Plus). The recording and files stay on your laptop; only the finished notes and slide images are saved (encrypted) to your space.</p>
        <p>Set it up once in Terminal:<br><code>curl -fsSL ${esc(location.origin + location.pathname.replace(/[^/]*$/, ""))}helper/install.sh | bash -s -- --maker</code></p>
      </div></section>`);
    el.querySelector(".sp-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = new FormData(e.target), get = k => String(f.get(k) || "").trim();
      ls.set("space_branch", get("branch")); ls.set("space_topic", get("topic"));
      const payload = { site: location.origin + location.pathname, worker: SITE.annotations, secret: B.a,
        branch: get("branch"), topic: get("topic"), title: get("title"), date: get("date") };
      const url = `${HELPER}/maker#` + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const w = window.open(url, "_blank");
      e.target.insertAdjacentHTML("afterend", `<p class="sp-progress">The note maker opened in a new tab${w ? "" : " (if it didn't, allow pop-ups)"}. Add the recording and files there. When it finishes, the notes appear under <strong>My notes</strong> (press <a href="#/new" data-sp-refresh>refresh</a>).</p>`);
    });
  }
  document.addEventListener("click", e => { if (e.target.closest("[data-sp-refresh]")) { e.preventDefault(); refresh(); } });
  addEventListener("focus", () => { if (enabled() && indexLoaded) refresh(); });

  // A star on library lectures, to keep them in My space.
  function decorateDoc(path) {
    if (!enabled() || !/\/notes(\.ru)?\.md$/.test(path)) return;
    const ref = "#/doc/" + V().enc(path), saved = live().find(it => it.kind === "bookmark" && it.ref === ref);
    const article = V().main.querySelector("article.notes");
    if (!article || V().main.querySelector(".sp-bar")) return;
    const title = article.querySelector("h1")?.textContent.trim() || path.split("/").slice(-2, -1)[0];
    article.insertAdjacentHTML("beforebegin", `<div class="sp-bar"><span class="spacer"></span><button class="btn ${saved ? "" : "ghost"}" data-save-doc>${saved ? "★ In My space" : "☆ Save to My space"}</button></div>`);
    V().main.querySelector("[data-save-doc]").addEventListener("click", async () => {
      saved ? await saveItems({ ...saved, deleted: true }) : await saveItems({ id: "bm:" + path, kind: "bookmark", ref, title });
      V().main.querySelector(".sp-bar")?.remove(); decorateDoc(path);
    });
  }

  window.Space = { init, renderSidebar, markActive, route, home, decorateDoc, refresh };
})();
