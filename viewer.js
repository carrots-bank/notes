// Viewer for the encrypted library (annotations: annotate.js) (see lecturenotes/site.py for the format).
// Every file is nonce(12) || AES-256-GCM ciphertext. site.json holds one key bundle per person, each wrapped under
// PBKDF2-SHA256(password, salt): {"k": shared key, "x": [[index id, key], …]} where "x" lists the restricted
// courses that person may open (each with its own encrypted index). We try each bundle with the given password.
const $ = (s, el = document) => el.querySelector(s);
const main = $("#main"), sidebar = $("#sidebar");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = p => p.split("/").map(encodeURIComponent).join("/");
const KEY_STORE = "notes_key";
let MANIFEST = null;
let SITE = null;  // site.json (salt, wrapped keys, optional annotations URL)
let BUNDLE = null;  // this person's unlocked key bundle (k shared, x restricted, a personal, w world, m own courses)
// My space / World are switched on per person (bundle.sp) while they are being tried out.
const SP = () => (window.Space && BUNDLE?.sp ? window.Space : null);
const FILE_KEY = {};  // path -> CryptoKey
const blobUrls = new Map();

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(password, site) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(site.salt), iterations: site.iterations }, base, 256);
  const kek = await importKey(new Uint8Array(bits));
  for (const w of site.keys) {
    const b = b64(w);
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, kek, b.slice(12))); }
    catch {}
  }
  throw new Error("wrong password");
}
const importKey = raw => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);

async function fetchBlob(id, key) {
  const r = await fetch(`d/${id}.bin`, { cache: "no-cache" });
  if (!r.ok) throw new Error("Missing file");
  const b = new Uint8Array(await r.arrayBuffer());
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12));
}
const fetchFile = path => fetchBlob(MANIFEST.files[path], FILE_KEY[path]);
async function readText(path) {
  if (!MANIFEST.files[path]) throw new Error("Not found: " + path);
  return new TextDecoder().decode(await fetchFile(path));
}
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
                svg: "image/svg+xml", pdf: "application/pdf" };
async function fileUrl(path) {
  if (blobUrls.has(path)) return blobUrls.get(path);
  const type = TYPES[path.split(".").pop().toLowerCase()] || "application/octet-stream";
  const url = URL.createObjectURL(new Blob([await fetchFile(path)], { type }));
  blobUrls.set(path, url);
  return url;
}

// ---------- unlock ----------
const hex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
async function unlockWith(raw) {
  // raw is a JSON key bundle (or, from older sites, a bare 32-byte shared key)
  const bundle = raw.length === 32 ? { k: null, x: [] } : JSON.parse(new TextDecoder().decode(raw));
  const parts = [["manifest", await importKey(bundle.k ? hex(bundle.k) : raw)]];
  window.Annotate?.init(bundle.a ? hex(bundle.a) : null, SITE?.annotations || "");
  BUNDLE = bundle;
  for (const [id, k] of bundle.x) parts.push([id, await importKey(hex(k))]);
  const merged = { files: {}, tree: [] };
  for (const [id, key] of parts) {
    const m = JSON.parse(new TextDecoder().decode(await fetchBlob(id, key)));
    for (const [p, fid] of Object.entries(m.files)) { merged.files[p] = fid; FILE_KEY[p] = key; }
    merged.tree.push(...m.tree.map(c => id === "manifest" ? c : { ...c, restricted: true }));
  }
  MANIFEST = merged;
}
async function start() {
  try { SITE = await (await fetch("site.json", { cache: "no-cache" })).json(); } catch {}
  const saved = store.get(KEY_STORE);
  if (saved) {
    try { await unlockWith(b64(saved)); return open(); } catch { store.del(KEY_STORE); }
  }
  $("#unlock").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, msg = $("#msg");
    msg.textContent = "Opening…";
    try {
      SITE = SITE || await (await fetch("site.json", { cache: "no-cache" })).json();
      const raw = await deriveKey(f.pw.value, SITE);
      await unlockWith(raw);
      if (f.remember.checked) store.set(KEY_STORE, btoa(String.fromCharCode(...raw)));
      open();
    } catch { msg.textContent = "That password didn't work."; }
  });
}
function open() {
  $("#lock").hidden = true;
  $("#app").hidden = $("#menu").hidden = $("#logout").hidden = false;
  SP()?.init(BUNDLE, SITE);
  renderSidebar();
  route();
}
$("#logout").addEventListener("click", () => { store.del(KEY_STORE); location.hash = ""; location.reload(); });

