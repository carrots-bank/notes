// Highlights, margin comments and own notes for the notes viewer, synced through the annotations worker
// (annotations_worker/). Everything is encrypted here before it leaves the browser.
//
// Keys: the person's bundle carries a personal secret "a" (site.py). HKDF-SHA256 (salt "lecture-notes-annotations")
// turns it into an access token ("token": the worker stores records under SHA-256(token)), an AES-GCM key ("enc")
// and an HMAC key ("doc") that names each document, so the worker sees neither paths nor content.
//
// Records: one per document, {v: 1, items: {id: item}}. An item is a highlight {kind: "hl", color, quote, comment},
// an own note {kind: "note", quote, text} or an edited section {kind: "edit", key, heading, md, base} (base = hash of
// the original section when it was edited, to spot later changes to the original); deleted items stay as tombstones
// so devices can merge by `updated`.
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
    if (doc.shell.querySelector("textarea, .sec-editing")) return;  // don't yank an open editor away
    paintSections();
    clear();
    const a = doc.article, live = Object.values(doc.items).filter(it => !it.deleted && it.kind !== "edit");
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
    const keys = new Set(doc.ctx.secs.map(x => x.key));
    const lostEdits = Object.values(doc.items).filter(it => it.kind === "edit" && !it.deleted && !keys.has(it.key));
    renderCards(live.filter(it => it.kind === "hl" && it.comment), [...orphans.map(o => o.it), ...lostEdits]);
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
    const q = it.kind === "edit" ? `Your edited section: ${it.heading}` : it.quote.exact;
    const quote = `<div class="annot-quote hl-${it.color || "yellow"}">${escH(q.slice(0, 140))}${q.length > 140 ? "…" : ""}</div>`;
    if (editing) {
      c.innerHTML = `${quote}<textarea rows="3" placeholder="Add a comment…">${escH(it.comment || "")}</textarea>
        <div class="annot-actions"><button class="btn primary" data-act="c-save">Save</button><button class="btn ghost" data-act="c-cancel">Cancel</button></div>`;
      setTimeout(() => c.querySelector("textarea").focus(), 0);
    } else {
      const body = it.kind === "note" ? md(it.text) : it.kind === "edit" ? md(it.md) : md(it.comment);
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
      (window.Donkey ? `<button data-act="ask" title="Ask the donkey about this">🫏</button>` : "") +
      (forMark ? `<button data-act="remove" title="Remove highlight">🗑</button>` : `<button data-act="note" title="Add my note below">📝</button>`);
    bar.hidden = false;
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const coarse = matchMedia("(pointer: coarse)").matches;  // phones: below the selection, clear of the OS menu
    let top = coarse ? rect.bottom + 10 : rect.top - bh - 8;
    if (top < 60) top = rect.bottom + 8;
    if (top + bh > innerHeight - 8) top = Math.max(60, rect.top - bh - 8);
    top = Math.min(Math.max(top, 60), innerHeight - bh - 8);
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
    if (anc.closest(".annot-ui, .sec-editing")) return null;
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
    if (act === "ask") {
      const quote = pending.id ? doc.items[pending.id].quote : pending.quote;
      const mk = pending.id && doc.article.querySelector(`mark[data-id="${pending.id}"]`);
      const r = !pending.id && getSelection().rangeCount && getSelection().getRangeAt(0);
      const node = mk || (r && r.startContainer);
      const el = node && (node.nodeType === 3 ? node.parentElement : node).closest("section.sec");
      getSelection().removeAllRanges(); hideBar(); pending = null;
      return window.Donkey.open({ quote, key: el?.dataset.key });
    }
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
  async function attach(path, article, ctx) {
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
    const d = { path, id: await docId(path), items: {}, updated: 0, article, shell, margin, fab, dirty: false, enabled: true,
                ctx, paintedSig: ctx.secs.map(() => "").join("|") };
    if (!article.isConnected) return;
    doc = d;
    d.observer = new ResizeObserver(() => layout());
    d.observer.observe(article);
    render();
    load(d);
  }
  window.addEventListener("beforeunload", () => { if (doc?.dirty) save(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && doc?.dirty) save(); });

  // ---------- editing sections ----------
  const fnv = str => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
  const secEl = key => doc.article.querySelector(`section.sec[data-key="${CSS.escape(key)}"]`);
  function edits() {
    const m = {};
    for (const it of Object.values(doc.items)) if (it.kind === "edit" && !it.deleted) m[it.key] = it;
    return m;
  }
  const effective = () => { const e = edits(); return doc.ctx.secs.map(x => e[x.key] ? { ...x, md: e[x.key].md, edit: e[x.key] } : x); };

  function paintSections() {
    const eff = effective();
    const sig = eff.map(x => x.edit ? x.edit.id + ":" + x.edit.updated : "").join("|");
    if (sig !== doc.paintedSig) { doc.ctx.render(doc.article, eff); doc.paintedSig = sig; }
    for (const x of eff) {
      const el = secEl(x.key);
      if (!el || x.key === "_top") continue;
      el.querySelectorAll(".sec-tools").forEach(t => t.remove());
      el.classList.toggle("sec-edited", !!x.edit);
      const tools = document.createElement("div");
      tools.className = "sec-tools annot-ui";
      const stale = x.edit && x.edit.base !== fnv(doc.ctx.secs.find(o => o.key === x.key).md);
      tools.innerHTML = (x.edit ? `<span class="sec-badge">edited</span>` : "") +
        (stale ? `<button class="sec-badge warn" data-act="sec-compare" title="The original notes changed after you edited this section">original updated</button>` : "") +
        `<button class="sec-edit" data-act="sec-edit" title="Edit this section">✏️</button>`;
      (el.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4") || el).append(tools);
    }
  }

  let td = null;
  function toMarkdown(el) {
    if (!td) {
      td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*" });
      if (window.turndownPluginGfm) td.use(turndownPluginGfm.gfm);
      td.addRule("img", { filter: "img", replacement: (c, n) => `![${n.getAttribute("alt") || ""}](${n.dataset.src || n.getAttribute("src") || ""})` });
      td.addRule("a", { filter: n => n.nodeName === "A" && (n.dataset.href || n.getAttribute("href")),
                        replacement: (c, n) => `[${c}](${n.dataset.href || n.getAttribute("href")})` });
      td.remove(["button", "script", "style"]);
    }
    return td.turndown(el.innerHTML).trim() + "\n\n";
  }

  const TOOLS = [["bold", "<b>B</b>", "Bold"], ["italic", "<i>I</i>", "Italic"], ["h3", "H", "Heading"], ["p", "¶", "Normal text"],
                 ["ul", "•", "Bullet list"], ["ol", "1.", "Numbered list"], ["quote", "❝", "Quote"], ["link", "🔗", "Link"],
                 ["clear", "⌫", "Clear formatting"]];
  function openEditor(key) {
    if (doc.shell.querySelector(".sec-editing")) return;
    hideBar(); pending = null;
    clear();
    const x = effective().find(o => o.key === key), el = secEl(key);
    el.classList.add("sec-editing");
    el.innerHTML = `<div class="sec-toolbar annot-ui">${TOOLS.map(([c, l, t]) => `<button data-cmd="${c}" title="${t}">${l}</button>`).join("")}
        <span class="spacer"></span><button data-cmd="mode" class="sec-mode" title="Switch between visual and Markdown">Markdown</button></div>
      <div class="sec-visual" contenteditable="true" spellcheck="true"></div>
      <textarea class="sec-md" hidden spellcheck="true"></textarea>
      <div class="sec-actions annot-ui"><button class="btn primary" data-act="sec-save">Save</button>
        <button class="btn ghost" data-act="sec-cancel">Cancel</button>
        ${x.edit ? `<span class="spacer"></span><button class="btn ghost" data-act="sec-restore">Restore original</button>` : ""}</div>`;
    const vis = el.querySelector(".sec-visual"), ta = el.querySelector(".sec-md");
    doc.ctx.render(vis, [{ key, md: x.md }], { forEdit: true });
    el._edit = { key, mode: "visual", touched: false, md: x.md };
    vis.addEventListener("input", () => (el._edit.touched = true));
    ta.addEventListener("input", () => (el._edit.touched = true));
    vis.addEventListener("paste", e => {  // paste as plain text, so nothing heavy or foreign lands in the notes
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    });
    const tb = el.querySelector(".sec-toolbar");
    let saved = null;  // the selection inside the editor, kept while a toolbar button is pressed
    const keep = () => { const sl = getSelection(); if (sl.rangeCount && vis.contains(sl.getRangeAt(0).commonAncestorContainer)) saved = sl.getRangeAt(0).cloneRange(); };
    vis.addEventListener("keyup", keep); vis.addEventListener("mouseup", keep);
    document.addEventListener("selectionchange", keep);
    el._unlisten = () => document.removeEventListener("selectionchange", keep);
    tb.addEventListener("mousedown", e => { e.preventDefault(); keep(); });
    tb.addEventListener("click", e => {
      const c = e.target.closest("[data-cmd]")?.dataset.cmd;
      if (!c) return;
      if (c === "mode") return switchMode(el);
      if (el._edit.mode !== "visual") return;
      vis.focus();
      if (saved) { const sl = getSelection(); sl.removeAllRanges(); sl.addRange(saved); }
      const run = (cmd, arg) => document.execCommand(cmd, false, arg);
      ({ bold: () => run("bold"), italic: () => run("italic"), h3: () => run("formatBlock", "h3"), p: () => run("formatBlock", "p"),
         ul: () => run("insertUnorderedList"), ol: () => run("insertOrderedList"), quote: () => run("formatBlock", "blockquote"),
         clear: () => run("removeFormat"),
         link: () => { const u = prompt("Link address (https://…)"); if (u) run("createLink", u); } })[c]?.();
      el._edit.touched = true;
    });
    el.scrollIntoView({ block: "nearest" });
    vis.focus();
  }
  function switchMode(el) {
    const ed = el._edit, vis = el.querySelector(".sec-visual"), ta = el.querySelector(".sec-md");
    if (ed.mode === "visual") {
      ta.value = ed.touched ? toMarkdown(vis.firstElementChild || vis) : ed.md;
      ed.mode = "md"; vis.hidden = true; ta.hidden = false;
      ta.style.height = Math.max(200, ta.scrollHeight + 20) + "px";
      ta.focus();
    } else {
      ed.md = ta.value;
      doc.ctx.render(vis, [{ key: ed.key, md: ed.md }], { forEdit: true });
      ed.mode = "visual"; ta.hidden = true; vis.hidden = false; vis.focus();
    }
    el.querySelector(".sec-mode").textContent = ed.mode === "visual" ? "Markdown" : "Visual";
    el.querySelectorAll(".sec-toolbar [data-cmd]:not([data-cmd=mode])").forEach(b => (b.disabled = ed.mode !== "visual"));
  }
  function endEdit(el) { el._unlisten?.(); el.classList.remove("sec-editing"); delete el._edit; el.innerHTML = ""; doc.paintedSig = null; }
  function closeEditor(el) { endEdit(el); render(); }
  function saveEditor(el) {
    const ed = el._edit, orig = doc.ctx.secs.find(o => o.key === ed.key);
    if (!ed.touched) return closeEditor(el);
    let out = ed.mode === "md" ? el.querySelector(".sec-md").value : toMarkdown(el.querySelector(".sec-visual").firstElementChild || el.querySelector(".sec-visual"));
    out = out.replace(/\s+$/, "") + "\n\n";
    const id = "edit:" + ed.key, prev = doc.items[id];
    if (out.trim() === orig.md.trim()) doc.items[id] = { id, deleted: true, updated: now() };
    else doc.items[id] = { id, kind: "edit", key: ed.key, heading: orig.heading, md: out, base: fnv(orig.md),
                           created: prev?.created || now(), updated: now() };
    endEdit(el);
    changed();
  }
  function compare(key) {
    const el = secEl(key), orig = doc.ctx.secs.find(o => o.key === key);
    if (!el || el.querySelector(".sec-compare")) return;
    const box = document.createElement("div");
    box.className = "sec-compare annot-ui";
    box.innerHTML = `<div class="annot-label">The original version of this section has changed since you edited it. Here it is now:</div>
      <div class="sec-compare-body"></div>
      <div class="annot-actions"><button class="btn primary" data-act="sec-keep">Keep my version</button>
        <button class="btn ghost" data-act="sec-take">Use the new original</button>
        <button class="btn ghost" data-act="sec-compare-close">Close</button></div>`;
    doc.ctx.render(box.querySelector(".sec-compare-body"), [orig]);
    (el.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4") || el.firstElementChild).after(box);
  }

  document.addEventListener("click", e => {
    if (!doc) return;
    const b = e.target.closest("[data-act^=sec-]");
    if (!b || !doc.article.contains(b)) return;
    const el = b.closest("section.sec"), key = el?.dataset.key, id = "edit:" + key;
    e.preventDefault();
    switch (b.dataset.act) {
      case "sec-edit": return openEditor(key);
      case "sec-save": return saveEditor(el);
      case "sec-cancel": return closeEditor(el);
      case "sec-restore":
        if (!confirm("Restore the original text of this section? Your version will be removed.")) return;
        doc.items[id] = { id, deleted: true, updated: now() }; endEdit(el); return changed();
      case "sec-compare": return compare(key);
      case "sec-compare-close": return b.closest(".sec-compare").remove();
      case "sec-keep": doc.items[id] = { ...doc.items[id], base: fnv(doc.ctx.secs.find(o => o.key === key).md), updated: now() }; return changed();
      case "sec-take": doc.items[id] = { id, deleted: true, updated: now() }; return changed();
    }
  });

  // ---------- API for the 🫏 assistant (donkey.js) ----------
  function quoteOfElement(el) {
    const idx = textIndex(doc.article);
    const inside = idx.nodes.filter(e => el.contains(e.node) && e.node.data.trim());
    if (!inside.length) return null;
    const s = inside[0].start, last = inside.at(-1), e = last.start + last.node.data.length;
    return quoteAt(idx.text, s, e);
  }
  const heading = key => secEl(key)?.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4");
  const donkeyApi = {
    ready: () => !!doc,
    relayAuth: () => ({ url: API, token: TOKEN }),
    path: () => doc?.path,
    title: () => doc?.article.querySelector("h1")?.childNodes[0]?.textContent?.trim() || doc?.path,
    notes: () => effective().map(x => x.md).join(""),
    sections: () => effective().map(x => ({ key: x.key, heading: x.heading })),
    load: name => doc?.ctx.load ? doc.ctx.load(name) : Promise.resolve(null),
    sectionInView() {  // the section whose heading is the last one above the top third of the screen
      let best = null;
      for (const el of doc.article.querySelectorAll(":scope > section.sec")) {
        if (el.getBoundingClientRect().top < innerHeight / 3) best = el.dataset.key; else break;
      }
      return best && best !== "_top" ? best : doc.ctx.secs.find(x => x.key !== "_top")?.key;
    },
    sectionHeading: key => doc.ctx.secs.find(x => x.key === key)?.heading || "",
    // Keep an answer as a side comment on the selected passage (or on the section heading).
    addComment(quote, key, text) {
      quote = quote || (heading(key) && quoteOfElement(heading(key)));
      if (!quote) return false;
      const id = newId();
      doc.items[id] = { id, kind: "hl", color: "blue", quote, comment: text, created: now(), updated: now() };
      changed();
      setTimeout(() => openDrawer(id), 50);
      return true;
    },
    // Keep an answer as one of the yellow "My note" boxes, under the passage (or under the section heading).
    addNote(quote, key, text) {
      quote = quote || (heading(key) && quoteOfElement(heading(key)));
      if (!quote) return false;
      const id = newId();
      doc.items[id] = { id, kind: "note", quote, text, created: now(), updated: now() };
      changed();
      return true;
    },
    // Weave an answer into the person's own version of the section, after the paragraph it is about.
    insertIntoSection(key, anchorText, text) {
      const x = effective().find(o => o.key === key), orig = doc.ctx.secs.find(o => o.key === key);
      if (!x) return false;
      const norm = t => t.replace(/[*_`#>\[\]()!\\|]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const paras = x.md.replace(/\s+$/, "").split(/\n{2,}/);
      const probe = anchorText ? norm(anchorText).slice(0, 40) : "";
      let at = probe ? paras.findIndex(p => norm(p).includes(probe)) : -1;
      if (at < 0) at = paras.length - 1;
      paras.splice(at + 1, 0, `*🫏 Added by AI:*\n\n${text.trim()}`);
      const id = "edit:" + key, prev = doc.items[id];
      doc.items[id] = { id, kind: "edit", key, heading: orig.heading, md: paras.join("\n\n") + "\n\n", base: fnv(orig.md),
                        created: prev?.created || now(), updated: now() };
      changed();
      setTimeout(() => secEl(key)?.scrollIntoView({ block: "start", behavior: "smooth" }), 100);
      return true;
    },
  };

  // ---------- general encrypted records (used by space.js for a person's own notes, index and images) ----------
  async function sealJSON(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ENC, enc.encode(JSON.stringify(value)));
    return b64e(iv) + "." + b64e(ct);
  }
  async function openJSON(data) {
    const [iv, ct] = data.split(".").map(b64d);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ENC, ct)));
  }
  async function recCall(path, method, body) {
    const id = await docId(path);
    const r = await fetch(`${API}/v1/doc/${id}`, { method, cache: "no-store",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) throw new Error(j.error || "storage " + r.status);
    return { status: r.status, ...j };
  }
  const records = {
    ready: async () => !!(await ready),
    async get(path) {
      const r = await recCall(path, "GET");
      return { value: r.data ? await openJSON(r.data) : null, updated: r.updated || 0 };
    },
    // Write `value`; if someone else saved since `base`, call merge(theirs) and retry.
    async put(path, value, base = null, merge = null) {
      if (base === null) {
        const cur = await recCall(path, "GET");
        base = cur.updated || 0;
        if (merge && cur.data) value = merge(await openJSON(cur.data), value);  // keep changes from other devices
      }
      for (let i = 0; i < 4; i++) {
        const r = await recCall(path, "PUT", { data: await sealJSON(value), base });
        if (r.status !== 409) return { updated: r.updated, value };
        const theirs = await openJSON(r.data);
        base = r.updated;
        if (!merge) throw new Error("conflict");
        value = merge(theirs, value);
      }
      throw new Error("Couldn't save: too many conflicting saves");
    },
    async remove(path) { await this.put(path, { deleted: true }); },
  };

  window.Annotate = { init, attach, api: donkeyApi, records };
})();
