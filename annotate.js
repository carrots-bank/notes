// Highlights, margin comments and own notes for the notes viewer, synced through the annotations worker
// (annotations_worker/). Everything is encrypted here before it leaves the browser.
//
// Keys: the person's bundle carries a personal secret "a" (site.py). HKDF-SHA256 (salt "lecture-notes-annotations")
// turns it into an access token ("token": the worker stores records under SHA-256(token)), an AES-GCM key ("enc")
// and an HMAC key ("doc") that names each document, so the worker sees neither paths nor content.
//
// Records: one per document, {v: 1, items: {id: item}}. An item is a highlight {kind: "hl", color, quote, comment}
// or an own note {kind: "note", quote, text}; deleted items stay as tombstones so devices can merge by `updated`.
// A quote is {exact, prefix, suffix, start} over the article's text, so annotations survive small edits to notes.
(() => {
  const COLORS = ["yellow", "green", "pink", "blue"];
  const SALT = new TextEncoder().encode("lecture-notes-annotations");
  const enc = new TextEncoder(), dec = new TextDecoder();
  const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = s => DOMPurify.sanitize(marked.parse(s || ""));
  const ls = {
    get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let API = "", TOKEN = "", ENC = null, DOCKEY = null, ready = null, missingSecret = false;
  let doc = null;  // {path, id, items, updated, article, shell, margin, dirty, saving}

  // ---------- keys and storage ----------
  function init(secret, url) {
    API = (url || "").replace(/\/$/, "");
    missingSecret = !!API && !secret;
    ready = (async () => {
      if (!secret || !API) return false;
      const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
      const bits = info => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: SALT, info: enc.encode(info) }, base, 256);
      TOKEN = toHex(await bits("token"));
      ENC = await crypto.subtle.importKey("raw", await bits("enc"), "AES-GCM", false, ["encrypt", "decrypt"]);
      DOCKEY = await crypto.subtle.importKey("raw", await bits("doc"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return true;
    })().catch(() => false);
  }
  const docId = async path => toHex(await crypto.subtle.sign("HMAC", DOCKEY, enc.encode(path))).slice(0, 32);
  async function seal(items) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ENC, enc.encode(JSON.stringify({ v: 1, items })));
    return b64e(iv) + "." + b64e(ct);
  }
  async function open(data) {
    if (!data) return {};
    const [iv, ct] = data.split(".").map(b64d);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ENC, ct))).items || {};
  }
  function merge(a, b) {
    const out = { ...a };
    for (const [id, it] of Object.entries(b)) if (!out[id] || (it.updated || 0) > (out[id].updated || 0)) out[id] = it;
    return out;
  }
  async function api(method, body) {
    const r = await fetch(`${API}/v1/doc/${doc.id}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) throw new Error(j.error || r.status);
    return { status: r.status, ...j };
  }
  const cacheKey = () => "annot:" + doc.id;
  async function cache() { ls.set(cacheKey(), { data: await seal(doc.items), updated: doc.updated, dirty: doc.dirty }); }

  async function load(d) {
    const c = ls.get(cacheKey());
    if (c) {
      try { d.items = await open(c.data); d.updated = c.updated || 0; d.dirty = !!c.dirty; } catch {}
      if (doc === d) render();
    }
    try {
      const r = await api("GET");
      if (doc !== d) return;
      d.items = merge(d.items, await open(r.data));
      if (!d.dirty) d.updated = r.updated || 0;
      else if (r.updated !== d.updated) d.updated = r.updated || 0;  // our pending changes are merged on save
      render();
      if (d.dirty) save();
      else cache();
    } catch { if (doc === d) status(d.dirty ? "offline" : ""); }
  }

  let timer = null;
  function changed() {
    doc.dirty = true;
    cache();
    render();
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  }
  async function save() {
    const d = doc;
    if (!d || d.saving || !d.dirty) return;
    d.saving = true;
    status("saving");
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sent = d.items;
        const r = await api("PUT", { data: await seal(sent), base: d.updated });
        if (r.status === 409) {  // another device saved first: merge and try again
          d.items = merge(await open(r.data), d.items);
          d.updated = r.updated;
          if (doc === d) render();
          continue;
        }
        d.updated = r.updated;
        if (d.items === sent) d.dirty = false;
        break;
      }
      status(d.dirty ? "saving" : "saved");
    } catch { status("offline"); }
    d.saving = false;
    if (doc === d) await cache();
    if (d.dirty && doc === d) { clearTimeout(timer); timer = setTimeout(save, 3000); }
  }
  window.addEventListener("online", () => doc?.dirty && save());

  // ---------- text positions ----------
  const SKIP_PARENTS = new Set(["TABLE", "TBODY", "THEAD", "TFOOT", "TR", "UL", "OL"]);
  function textIndex(root) {
    const nodes = [], map = new Map();
    let text = "";
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest(".annot-ui") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n; (n = w.nextNode());) {
      const e = { node: n, start: text.length };
      nodes.push(e); map.set(n, e); text += n.data;
    }
    return { nodes, map, text };
  }
  function offsetOf(idx, container, offset) {
    if (container.nodeType === 3) { const e = idx.map.get(container); return e ? e.start + offset : -1; }
    const probe = document.createRange();
    probe.setStart(container, offset);
    for (const e of idx.nodes) if (probe.comparePoint(e.node, 0) >= 0) return e.start;
    return idx.text.length;
  }
  function quoteAt(text, s, e) {
    return { exact: text.slice(s, e), prefix: text.slice(Math.max(0, s - 32), s), suffix: text.slice(e, e + 32), start: s };
  }
  function locate(text, q) {
    if (!q?.exact) return -1;
    let best = -1, bestScore = -Infinity;
    for (let i = text.indexOf(q.exact); i !== -1; i = text.indexOf(q.exact, i + 1)) {
      let score = 0;
      const pre = text.slice(Math.max(0, i - q.prefix.length), i), suf = text.slice(i + q.exact.length, i + q.exact.length + q.suffix.length);
      for (let k = 1; k <= Math.min(pre.length, q.prefix.length) && pre.at(-k) === q.prefix.at(-k); k++) score += 2;
      for (let k = 0; k < Math.min(suf.length, q.suffix.length) && suf[k] === q.suffix[k]; k++) score += 2;
      score -= Math.abs(i - (q.start || 0)) / 2000;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }
  function wrap(root, s, e, make) {
    const idx = textIndex(root), marks = [];
    for (const { node, start } of idx.nodes) {
      const end = start + node.data.length;
      if (end <= s || start >= e) continue;
      if (SKIP_PARENTS.has(node.parentElement.tagName) && !node.data.trim()) continue;
      let n = node;
      if (s > start) n = n.splitText(s - start);
      if (e < end) n.splitText(e - Math.max(s, start));
      const m = make();
      n.replaceWith(m);
      m.append(n);
      marks.push(m);
    }
    return marks;
  }

  // ---------- rendering ----------
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, .table-wrap";
  const wide = () => doc && doc.shell.clientWidth >= 780 + 280 + 40;

  function clear() {
    const a = doc.article;
    a.querySelectorAll("mark.hl").forEach(m => m.replaceWith(...m.childNodes));
    a.querySelectorAll(".my-note").forEach(n => n.remove());
    a.normalize();
  }
  function render() {
    if (!doc) return;
    if (doc.shell.querySelector("textarea")) return;  // don't yank an open editor away; render again when it closes
    clear();
    const a = doc.article, live = Object.values(doc.items).filter(it => !it.deleted);
    const text = textIndex(a).text, placed = [], orphans = [];
    for (const it of live) {
      const at = locate(text, it.quote);
      (at < 0 ? orphans : placed).push({ it, at });
    }
    placed.sort((x, y) => y.at - x.at);  // back to front, so offsets stay valid
    for (const { it, at } of placed) {
      if (it.kind === "hl") {
        wrap(a, at, at + it.quote.exact.length, () => {
          const m = document.createElement("mark");
          m.className = `hl hl-${it.color || "yellow"}${it.comment ? " has-comment" : ""}`;
          m.dataset.id = it.id;
          return m;
        });
      } else if (it.kind === "note") {
        const idx = textIndex(a);
        const hit = idx.nodes.find(e => e.start <= at && at < e.start + e.node.data.length) || idx.nodes.at(-1);
        const block = hit?.node.parentElement.closest(BLOCKS);
        if (!block) { orphans.push({ it }); continue; }
        const box = noteBox(it);
        if (block.tagName === "LI") block.append(box); else block.after(box);
      }
    }
    renderCards(live.filter(it => it.kind === "hl" && it.comment), orphans.map(o => o.it));
    layout();
  }

  function noteBox(it, editing = false) {
    const box = document.createElement("aside");
    box.className = "my-note annot-ui";
    box.dataset.id = it.id;
    if (editing) {
      box.innerHTML = `<div class="annot-label">My note</div><textarea rows="4" placeholder="Write your note… (Markdown works)">${escH(it.text)}</textarea>
        <div class="annot-actions"><button class="btn primary" data-act="note-save">Save</button><button class="btn ghost" data-act="note-cancel">Cancel</button></div>`;
      setTimeout(() => box.querySelector("textarea").focus(), 0);
    } else {
      box.innerHTML = `<div class="annot-label">My note <span class="annot-meta">${when(it.updated)}</span></div>
        <div class="my-note-body">${md(it.text)}</div>
        <div class="annot-actions"><button class="btn ghost" data-act="note-edit">Edit</button><button class="btn ghost" data-act="note-del">Delete</button></div>`;
    }
    return box;
  }

  function renderCards(withComments, orphans) {
    const m = doc.margin;
    m.innerHTML = `<div class="annot-drawer-head"><strong>Comments</strong><button class="icon" data-act="drawer-close" aria-label="Close">✕</button></div>`;
    for (const it of withComments) m.append(card(it));
    if (orphans.length) {
      const h = document.createElement("div");
      h.className = "annot-orphans-head";
      h.textContent = "Detached (the text changed)";
      m.append(h);
      for (const it of orphans) m.append(card(it, true));
    }
    if (!withComments.length && !orphans.length) m.insertAdjacentHTML("beforeend", `<p class="muted annot-empty">Select text and press 💬 to comment.</p>`);
    doc.fab.hidden = wide() || !(withComments.length + orphans.length);
    doc.fab.textContent = `💬 ${withComments.length + orphans.length}`;
  }
  function card(it, orphan = false, editing = false) {
    const c = document.createElement("div");
    c.className = "annot-card" + (orphan ? " orphan" : "");
    c.dataset.id = it.id;
    const quote = `<div class="annot-quote hl-${it.color || "yellow"}">${escH(it.quote.exact.slice(0, 140))}${it.quote.exact.length > 140 ? "…" : ""}</div>`;
    if (editing) {
      c.innerHTML = `${quote}<textarea rows="3" placeholder="Add a comment…">${escH(it.comment || "")}</textarea>
        <div class="annot-actions"><button class="btn primary" data-act="c-save">Save</button><button class="btn ghost" data-act="c-cancel">Cancel</button></div>`;
      setTimeout(() => c.querySelector("textarea").focus(), 0);
    } else {
      const body = it.kind === "note" ? md(it.text) : md(it.comment);
      c.innerHTML = `${quote}<div class="annot-body">${body}</div><div class="annot-meta">${when(it.updated)}</div>
        <div class="annot-actions">${orphan ? "" : `<button class="btn ghost" data-act="c-edit">Edit</button>`}
        <button class="btn ghost" data-act="${orphan ? "item-del" : "c-del"}">Delete</button></div>`;
    }
    return c;
  }
  const when = t => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";

  function layout() {
    if (!doc) return;
    const isWide = wide();
    doc.shell.classList.toggle("annot-wide", isWide);
    doc.fab.hidden = isWide || !doc.margin.querySelector(".annot-card");
    if (!isWide) { doc.margin.querySelectorAll(".annot-card").forEach(c => (c.style.top = "")); return; }
    const base = doc.margin.getBoundingClientRect().top;
    let y = 0;
    const cards = [...doc.margin.querySelectorAll(".annot-card:not(.orphan)")].map(c => {
      const mk = doc.article.querySelector(`mark[data-id="${c.dataset.id}"]`);
      return { c, top: mk ? mk.getBoundingClientRect().top - base : 0 };
    }).sort((p, q) => p.top - q.top);
    for (const { c, top } of cards) { y = Math.max(top, y); c.style.top = y + "px"; y += c.offsetHeight + 10; }
    for (const c of doc.margin.querySelectorAll(".annot-card.orphan, .annot-orphans-head")) { c.style.top = y + "px"; y += c.offsetHeight + 10; }
    doc.margin.style.minHeight = y + "px";
  }

  // ---------- status ----------
  let statusTimer = null;
  function status(kind) {
    const el = document.getElementById("annot-status");
    if (!el) return;
    const text = { saving: "Saving…", saved: "Saved", offline: "Offline: kept on this device, will sync later", "": "" }[kind] ?? kind;
    el.textContent = text;
    el.hidden = !text;
    el.className = "annot-status annot-ui " + kind;
    clearTimeout(statusTimer);
    if (kind === "saved") statusTimer = setTimeout(() => (el.hidden = true), 1500);
  }

  // ---------- toolbar ----------
  const bar = document.createElement("div");
  bar.className = "annot-bar annot-ui";
  bar.hidden = true;
  document.addEventListener("DOMContentLoaded", () => document.body.append(bar));
  let pending = null;  // {quote} for a new selection, or {id} for an existing highlight

  function showBar(rect, forMark) {
    bar.innerHTML = COLORS.map(c => `<button class="swatch hl-${c}" data-act="color" data-color="${c}" title="Highlight ${c}"></button>`).join("") +
      `<button data-act="comment" title="Comment">💬</button>` +
      (forMark ? `<button data-act="remove" title="Remove highlight">🗑</button>` : `<button data-act="note" title="Add my note below">📝</button>`);
    bar.hidden = false;
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const coarse = matchMedia("(pointer: coarse)").matches;  // phones: below the selection, clear of the OS menu
    let top = coarse ? rect.bottom + 10 : rect.top - bh - 8;
    if (top < 60) top = rect.bottom + 8;
    if (top + bh > innerHeight - 8) top = Math.max(60, rect.top - bh - 8);
    const left = Math.min(innerWidth - bw - 8, Math.max(8, rect.left + rect.width / 2 - bw / 2));
    bar.style.top = top + "px";
    bar.style.left = left + "px";
  }
  const hideBar = () => { bar.hidden = true; };

  function selectionQuote() {
    const sel = getSelection();
    if (!doc || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!doc.article.contains(r.commonAncestorContainer)) return null;
    const anc = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentElement : r.commonAncestorContainer;
    if (anc.closest(".annot-ui")) return null;
    const idx = textIndex(doc.article);
    let s = offsetOf(idx, r.startContainer, r.startOffset), e = offsetOf(idx, r.endContainer, r.endOffset);
    if (s < 0 || e < 0) return null;
    while (s < e && /\s/.test(idx.text[s])) s++;
    while (e > s && /\s/.test(idx.text[e - 1])) e--;
    if (e - s < 1) return null;
    return { quote: quoteAt(idx.text, s, e), rect: r.getBoundingClientRect() };
  }

  let selTimer = null;
  function onSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (!doc || !doc.enabled) return;
      if (bar.contains(document.activeElement)) return;
      const q = selectionQuote();
      if (q) { pending = { quote: q.quote }; showBar(q.rect, false); }
      else if (!pending?.id) hideBar();
    }, 250);
  }
  document.addEventListener("selectionchange", onSelection);
  document.addEventListener("mouseup", onSelection);

  const now = () => Date.now();
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

  bar.addEventListener("mousedown", e => e.preventDefault());  // keep the text selection while clicking
  bar.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || !doc || !pending) return;
    const act = b.dataset.act;
    if (pending.id) {
      const it = doc.items[pending.id];
      if (act === "color") doc.items[it.id] = { ...it, color: b.dataset.color, updated: now() };
      if (act === "remove") doc.items[it.id] = { id: it.id, deleted: true, updated: now() };
      if (act === "comment") { hideBar(); pending = null; return editComment(it.id); }
    } else {
      const base = { id: newId(), quote: pending.quote, created: now(), updated: now() };
      if (act === "color") doc.items[base.id] = { ...base, kind: "hl", color: b.dataset.color };
      if (act === "comment") {
        doc.items[base.id] = { ...base, kind: "hl", color: "yellow", comment: "" };
        getSelection().removeAllRanges(); hideBar(); pending = null;
        changed();
        return editComment(base.id, true);
      }
      if (act === "note") {
        const it = { ...base, kind: "note", text: "" };
        getSelection().removeAllRanges(); hideBar(); pending = null;
        return editNote(it, true);
      }
      getSelection().removeAllRanges();
    }
    hideBar(); pending = null;
    changed();
  });

  // ---------- comments and notes ----------
  function openDrawer(id) {
    if (!doc) return;
    if (!wide()) { doc.margin.classList.add("open"); document.body.classList.add("annot-drawer-open"); }
    const c = id && doc.margin.querySelector(`.annot-card[data-id="${id}"]`);
    if (c) { focusItem(id); c.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
  function closeDrawer() { doc?.margin.classList.remove("open"); document.body.classList.remove("annot-drawer-open"); }
  function focusItem(id) {
    doc.article.querySelectorAll("mark.active").forEach(m => m.classList.remove("active"));
    doc.margin.querySelectorAll(".annot-card.active").forEach(m => m.classList.remove("active"));
    if (!id) return;
    doc.article.querySelectorAll(`mark[data-id="${id}"]`).forEach(m => m.classList.add("active"));
    doc.margin.querySelector(`.annot-card[data-id="${id}"]`)?.classList.add("active");
  }
  function editComment(id, fresh = false) {
    const it = doc.items[id];
    let c = doc.margin.querySelector(`.annot-card[data-id="${id}"]`);
    const ed = card(it, false, true);
    ed.dataset.fresh = fresh ? "1" : "";
    if (c) c.replaceWith(ed); else doc.margin.querySelector(".annot-drawer-head").after(ed);
    doc.margin.querySelector(".annot-empty")?.remove();
    layout();
    openDrawer(id);
  }
  function editNote(it, fresh = false) {
    let box = doc.article.querySelector(`.my-note[data-id="${it.id}"]`);
    const ed = noteBox(it, true);
    ed.dataset.fresh = fresh ? "1" : "";
    ed._item = it;
    if (box) { box.replaceWith(ed); return; }
    const idx = textIndex(doc.article), at = locate(idx.text, it.quote);
    const hit = idx.nodes.find(e => e.start <= at && at < e.start + e.node.data.length);
    const block = hit?.node.parentElement.closest(BLOCKS);
    if (block?.tagName === "LI") block.append(ed); else (block || doc.article).after(ed);
  }

  document.addEventListener("click", e => {
    if (!doc) return;
    const b = e.target.closest("[data-act]");
    if (b && (doc.margin.contains(b) || doc.article.contains(b) || doc.fab === b)) {
      const holder = b.closest("[data-id]"), id = holder?.dataset.id, it = id && doc.items[id];
      switch (b.dataset.act) {
        case "drawer-close": return closeDrawer();
        case "fab": return openDrawer();
        case "c-edit": return editComment(id);
        case "c-cancel": holder.querySelector("textarea").remove(); return render();  // a fresh one stays a highlight
        case "c-save": {
          const v = holder.querySelector("textarea").value.trim();
          doc.items[id] = { ...it, comment: v, updated: now() };
          holder.querySelector("textarea").remove();  // let render() run
          return changed();
        }
        case "c-del": doc.items[id] = { ...it, comment: "", updated: now() }; return changed();
        case "item-del": doc.items[id] = { id, deleted: true, updated: now() }; return changed();
        case "note-edit": return editNote(it);
        case "note-cancel": holder.querySelector("textarea").remove(); return render();
        case "note-save": {
          const v = holder.querySelector("textarea").value.trim(), base = holder._item || it;
          holder.querySelector("textarea").remove();
          if (!v) { if (!holder.dataset.fresh) doc.items[base.id] = { id: base.id, deleted: true, updated: now() }; else return render(); }
          else doc.items[base.id] = { ...base, text: v, updated: now() };
          return changed();
        }
        case "note-del": doc.items[id] = { id, deleted: true, updated: now() }; return changed();
      }
      return;
    }
    const card = e.target.closest(".annot-card");
    if (card && doc.margin.contains(card)) {
      focusItem(card.dataset.id);
      const mk = doc.article.querySelector(`mark[data-id="${card.dataset.id}"]`);
      if (mk) { mk.scrollIntoView({ block: "center", behavior: "smooth" }); if (!wide()) closeDrawer(); }
      return;
    }
    const mk = e.target.closest("mark.hl");
    if (mk && doc.article.contains(mk) && getSelection().isCollapsed && !e.target.closest("a")) {
      const it = doc.items[mk.dataset.id];
      if (!it) return;
      focusItem(it.id);
      pending = { id: it.id };
      showBar(mk.getBoundingClientRect(), true);
      if (it.comment) openDrawer(it.id);
      return;
    }
    if (!bar.contains(e.target)) { if (pending?.id) { hideBar(); pending = null; } focusItem(null); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { hideBar(); pending = null; closeDrawer(); } });
  addEventListener("resize", () => layout());

  // ---------- attach to a rendered document ----------
  async function attach(path, article) {
    if (doc) { if (doc.dirty) save(); doc.observer?.disconnect(); }
    doc = null;
    hideBar(); pending = null;
    document.body.classList.remove("annot-drawer-open");
    if (!article || !API) return;
    if (missingSecret) {
      article.insertAdjacentHTML("afterbegin", `<p class="annot-hint annot-ui">Highlighting and comments are now available: press <strong>Lock</strong> and sign in again to turn them on.</p>`);
      return;
    }
    if (!(await ready)) return;
    if (!path.endsWith(".md") || /(^|\/)README\.md$/.test(path)) return;  // annotate lectures, not index pages
    const shell = document.createElement("div");
    shell.className = "annot-shell";
    article.before(shell);
    const margin = document.createElement("aside");
    margin.className = "annot-margin annot-ui";
    const fab = document.createElement("button");
    fab.className = "annot-fab btn annot-ui";
    fab.dataset.act = "fab";
    fab.hidden = true;
    let st = document.getElementById("annot-status");
    if (!st) { st = document.createElement("div"); st.id = "annot-status"; st.hidden = true; document.body.append(st); }
    shell.append(article, margin, fab);
    const d = { path, id: await docId(path), items: {}, updated: 0, article, shell, margin, fab, dirty: false, enabled: true };
    if (!article.isConnected) return;
    doc = d;
    d.observer = new ResizeObserver(() => layout());
    d.observer.observe(article);
    render();
    load(d);
  }
  window.addEventListener("beforeunload", () => { if (doc?.dirty) save(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && doc?.dirty) save(); });

  window.Annotate = { init, attach };
})();