// ---------- contents ----------
function renderSidebar() {
  if (SP()) return SP().renderSidebar(sidebar);
  sidebar.innerHTML = MANIFEST.tree.map(c => `
    <details open><summary><a href="#/doc/${enc(c.name + "/README.md")}">${esc(c.name)}</a></summary>
      ${c.modules.map(m => `
        <details open><summary><a href="#/doc/${enc(`${c.name}/${m.name}/README.md`)}">${esc(m.name)}</a></summary>
          <ul>${m.lectures.map(l => `<li><a href="#/doc/${enc(l.path + "/notes.md")}">${esc(l.date ? l.date + " · " : "")}${esc(l.title)}</a>
            ${l.ru ? `<a class="lang" href="#/doc/${enc(l.path + "/notes.ru.md")}">RU</a>` : ""}</li>`).join("")}</ul>
        </details>`).join("")}
    </details>`).join("");
  markActive();
}
function markActive() {
  if (SP()) return SP().markActive();
  sidebar.querySelectorAll("a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === location.hash));
}

async function showDoc(path) {
  main.innerHTML = `<p class="muted pad">Loading…</p>`;
  let md;
  try { md = await readText(path); }
  catch (e) { main.innerHTML = `<section class="panel"><p>${esc(e.message)}</p></section>`; return; }
  main.innerHTML = `<article class="notes"></article>`;
  const article = main.querySelector("article.notes");
  const secs = splitSections(md);
  renderNotes(article, secs, path);
  main.scrollTo(0, 0); window.scrollTo(0, 0);
  const dir = path.split("/").slice(0, -1).join("/");
  window.Annotate?.attach(path, article, { secs, render: (el, parts, opts) => renderNotes(el, parts, path, opts),
    load: name => readText(dir + "/" + name).catch(() => null) });
  SP()?.decorateDoc(path);
}

// Markdown is rendered section by section (a section runs from one heading of level 1-4 to the next), each in a
// <section class="sec" data-key>, so annotate.js can swap in a person's own version of any section.
function splitSections(md) {
  const secs = [], seen = {};
  let cur = { key: "_top", heading: "", md: "" }, fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (h) {
      secs.push(cur);
      const base = h[1].length + ":" + h[2].trim();
      seen[base] = (seen[base] || 0) + 1;
      cur = { key: seen[base] > 1 ? `${base}#${seen[base]}` : base, heading: h[2].trim(), md: "" };
    }
    cur.md += line + "\n";
  }
  secs.push(cur);
  return secs.filter(x => x.key !== "_top" || x.md.trim());
}

// Fill `article` with the rendered sections. opts.forEdit keeps the markup close to the Markdown (for the editor):
// original link/image targets are kept in data-href/data-src either way, so edited HTML converts back faithfully.
function renderNotes(article, secs, path, opts = {}) {
  const dir = path.split("/").slice(0, -1).join("/");
  article.innerHTML = DOMPurify.sanitize(secs.map(x =>
    `<section class="sec" data-key="${esc(x.key)}">${marked.parse(x.md)}</section>`).join(""));
  const base = new URL("http://lib/" + enc(dir) + "/");
  const resolve = href => decodeURIComponent(new URL(href, base).pathname.slice(1));
  article.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src");
    img.removeAttribute("src");
    if (src) img.dataset.src = src;
    if (!src || /^(https?:|data:)/.test(src)) { if (src) img.src = src; return; }
    const target = resolve(src);
    const url = opts.resolve ? opts.resolve(target) : MANIFEST.files[target] ? fileUrl(target) : null;
    if (!url) return;
    Promise.resolve(url).then(u => { if (u) img.src = u; });
    if (!opts.forEdit) img.addEventListener("click", () => img.src && window.open(img.src, "_blank"));
  });
  article.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    a.dataset.href = href;
    if (opts.forEdit) return;
    if (/^(https?:|mailto:|#)/.test(href)) { if (/^https?:/.test(href)) a.target = "_blank"; return; }
    const target = resolve(href);
    if (target.endsWith(".md")) { a.href = "#/doc/" + enc(target); return; }
    if (opts.resolve || !MANIFEST.files[target]) { a.removeAttribute("href"); return; }
    a.href = "#";
    a.addEventListener("click", async e => {
      e.preventDefault();
      const w = window.open("", "_blank");
      const u = await fileUrl(target);
      if (w) w.location = u; else location.href = u;
    });
  });
  if (opts.forEdit) return article;
  article.querySelectorAll("thead").forEach(th => { if (![...th.querySelectorAll("th")].some(c => c.textContent.trim())) th.remove(); });
  article.querySelectorAll("table").forEach(t => { const w = document.createElement("div"); w.className = "table-wrap"; t.replaceWith(w); w.append(t); });
  return article;
}

function route() {
  if (!MANIFEST) return;
  document.body.classList.remove("nav-open");
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("/doc/")) showDoc(h.slice(5));
  else if (SP()?.route(h)) { /* own notes, World items, review queue */ }
  else if (SP()) SP().home();
  else {
    const first = MANIFEST.tree[0]?.modules.flatMap(m => m.lectures)[0];
    location.replace(first ? "#/doc/" + enc(first.path + "/notes.md") : "#/doc/README.md");
    if (!first) showDoc("README.md");
  }
  markActive();
}
window.addEventListener("hashchange", route);
$("#menu").addEventListener("click", () => document.body.classList.toggle("nav-open"));
start();

// For space.js: the pieces it reuses to render and annotate notes from other sources.
window.Viewer = { renderNotes, splitSections, readText, fileUrl, esc, enc, showDoc, main, sidebar,
  manifest: () => MANIFEST };
