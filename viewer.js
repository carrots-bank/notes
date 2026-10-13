// Read-only viewer for the encrypted library (see lecturenotes/site.py for the format).
// Every file is nonce(12) || AES-256-GCM ciphertext; the key is PBKDF2-SHA256(password, salt) (first 32 bytes).
const $ = (s, el = document) => el.querySelector(s);
const main = $("#main"), sidebar = $("#sidebar");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = p => p.split("/").map(encodeURIComponent).join("/");
const KEY_STORE = "notes_key";
let KEY = null, MANIFEST = null;
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
    { name: "PBKDF2", hash: "SHA-256", salt: b64(site.salt), iterations: site.iterations }, base, 512);
  return new Uint8Array(bits).slice(0, 32);
}
const importKey = raw => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);

async function decrypt(buf) {
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, KEY, b.slice(12));
}
async function fetchBlob(id) {
  const r = await fetch(`d/${id}.bin`, { cache: "no-cache" });
  if (!r.ok) throw new Error("Missing file");
  return decrypt(await r.arrayBuffer());
}
async function readText(path) {
  const id = MANIFEST.files[path];
  if (!id) throw new Error("Not found: " + path);
  return new TextDecoder().decode(await fetchBlob(id));
}
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
                svg: "image/svg+xml", pdf: "application/pdf" };
async function fileUrl(path) {
  if (blobUrls.has(path)) return blobUrls.get(path);
  const type = TYPES[path.split(".").pop().toLowerCase()] || "application/octet-stream";
  const url = URL.createObjectURL(new Blob([await fetchBlob(MANIFEST.files[path])], { type }));
  blobUrls.set(path, url);
  return url;
}

// ---------- unlock ----------
async function unlockWith(raw) {
  KEY = await importKey(raw);
  MANIFEST = JSON.parse(new TextDecoder().decode(await fetchBlob("manifest")));
}
async function start() {
  const saved = store.get(KEY_STORE);
  if (saved) {
    try { await unlockWith(b64(saved)); return open(); } catch { store.del(KEY_STORE); }
  }
  $("#unlock").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, msg = $("#msg");
    msg.textContent = "Opening…";
    try {
      const site = await (await fetch("site.json", { cache: "no-cache" })).json();
      const raw = await deriveKey(f.pw.value, site);
      await unlockWith(raw);
      if (f.remember.checked) store.set(KEY_STORE, btoa(String.fromCharCode(...raw)));
      open();
    } catch { msg.textContent = "That password didn't work."; KEY = null; }
  });
}
function open() {
  $("#lock").hidden = true;
  $("#app").hidden = $("#menu").hidden = $("#logout").hidden = false;
  renderSidebar();
  route();
}
$("#logout").addEventListener("click", () => { store.del(KEY_STORE); location.hash = ""; location.reload(); });

// ---------- contents ----------
function renderSidebar() {
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
  sidebar.querySelectorAll("a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === location.hash));
}

async function showDoc(path) {
  main.innerHTML = `<p class="muted pad">Loading…</p>`;
  let md;
  try { md = await readText(path); }
  catch (e) { main.innerHTML = `<section class="panel"><p>${esc(e.message)}</p></section>`; return; }
  const dir = path.split("/").slice(0, -1).join("/");
  main.innerHTML = `<article class="notes">${DOMPurify.sanitize(marked.parse(md))}</article>`;
  const base = new URL("http://lib/" + enc(dir) + "/");
  const resolve = href => decodeURIComponent(new URL(href, base).pathname.slice(1));
  main.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src");
    img.removeAttribute("src");
    if (!src || /^(https?:|data:)/.test(src)) { if (src) img.src = src; return; }
    const target = resolve(src);
    if (!MANIFEST.files[target]) return;
    fileUrl(target).then(u => { img.src = u; });
    img.addEventListener("click", () => img.src && window.open(img.src, "_blank"));
  });
  main.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (/^(https?:|mailto:|#)/.test(href)) { if (/^https?:/.test(href)) a.target = "_blank"; return; }
    const target = resolve(href);
    if (target.endsWith(".md")) { a.href = "#/doc/" + enc(target); return; }
    if (!MANIFEST.files[target]) { a.removeAttribute("href"); return; }
    a.href = "#";
    a.addEventListener("click", async e => {
      e.preventDefault();
      const w = window.open("", "_blank");
      const u = await fileUrl(target);
      if (w) w.location = u; else location.href = u;
    });
  });
  main.querySelectorAll("thead").forEach(th => { if (![...th.querySelectorAll("th")].some(c => c.textContent.trim())) th.remove(); });
  main.querySelectorAll("table").forEach(t => { const w = document.createElement("div"); w.className = "table-wrap"; t.replaceWith(w); w.append(t); });
  main.scrollTo(0, 0); window.scrollTo(0, 0);
}

function route() {
  if (!MANIFEST) return;
  document.body.classList.remove("nav-open");
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("/doc/")) showDoc(h.slice(5));
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
