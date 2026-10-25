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

  // ---------- the World catalogue: library lectures + approved community items ----------
  const UNSET_UNI = "Other";
  function catalog() {
    const M = V().manifest(), out = [];
    for (const c of M.tree.filter(c => !c.restricted)) for (const m of c.modules) for (const l of m.lectures)
      out.push({ key: "lib:" + l.path, ref: "#/doc/" + V().enc(l.path + "/notes.md"), title: l.title, date: l.date, uni: c.uni || c.name,
        subject: c.name, topic: m.name, summary: l.summary || "", type: "Lecture notes", source: "Library" });
    for (const w of worldItems.filter(x => x.status === "approved"))
      out.push({ key: "w:" + w.id, ref: `#/world/${w.id}`, title: w.title, date: w.date, uni: w.uni || UNSET_UNI, subject: w.branch || "Unsorted",
        topic: w.topic || "General", summary: w.summary || "", type: w.type || "Lecture notes", source: "Community", by: w.by });
    return out;
  }
  // Recently opened pages (this device), for "Recently viewed" and recommendations.
  const recent = () => { try { return JSON.parse(ls.get("space_recent", "[]")); } catch { return []; } };
  function recordVisit(ref, title) {
    if (!ref || !title) return;
    ls.set("space_recent", JSON.stringify([{ ref, title, t: now() }, ...recent().filter(r => r.ref !== ref)].slice(0, 30)));
  }

  // ---------- search and recommendations (TF-IDF over title, place and summary) ----------
  const STOP = new Set("the and for with from that this are was were into onto over under about between their there which what when where while have has had not but its it's our your you they them then than also more most such these those each other some any all can may will would should could lecture lectures notes week paper part section introduction".split(" "));
  const words = t => (String(t || "").toLowerCase().normalize("NFKD").match(/[a-zÀ-ɏЀ-ӿ]{3,}/g) || []).filter(w => !STOP.has(w));
  const docText = e => `${e.title} ${e.title} ${e.subject} ${e.topic} ${e.topic} ${e.uni} ${e.summary} ${e.type}`;
  function vectors(entries) {
    const df = new Map(), tfs = entries.map(e => { const tf = new Map(); for (const w of words(docText(e))) tf.set(w, (tf.get(w) || 0) + 1); return tf; });
    for (const tf of tfs) for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    const N = entries.length || 1;
    return { df, N, vecs: tfs.map(tf => { const v = new Map(); let n = 0; for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + N / df.get(w)); v.set(w, x); n += x * x; } n = Math.sqrt(n) || 1; for (const [w, x] of v) v.set(w, x / n); return v; }) };
  }
  function searchCatalog(entries, q) {
    const qs = words(q);
    if (!qs.length) return entries.map(e => ({ e, s: 0 }));
    const { vecs } = vectors(entries);
    return entries.map((e, i) => {
      const hay = docText(e).toLowerCase();
      let s = 0;
      for (const w of qs) { s += (vecs[i].get(w) || 0) * 3; if (hay.includes(w)) s += 0.2; for (const k of vecs[i].keys()) if (k !== w && k.startsWith(w)) { s += vecs[i].get(k); break; } }
      if (e.title.toLowerCase().includes(q.trim().toLowerCase())) s += 1;
      return { e, s };
    }).filter(r => r.s > 0).sort((a, b) => b.s - a.s);
  }
  function recommend(entries, n = 8) {
    const saved = new Set(live().filter(it => it.kind === "bookmark").map(it => it.ref));
    const liked = [
      ...live().filter(it => it.kind === "bookmark").map(it => ({ ref: it.ref, w: 3 })),
      ...recent().slice(0, 15).map((r, i) => ({ ref: r.ref, w: 1.5 - i / 15 })),
    ];
    const own = live().filter(it => it.kind === "note").map(it => ({ title: it.title, subject: it.branch, topic: it.topic, uni: it.uni, summary: "", type: it.type || "" }));
    const all = [...entries, ...own];
    const { vecs } = vectors(all);
    const profile = new Map(), add = (v, w) => { for (const [k, x] of v) profile.set(k, (profile.get(k) || 0) + x * w); };
    liked.forEach(l => { const i = entries.findIndex(e => e.ref === l.ref); if (i >= 0) add(vecs[i], l.w); });
    own.forEach((_, j) => add(vecs[entries.length + j], 2));
    if (!profile.size) return { basis: false, items: [] };
    const seen = new Set([...saved, ...recent().slice(0, 3).map(r => r.ref)]);
    const scored = entries.map((e, i) => { let s = 0; for (const [k, x] of vecs[i]) s += x * (profile.get(k) || 0); return { e, s }; })
      .filter(r => r.s > 0 && !seen.has(r.e.ref)).sort((a, b) => b.s - a.s);
    const top = scored[0]?.s || 0;  // keep only reasonably close matches
    return { basis: true, items: scored.filter(r => r.s >= top * 0.3).slice(0, n) };
  }

  // ---------- sidebar ----------
  const tab = () => ls.get("space_tab", "mine");
  function renderSidebar(el) {
    sidebar = el;
    const M = V().manifest();
    if (!M) return;
    const t = tab();
    el.innerHTML = `<div class="sp-tabs"><button data-tab="mine" class="${t === "mine" ? "on" : ""}">My space</button>
      <button data-tab="world" class="${t === "world" ? "on" : ""}">World</button>
      ${B?.fin ? `<button data-tab="fin" class="${t === "fin" ? "on" : ""}" title="Finance Town">🏦 Finance</button>` : ""}</div>
      <div class="sp-body">${t === "fin" && B?.fin ? financeHTML() : t === "world" ? worldHTML() : mineHTML(M)}</div>`;
    markActive();
  }
  // Nested folders: levels = [["uni", label], ...]; leaves rendered by `leaf`.
  function tree(items, levels, leaf) {
    if (!levels.length) return `<ul>${items.sort((x, y) => (y.date || "").localeCompare(x.date || "") || String(x.title).localeCompare(y.title)).map(leaf).join("")}</ul>`;
    const [key, fallback] = levels[0], by = {};
    for (const it of items) (by[it[key] || fallback] ||= []).push(it);
    return Object.keys(by).sort((a, b) => (a === fallback) - (b === fallback) || a.localeCompare(b)).map(k =>
      `<details><summary>${esc(k)}</summary>${tree(by[k], levels.slice(1), leaf)}</details>`).join("");
  }
  const li = (href, it, extra = "") => `<li data-q="${esc(`${it.uni || ""} ${it.subject || it.branch || ""} ${it.topic || ""} ${it.title}`.toLowerCase())}"><a href="${href}">${esc(it.date ? it.date + " · " : "")}${esc(it.title || "Untitled")}</a>${extra}</li>`;
  function badge(it) {
    const w = it.world && worldItems.find(x => x.id === it.world.id);
    const st = w?.status;
    return st && st !== "draft" ? `<span class="sp-badge ${st}">${{ pending: "in review", approved: "in World", rejected: "not accepted" }[st] || st}</span>` : "";
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
  function mineHTML(M) {
    const mine = (B?.m || []);
    const own = live().filter(it => it.kind === "note" && it.uni !== FINANCE);
    const marks = live().filter(it => it.kind === "bookmark");
    const courses = M.tree.filter(c => mine.includes(c.name));
    let h = enabled() ? `<div class="sp-actions"><a class="btn primary" href="#/new">＋ New notes</a><a class="btn" href="#/write">＋ Write</a></div>` : "";
    if (!enabled()) h += `<p class="muted sp-hint">Press <strong>Lock</strong> and sign in again to switch on your own space.</p>`;
    if (own.length) h += `<h3 class="sp-h">My notes</h3>` + tree(own, [["uni", UNSET_UNI], ["branch", "Unsorted"], ["topic", "General"]], it => li(`#/space/${it.id}`, it, badge(it)));
    else if (enabled() && indexLoaded) h += `<p class="muted sp-hint">Your own notes and material will appear here. Make notes from a recording and slides, or write your own.</p>`;
    if (marks.length) h += `<h3 class="sp-h">Saved</h3><ul class="sp-list">${marks.sort((a, b) => b.updated - a.updated).map(m =>
      `<li><a href="${esc(m.ref)}">${esc(m.title)}</a><button class="icon sp-x" data-unsave="${esc(m.id)}" title="Remove from My space">✕</button></li>`).join("")}</ul>`;
    const rec = recent().filter(r => !marks.some(m => m.ref === r.ref)).slice(0, 6);
    if (rec.length) h += `<h3 class="sp-h">Recently viewed</h3><ul class="sp-list">${rec.map(r => `<li><a href="${esc(r.ref)}">${esc(r.title)}</a></li>`).join("")}</ul>`;
    if (courses.length) h += `<h3 class="sp-h">My courses</h3>` + libTree(courses);
    return h;
  }
  // ---------- Finance Town: Julian's stock-pitch skills, run by the person's own Claude through the helper ----------
  const FINANCE = "Finance Town";
  function financeHTML() {
    const pitches = live().filter(it => it.kind === "note" && it.uni === FINANCE);
    let h = `<a class="btn primary sp-explore" href="#/finance">＋ New company pitch</a>`;
    h += pitches.length ? `<h3 class="sp-h">Pitches by sector</h3>` + tree(pitches, [["branch", "Unsorted"], ["topic", "Company"]], it => li(`#/space/${it.id}`, it, badge(it)))
      : `<p class="muted sp-hint">Research memos made with Julian's long/short pitch skills appear here, filed by sector and company.</p>`;
    return h;
  }
  function showPitchForm() {
    if (!B?.fin) return page(`<section class="panel"><p>Finance Town isn't switched on for this account.</p></section>`);
    const el = page(`<section class="panel sp-new-page"><h1>🏦 Finance Town: new company pitch</h1>
      <p>Prepares a long/short research memo on a listed company with Julian's pitch skill: business model, how it makes money, margins, moat, industry, KPIs and the thesis (no valuation). Your Claude does the research on your laptop; the memo is saved here as a page and as a Word file.</p>
      <form class="sp-form">
        <label>Company or ticker <input name="company" required placeholder="e.g. Ryanair, RYA LN, Adyen"></label>
        <div class="sp-row"><label>Type <select name="kind"><option value="auto">Choose automatically</option><option value="quick">Non-financial company (quick pitch)</option><option value="fig">Bank, insurer, asset manager, payments, exchange, fintech (FIG)</option></select></label>
          <label>Your view <select name="view"><option value="">No prior view</option><option value="long">Long</option><option value="short">Short</option></select></label></div>
        <label>Focus question <small class="muted">(optional)</small> <input name="focus" placeholder="e.g. Is the margin recovery sustainable?"></label>
        <button class="btn primary" type="submit">Continue: add filings (optional) and start</button>
      </form>
      <div class="sp-need muted"><p><strong>Needs</strong> the 🫏 helper with note-making on this Mac and Claude Pro or higher. A full memo can take 20–60 minutes and uses a good part of a daily Claude allowance. Keep this tab open until the pitch has started.</p></div></section>`);
    el.querySelector(".sp-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = new FormData(e.target), get = k => String(f.get(k) || "").trim();
      const payload = { mode: "pitch", site: location.origin + location.pathname, worker: SITE.annotations, secret: B.a,
        company: get("company"), kind: get("kind"), view: get("view"), focus: get("focus"), date: new Date().toISOString().slice(0, 10),
        uni: FINANCE, title: get("company") + " pitch", test: ls.get("finance_test", "") === "1" };  // test: a short memo
      const url = `${HELPER}/maker#` + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const w = window.open(url, "_blank");
      e.target.insertAdjacentHTML("afterend", `<p class="sp-progress">The pitch maker opened in a new tab${w ? "" : " (if it didn't, allow pop-ups)"}. Add any filings there and press <em>Prepare the pitch</em>. Keep this tab open until it has started; the finished pitch appears in the 🏦 Finance tab.</p>`);
    });
  }
  // The maker page asks this tab for Julian's skills (they are only ever decrypted here, for this account).
  addEventListener("message", async e => {
    if (e.origin !== HELPER || e.data?.type !== "notes-maker:need-skills" || !B?.fin) return;
    const files = Object.keys(V().manifest().files).filter(p => p.startsWith(FINANCE + "/skills/"));
    const skills = {};
    for (const p of files) skills[p.split("/").pop()] = await V().readText(p);
    e.source.postMessage({ type: "notes-maker:skills", skills }, HELPER);
  });

  function worldHTML() {
    const pending = worldItems.filter(x => x.status === "pending");
    let h = `<a class="btn primary sp-explore" href="#/world">🔎 Search the World</a>`;
    if (worldAdmin && pending.length) h += `<a class="btn sp-review" href="#/review">Review queue <span class="sp-count">${pending.length}</span></a>`;
    h += `<input class="sp-search" type="search" placeholder="Filter this list…" value="${esc(ls.get("space_q", ""))}">`;
    const entries = catalog();
    h += `<h3 class="sp-h">By university</h3>` + tree(entries, [["uni", UNSET_UNI], ["subject", "Unsorted"], ["topic", "General"]],
      e => li(e.ref, e, e.source === "Community" ? `<span class="sp-badge">community</span>` : ""));
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
    if (h === "/write") return showWrite(), true;
    if (h === "/finance") return showPitchForm(), true;
    if (h === "/world" || h.startsWith("/world?")) return showExplore(new URLSearchParams(h.split("?")[1] || "")), true;
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
      ${note.docx ? `<button class="btn" data-sp="docx">⬇ Word</button>` : ""}
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
      if (a === "docx") downloadDocx(id, note.docx, it?.title);
    });
  }
  async function downloadDocx(id, rel, title) {
    const v = (await R().get(`space:asset:${id}:${rel}`)).value;
    if (!v?.b64) return alert("The Word file isn't available.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([b64d(v.b64)], { type: v.type }));
    a.download = (v.name || `${title || "memo"}.docx`).replace(/[\\/:*?"<>|]/g, "-");
    a.click();
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = name.replace(/[\\/:*?"<>|]/g, "-");
    a.click();
  }
  async function moveNote(it) {
    if (!it) return;
    const uni = prompt("University (or another top-level folder, e.g. a theme):", it.uni || ""); if (uni === null) return;
    const branch = prompt("Subject (e.g. a course):", it.branch || ""); if (branch === null) return;
    const topic = prompt("Topic (e.g. a module or theme):", it.topic || ""); if (topic === null) return;
    await saveItems({ ...it, uni: uni.trim(), branch: branch.trim(), topic: topic.trim() });
  }
  async function deleteNote(it) {
    if (!it || !confirm(`Delete "${it.title}" from your space? This can't be undone.`)) return;
    await saveItems({ id: it.id, deleted: true });
    R().remove("space:note:" + it.id).catch(() => {});
    location.hash = "#/";
  }

  function summaryOf(md, limit = 420) {
    const m = (md || "").match(/^## Overview\s*\n([\s\S]*?)(?=^\*\*By the end|^## )/m);
    let t = (m ? m[1] : (md || "").replace(/^#.*$/m, "")).replace(/!\[[^\]]*\]\([^)]*\)|<[^>]+>/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
    return t.length > limit ? t.slice(0, limit).replace(/\s\S*$/, "") + "…" : t;
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
      const meta = { title: it?.title || "Untitled", uni: it?.uni || "", branch: it?.branch || "", topic: it?.topic || "", date: it?.date || "",
        type: it?.type || "Lecture notes", summary: summaryOf(note.md), by: by.trim() };
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
    if (row.status === "approved") recordVisit(`#/world/${wid}`, meta.title);
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
  const unis = () => [...new Set([...catalog().map(e => e.uni), ...live().map(it => it.uni)].filter(u => u && u !== UNSET_UNI))].sort();
  function showNew() {
    const own = live().filter(it => it.kind === "note");
    const branches = [...new Set(own.map(it => it.branch).filter(Boolean))].sort();
    const topics = [...new Set(own.map(it => it.topic).filter(Boolean))].sort();
    const el = page(`<section class="panel sp-new-page"><h1>New notes</h1>
      <p>Turn a lecture recording and its slides (or any documents) into detailed notes in the same format as the course notes, written by <em>your</em> Claude or ChatGPT on this laptop. They're saved privately in My space; you can share them to the World later.</p>
      <form class="sp-form">
        <label>University <small class="muted">(top-level folder: a university, or a theme)</small>
          <input name="uni" list="sp-unis" placeholder="e.g. University of Cambridge" value="${esc(ls.get("space_uni", ""))}"></label>
        <datalist id="sp-unis">${unis().map(u => `<option value="${esc(u)}">`).join("")}</datalist>
        <label>Subject <small class="muted">(a course, subject or area)</small>
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
      ls.set("space_branch", get("branch")); ls.set("space_topic", get("topic")); ls.set("space_uni", get("uni"));
      const payload = { site: location.origin + location.pathname, worker: SITE.annotations, secret: B.a,
        uni: get("uni"), branch: get("branch"), topic: get("topic"), title: get("title"), date: get("date") };
      const url = `${HELPER}/maker#` + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const w = window.open(url, "_blank");
      e.target.insertAdjacentHTML("afterend", `<p class="sp-progress">The note maker opened in a new tab${w ? "" : " (if it didn't, allow pop-ups)"}. Add the recording and files there. When it finishes, the notes appear under <strong>My notes</strong> (press <a href="#/new" data-sp-refresh>refresh</a>).</p>`);
    });
  }
  document.addEventListener("click", e => { if (e.target.closest("[data-sp-refresh]")) { e.preventDefault(); refresh(); } });
  addEventListener("focus", () => { if (enabled() && indexLoaded) refresh(); });

  // ---------- writing your own material ----------
  const TYPES = ["Summary", "Revision notes", "Essay plan", "Exam answer", "Reading notes", "Lecture notes", "Other"];
  function showWrite() {
    const own = live().filter(it => it.kind === "note");
    const list = (id, vals) => `<datalist id="${id}">${[...new Set(vals.filter(Boolean))].sort().map(v => `<option value="${esc(v)}">`).join("")}</datalist>`;
    const el = page(`<section class="panel sp-new-page"><h1>Write material</h1>
      <p>Write or paste your own notes, a summary, an essay plan… It's saved privately in My space, and you can share it to the World later. <a href="https://www.markdownguide.org/cheat-sheet/" target="_blank" rel="noopener">Markdown</a> works (# headings, **bold**, - lists, | tables |).</p>
      <form class="sp-form">
        <div class="sp-row"><label>University <input name="uni" list="w-unis" value="${esc(ls.get("space_uni", ""))}" placeholder="e.g. University of Cambridge"></label>
          <label>Type <select name="type">${TYPES.map(t => `<option>${t}</option>`).join("")}</select></label></div>
        <div class="sp-row"><label>Subject <input name="branch" list="w-br" required value="${esc(ls.get("space_branch", ""))}"></label>
          <label>Topic <input name="topic" list="w-tp" required value="${esc(ls.get("space_topic", ""))}"></label></div>
        ${list("w-unis", unis())}${list("w-br", own.map(i => i.branch))}${list("w-tp", own.map(i => i.topic))}
        <label>Title <input name="title" required></label>
        <label>Text <small class="muted">(or load a .md / .txt file: <input type="file" accept=".md,.txt,.markdown" data-load></small>
          <textarea name="body" rows="16" required placeholder="# My title&#10;&#10;Write here…"></textarea></label>
        <button class="btn primary" type="submit">Save to My space</button>
      </form></section>`);
    el.querySelector("[data-load]").addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      el.querySelector("textarea").value = await f.text();
      if (!el.querySelector("[name=title]").value) el.querySelector("[name=title]").value = f.name.replace(/\.[^.]+$/, "");
    });
    el.querySelector(".sp-form").addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target), get = k => String(f.get(k) || "").trim();
      const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
      const id = newId(), meta = { title: get("title"), uni: get("uni"), branch: get("branch"), topic: get("topic"),
        date: new Date().toISOString().slice(0, 10), type: get("type") };
      let md = get("body");
      if (!/^#\s/m.test(md)) md = `# ${meta.title}\n\n` + md;
      try {
        await R().put("space:note:" + id, { v: 1, md, transcript: "", slides: [], meta });
        await saveItems({ id, kind: "note", ...meta, created: now() });
        ls.set("space_uni", meta.uni); ls.set("space_branch", meta.branch); ls.set("space_topic", meta.topic);
        location.hash = "#/space/" + id;
      } catch (err) { btn.disabled = false; btn.textContent = "Save to My space"; alert("Couldn't save: " + err.message); }
    });
  }

  // ---------- the World screen: search, filters, recommendations ----------
  function showExplore(params) {
    const all = catalog();
    const q = params.get("q") || "", f = { uni: params.get("uni") || "", subject: params.get("subject") || "", topic: params.get("topic") || "", type: params.get("type") || "" };
    const link = patch => { const p = new URLSearchParams({ q, ...f, ...patch }); for (const [k, v] of [...p]) if (!v) p.delete(k); const s = p.toString(); return "#/world" + (s ? "?" + s : ""); };
    let results = searchCatalog(all, q).filter(r => Object.entries(f).every(([k, v]) => !v || r.e[k] === v));
    if (!q) results.sort((a, b) => (b.e.date || "").localeCompare(a.e.date || ""));
    const facet = (key, label) => {
      const counts = {};
      for (const r of searchCatalog(all, q).filter(r => Object.entries(f).every(([k, v]) => k === key || !v || r.e[k] === v))) counts[r.e[key]] = (counts[r.e[key]] || 0) + 1;
      const keys = Object.keys(counts).sort();
      if (keys.length < 2 && !f[key]) return "";
      return `<div class="wx-facet"><span class="wx-flabel">${label}</span>${f[key] ? `<a class="wx-chip on" href="${link({ [key]: "" })}">${esc(f[key])} ✕</a>` :
        keys.map(k => `<a class="wx-chip" href="${link({ [key]: k })}">${esc(k)} <span>${counts[k]}</span></a>`).join("")}</div>`;
    };
    const card = r => {
      const e = r.e, saved = live().some(it => it.kind === "bookmark" && it.ref === e.ref);
      const snippet = highlight(e.summary, q);
      return `<article class="wx-card"><div class="wx-meta">${esc(e.uni)} › ${esc(e.subject)} › ${esc(e.topic)}${e.date ? ` · ${esc(e.date)}` : ""}</div>
        <h3><a href="${e.ref}">${highlight(e.title, q)}</a></h3>${snippet ? `<p>${snippet}</p>` : ""}
        <div class="wx-foot"><span class="sp-badge ${e.source === "Community" ? "" : "lib"}">${esc(e.source === "Community" ? e.type : "Library")}</span>${e.by ? `<span class="muted">by ${esc(e.by)}</span>` : ""}
        <span class="spacer"></span><button class="btn ghost" data-wx-save="${esc(e.ref)}" data-title="${esc(e.title)}">${saved ? "★ Saved" : "☆ Save"}</button></div></article>`;
    };
    const filtered = q || Object.values(f).some(Boolean);
    let body = "";
    if (filtered) body = `<p class="muted wx-count">${results.length} result${results.length === 1 ? "" : "s"}</p>` + (results.length ? results.slice(0, 60).map(card).join("") : `<p>Nothing found. Try fewer words or remove a filter.</p>`);
    else {
      const rec = recommend(all);
      body += rec.items.length ? `<h2 class="wx-h">Recommended for you</h2><p class="muted">Based on what you've saved, made and read recently.</p>${rec.items.map(card).join("")}`
        : `<h2 class="wx-h">Recommended for you</h2><p class="muted">Save notes (☆) or open a few lectures, and suggestions will appear here.</p>`;
      const fresh = all.filter(e => e.source === "Community").sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 6);
      if (fresh.length) body += `<h2 class="wx-h">New from the community</h2>${fresh.map(e => card({ e })).join("")}`;
      const byUni = {}; for (const e of all) (byUni[e.uni] ||= new Set()).add(e.subject);
      body += `<h2 class="wx-h">Browse by university</h2><div class="wx-unis">${Object.keys(byUni).sort().map(u => `<a class="wx-uni" href="${link({ uni: u })}"><strong>${esc(u)}</strong><span>${[...byUni[u]].sort().map(esc).join(" · ")}</span></a>`).join("")}</div>`;
    }
    const el = page(`<section class="wx"><form class="wx-search"><input name="q" type="search" value="${esc(q)}" placeholder="Search notes, lectures and material in the World…" autocomplete="off"><button class="btn primary">Search</button></form>
      <div class="wx-facets">${facet("uni", "University")}${facet("subject", "Subject")}${facet("topic", "Topic")}${facet("type", "Type")}</div>
      <div class="wx-results">${body}</div></section>`);
    const input = el.querySelector("input[name=q]");
    if (!q) input.focus();
    el.querySelector(".wx-search").addEventListener("submit", e => { e.preventDefault(); location.hash = link({ q: input.value.trim() }); });
    el.addEventListener("click", async e => {
      const b = e.target.closest("[data-wx-save]"); if (!b) return;
      const ref = b.dataset.wxSave, it = live().find(x => x.kind === "bookmark" && x.ref === ref);
      it ? await saveItems({ ...it, deleted: true }) : await saveItems({ id: "bm:" + ref, kind: "bookmark", ref, title: b.dataset.title });
      b.textContent = it ? "☆ Save" : "★ Saved";
    });
  }
  function highlight(text, q) {
    let h = esc(text || "");
    for (const w of words(q).sort((a, b) => b.length - a.length)) h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*)`, "gi"), "<mark class=\"wx-hit\">$1</mark>");
    return h;
  }

  // A star on library lectures, to keep them in My space.
  function decorateDoc(path) {
    if (!enabled() || !/\/notes(\.ru)?\.md$/.test(path)) return;
    const ref = "#/doc/" + V().enc(path), saved = live().find(it => it.kind === "bookmark" && it.ref === ref);
    const article = V().main.querySelector("article.notes");
    if (!article || V().main.querySelector(".sp-bar")) return;
    const title = (article.querySelector("h1")?.textContent || path.split("/").slice(-2, -1)[0]).replace("✏️", "").trim();
    recordVisit(ref, title);
    article.insertAdjacentHTML("beforebegin", `<div class="sp-bar"><span class="spacer"></span><button class="btn ${saved ? "" : "ghost"}" data-save-doc>${saved ? "★ In My space" : "☆ Save to My space"}</button></div>`);
    V().main.querySelector("[data-save-doc]").addEventListener("click", async () => {
      saved ? await saveItems({ ...saved, deleted: true }) : await saveItems({ id: "bm:" + path, kind: "bookmark", ref, title });
      V().main.querySelector(".sp-bar")?.remove(); decorateDoc(path);
    });
  }

  window.Space = { init, renderSidebar, markActive, route, home, decorateDoc, refresh };
})();
