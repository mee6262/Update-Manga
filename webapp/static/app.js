// ข้อมูลชุดแรก (ผู้ใช้ปัจจุบัน + เรื่องที่ติดตาม + ค่าตั้งค่า) ฝังมากับหน้า HTML แล้ว (ดู index())
// หน้าแรกจึงขึ้นได้ทันทีโดยไม่ต้องรอยิง API ต่อกันหลายรอบก่อนจะวาดอะไรได้
const BOOT = window.__BOOT__ || {};

const state = {
  manga: BOOT.manga || [],
  catalog: [],
  prefs: BOOT.prefs || {},
  currentUser: BOOT.me || { username: null, is_admin: false },
};

const el = (sel) => document.querySelector(sel);
const els = (sel) => Array.from(document.querySelectorAll(sel));

// width = ขอรูปที่ย่อมาให้พอดีกับที่จะแสดงจริง (เฉพาะรูปปก ไม่ใช่รูปหน้ามังงะ) ประหยัดเน็ตหลายเท่า
function proxied(url, width = 0) {
  if (!url) return "";
  return "/api/img?src=" + encodeURIComponent(url) + (width ? "&w=" + width : "");
}

// การ์ดในกริดกว้างราว 160-200px, รูปในหน้าตั้งค่ากว้าง 36px — เผื่อจอ retina ไว้เท่าตัว
const COVER_WIDTH = 400;
const THUMB_WIDTH = 120;

// ดึง JSON แบบไม่ให้ค้างถาวรถ้าเน็ตแกว่ง และคืน null เมื่อพลาด (ผู้เรียกใช้ของเดิมต่อได้)
async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw Object.assign(new Error("request failed"), { status: res.status, body: await res.json().catch(() => ({})) });
  return res.json();
}

function timeAgo(iso) {
  if (!iso) return "ยังไม่เคยตรวจสอบ";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "เพิ่งตรวจสอบ";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`;
  const days = Math.floor(hours / 24);
  return `${days} วันที่แล้ว`;
}

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// ---------- อัปเดตเวอร์ชันอัตโนมัติ ----------
// บนมือถือ (โดยเฉพาะตอนเพิ่มเป็นแอปบนหน้าจอโฮม) การสั่งล้างแคชเองทำได้ยากมาก เลยให้หน้าเว็บเช็คเอง
// ว่ามีเวอร์ชันใหม่ไหมทุกครั้งที่กลับมาเปิดแอป แล้วโหลดตัวเองใหม่ให้เลย ผู้ใช้ไม่ต้องทำอะไร
let pendingReload = false;

async function checkForUpdate() {
  if (!BOOT.build) return;
  try {
    const data = await getJSON("/api/version");
    if (!data.build || data.build === BOOT.build) return;
    // กำลังอ่านอยู่ห้ามรีโหลดขัดจังหวะ รอจนกดปิดกลับมาหน้ารวมก่อน
    if (el("#reader").hidden && el("#chapterListView").hidden) location.reload();
    else pendingReload = true;
  } catch (e) {
    // เน็ตสะดุด/ยังไม่ได้ login — ไว้เช็คใหม่รอบหน้า
  }
}

function reloadIfPending() {
  if (pendingReload) location.reload();
}

function applyAdminGating() {
  els(".admin-only").forEach((elm) => { elm.hidden = !state.currentUser.is_admin; });
}

// ---------- Tabs ----------
// วาดจากข้อมูลที่มีอยู่ทันที แล้วค่อยดึงของใหม่มาอัปเดตทีหลัง (ไม่ปล่อยจอว่างรอเน็ต)
function initTabs() {
  els(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els(".tab-btn").forEach((b) => b.classList.remove("active"));
      els(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      el(`#${btn.dataset.tab}View`).classList.add("active");

      if (btn.dataset.tab === "catalog") {
        renderCatalog(filterCatalog());
        loadCatalog().then(() => renderCatalog(filterCatalog()));
      }
      if (btn.dataset.tab === "settings") {
        renderSettings();
        loadCatalog().then(renderSettings);
        renderUserList();
      }
    });
  });
}

// ---------- แท็บย่อยในหน้าตั้งค่า (จัดการเรื่อง / จัดการสมาชิก) ----------
function initSubTabs() {
  els(".sub-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els(".sub-tab-btn").forEach((b) => b.classList.remove("active"));
      els(".subview").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      el(`#${btn.dataset.subtab}Subview`).classList.add("active");
    });
  });
}

// ---------- List view ----------
async function loadManga() {
  try {
    state.manga = await getJSON("/api/manga");
    renderGrid();
  } catch (e) {
    // ใช้ข้อมูลเดิมที่วาดไว้แล้วต่อไป
  }
}

function mangaById(id) {
  return state.manga.find((m) => m.id === id) || state.catalog.find((m) => m.id === id);
}

function cardHtml(m, extra = "") {
  return `
    <div class="manga-card" data-id="${escapeHtml(m.id)}">
      ${m.is_new ? '<span class="new-badge">NEW!</span>' : ""}
      <img class="manga-cover" src="${proxied(m.cover_url, COVER_WIDTH)}" alt="${escapeHtml(m.name)}" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
      <div class="manga-info">
        <div class="manga-name">${escapeHtml(m.name)}</div>
        <div class="manga-chapter">${m.latest_chapter ? escapeHtml(m.latest_chapter) : "ยังไม่ทราบตอนล่าสุด"}</div>
        ${extra}
      </div>
    </div>`;
}

// วาดใหม่เฉพาะตอนข้อมูลเปลี่ยนจริง — หน้าแรกถูกสั่งวาดซ้ำบ่อย (ปิดหน้าอ่าน, ติดตาม/เลิกติดตาม,
// รีเฟรช) ถ้าวาดใหม่ทุกครั้งรูปปกทุกใบจะกระพริบและ layout กระตุกทั้งหน้าโดยไม่จำเป็น
let lastGridSignature = null;
function renderGrid() {
  const grid = el("#mangaGrid");
  const empty = el("#emptyState");
  empty.hidden = state.manga.length > 0;

  const signature = JSON.stringify(
    state.manga.map((m) => [m.id, m.is_new, m.latest_chapter, m.cover_url, m.last_checked_at])
  );
  if (signature === lastGridSignature) return;
  lastGridSignature = signature;

  grid.innerHTML = state.manga
    .map((m) => cardHtml(m, `<div class="manga-chapter">${timeAgo(m.last_checked_at)}</div>`))
    .join("");
}

// ใช้ event delegation ตัวเดียวต่อกริด แทนการผูก listener ทีละใบ (เร็วกว่าและไม่ค้างหลังวาดใหม่)
function initGridClicks() {
  el("#mangaGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".manga-card");
    if (card) openChapterList(mangaById(card.dataset.id));
  });

  el("#catalogGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".manga-card");
    if (!card) return;
    const manga = state.catalog.find((m) => m.id === card.dataset.id);
    if (!manga) return;
    if (e.target.closest('[data-action="toggle-follow"]')) {
      e.stopPropagation();
      toggleSubscribe(manga);
      return;
    }
    openChapterList(manga);
  });
}

// ---------- Refresh ----------
async function refreshAll() {
  const btn = el("#refreshAllBtn");
  const status = el("#statusBar");
  btn.disabled = true;
  btn.classList.add("spinning");
  status.hidden = false;
  status.textContent = "กำลังตรวจสอบตอนใหม่ทุกเรื่อง อาจใช้เวลาสักครู่...";

  try {
    const res = await fetch("/api/refresh_all", { method: "POST" });
    const data = await res.json();
    state.manga = data.items;
    renderGrid();
    let msg = `ตรวจสอบเสร็จแล้ว: อัปเดตใหม่ ${data.updated_ids.length} เรื่อง`;
    if (data.failed.length > 0) msg += `, ผิดพลาด ${data.failed.length} เรื่อง`;
    status.textContent = msg;
  } catch (e) {
    status.textContent = "เกิดข้อผิดพลาดระหว่างรีเฟรช: " + e;
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
    setTimeout(() => { status.hidden = true; }, 6000);
  }
}

// ---------- Settings (admin: จัดการเรื่องทั้งหมดในระบบ) ----------
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 20h9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_REFRESH =
  '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M21 3v6h-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 6h18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><line x1="10" y1="11" x2="10" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="14" y1="11" x2="14" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

let lastSettingsSignature = null;
function renderSettings() {
  const list = el("#settingsList");
  const signature = JSON.stringify(state.catalog.map((m) => [m.id, m.name, m.source, m.latest_chapter, m.cover_url, (m.sources || []).length]));
  if (signature === lastSettingsSignature) return;
  lastSettingsSignature = signature;

  list.innerHTML = state.catalog
    .map((m) => {
      const sourceCount = (m.sources || []).length;
      const sourceLabel =
        sourceCount > 1 ? `${escapeHtml(m.source)} +${sourceCount - 1} แหล่ง` : escapeHtml(m.source);
      return `
        <li class="settings-row" data-id="${escapeHtml(m.id)}">
          <img src="${proxied(m.cover_url, THUMB_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
          <div class="grow">
            <div class="name">${escapeHtml(m.name)}</div>
            <div class="meta">${sourceLabel} — ${m.latest_chapter ? escapeHtml(m.latest_chapter) : "-"}</div>
          </div>
          <button class="icon-btn" data-action="edit" title="แก้ไข">${ICON_EDIT}</button>
          <button class="icon-btn" data-action="refresh" title="รีเฟรช">${ICON_REFRESH}</button>
          <button class="icon-btn danger" data-action="delete" title="ลบออกจากระบบ">${ICON_DELETE}</button>
        </li>`;
    })
    .join("");
}

function initSettingsClicks() {
  el("#settingsList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = e.target.closest(".settings-row").dataset.id;
    const manga = state.catalog.find((m) => m.id === id);
    if (!manga) return;
    if (btn.dataset.action === "edit") openMangaModal(manga);
    if (btn.dataset.action === "refresh") refreshOne(id, btn);
    if (btn.dataset.action === "delete") deleteManga(id, manga.name);
  });
}

async function refreshOne(id, btn) {
  btn.disabled = true;
  btn.classList.add("spinning");
  try {
    await fetch(`/api/manga/${id}/refresh`, { method: "POST" });
    await Promise.all([loadManga(), loadCatalog()]);
    renderSettings();
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
}

async function deleteManga(id, name) {
  if (!confirm(`ลบ "${name}" ออกจากระบบ? (ทุกคนจะติดตามไม่ได้อีก)`)) return;
  await fetch(`/api/manga/${id}`, { method: "DELETE" });
  await Promise.all([loadManga(), loadCatalog()]);
  renderSettings();
}

// ---------- Catalog (เรื่องทั้งหมดในระบบ ไว้เลือกติดตาม) ----------
async function loadCatalog() {
  try {
    state.catalog = await getJSON("/api/catalog");
  } catch (e) {
    // ใช้ของเดิมต่อ
  }
}

let lastCatalogSignature = null;
function renderCatalog(items = state.catalog) {
  const grid = el("#catalogGrid");
  const empty = el("#catalogEmpty");
  empty.hidden = items.length > 0;

  const signature = JSON.stringify(items.map((m) => [m.id, m.is_subscribed, m.latest_chapter, m.cover_url]));
  if (signature === lastCatalogSignature) return;
  lastCatalogSignature = signature;

  grid.innerHTML = items
    .map((m) =>
      cardHtml(
        m,
        `<button class="follow-btn${m.is_subscribed ? " subscribed" : ""}" data-action="toggle-follow">
           ${m.is_subscribed ? "✓ ติดตามอยู่" : "+ ติดตาม"}
         </button>`
      )
    )
    .join("");
}

// สลับสถานะในจอทันที ไม่รอเซิร์ฟเวอร์ตอบ (ถ้าพลาดค่อยสลับกลับ) — กดแล้วรู้สึกตอบสนองทันที
async function toggleSubscribe(manga) {
  const wasSubscribed = manga.is_subscribed;
  manga.is_subscribed = !wasSubscribed;
  renderCatalog(filterCatalog());

  try {
    const action = wasSubscribed ? "unsubscribe" : "subscribe";
    const res = await fetch(`/api/catalog/${manga.id}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error("failed");
    loadManga(); // อัปเดตหน้าแรกด้วยเงียบ ๆ
  } catch (e) {
    manga.is_subscribed = wasSubscribed;
    renderCatalog(filterCatalog());
  }
}

function filterCatalog() {
  const q = el("#catalogSearch").value.trim().toLowerCase();
  const items = q ? state.catalog.filter((m) => m.name.toLowerCase().includes(q)) : state.catalog;
  return sortCatalog(items);
}

function sortCatalog(items) {
  const mode = el("#catalogSort").value;
  const sorted = [...items];
  if (mode === "name-asc") {
    sorted.sort((a, b) => a.name.localeCompare(b.name, "th"));
  } else if (mode === "name-desc") {
    sorted.sort((a, b) => b.name.localeCompare(a.name, "th"));
  } else if (mode === "updated") {
    // ใช้วันที่ตอนล่าสุดจริงจากเว็บต้นทางก่อน (latest_chapter_date) ไม่ใช่เวลาที่ระบบเรามาเช็คเจอ
    // (last_updated_at) เพราะเรื่องที่พึ่งเพิ่มเข้าระบบจะโดนตราว่า "อัพเดตตอนนี้เลย" ทั้งที่ตอน
    // ล่าสุดของเรื่องนั้นอาจลงมานานแล้วก็ได้ ใช้ last_updated_at เป็น fallback เผื่อเว็บนั้นไม่มี
    // วันที่ให้แปลงได้
    const key = (m) => m.latest_chapter_date || m.last_updated_at || "";
    sorted.sort((a, b) => key(b).localeCompare(key(a)));
  }
  return sorted;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function initCatalogSearch() {
  // หน่วงระหว่างพิมพ์ ไม่ต้องกรอง+วาดใหม่ทุกตัวอักษร (รายการเยอะ ๆ จะหน่วงตอนพิมพ์)
  el("#catalogSearch").addEventListener("input", debounce(() => renderCatalog(filterCatalog()), 120));

  const sortSelect = el("#catalogSort");
  // ลำดับที่เลือกไว้เก็บฝั่งเซิร์ฟเวอร์แยกบัญชีใครบัญชีมัน (ไม่ใช่ localStorage) ผู้ใช้แต่ละคน
  // ตั้งค่าของตัวเองได้อิสระ ไม่ปนกัน — ค่ามาพร้อมหน้าเว็บแล้ว (BOOT.prefs) ไม่ต้องยิง API เพิ่ม
  if (state.prefs.catalog_sort) sortSelect.value = state.prefs.catalog_sort;

  sortSelect.addEventListener("change", () => {
    renderCatalog(filterCatalog());
    fetch("/api/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog_sort: sortSelect.value }),
    });
  });
}

// ---------- จัดการสมาชิก (admin เท่านั้น) ----------
async function renderUserList() {
  const list = el("#userList");
  try {
    const users = await getJSON("/api/users");
    list.innerHTML = users
      .map(
        (u) =>
          `<li class="settings-row"><div class="grow"><div class="name">${escapeHtml(u.username)}${
            u.is_admin ? " (admin)" : ""
          }</div></div></li>`
      )
      .join("");
  } catch (e) {
    // เงียบไว้ ไม่ใช่ประเด็นสำคัญถ้าโหลดรายชื่อสมาชิกไม่ได้ (หรือไม่ใช่ admin)
  }
}

function initAddUserForm() {
  el("#addUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = el("#newUsername").value.trim();
    const password = el("#newPassword").value;
    const isAdmin = el("#newIsAdmin").checked;
    const msg = el("#addUserMsg");
    msg.className = "form-msg";
    msg.textContent = "กำลังเพิ่ม...";

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, is_admin: isAdmin }),
      });
      const data = await res.json();
      if (!res.ok) {
        msg.classList.add("error");
        msg.textContent = data.error || "เพิ่มไม่สำเร็จ";
        return;
      }
      msg.classList.add("success");
      msg.textContent = `เพิ่มสมาชิก "${username}" สำเร็จ`;
      el("#addUserForm").reset();
      renderUserList();
    } catch (err) {
      msg.classList.add("error");
      msg.textContent = "เกิดข้อผิดพลาด: " + err;
    }
  });
}

// ---------- ป็อปอัพเพิ่ม/แก้ไขเรื่อง (หลายแหล่งที่มาต่อเรื่อง) ----------
let editingMangaId = null; // null = โหมดเพิ่มเรื่องใหม่, ไม่ null = โหมดแก้ไขเรื่องนี้

function addSourceRow(value = "") {
  const list = el("#mangaFormSources");
  const row = document.createElement("div");
  row.className = "source-row";
  row.innerHTML = `
    <input type="url" class="source-url" placeholder="URL หน้าเรื่อง เช่น https://www.go-manga.com/overgeared/" required />
    <button type="button" class="icon-btn remove-source-btn" title="ลบแหล่งนี้">✕</button>
  `;
  row.querySelector(".source-url").value = value;
  row.querySelector(".remove-source-btn").addEventListener("click", () => {
    // เหลือช่องเดียวห้ามลบ ต้องมีแหล่งที่มาอย่างน้อย 1 เว็บเสมอ
    if (list.children.length > 1) row.remove();
  });
  list.appendChild(row);
}

function openMangaModal(manga = null) {
  editingMangaId = manga ? manga.id : null;
  el("#mangaFormTitle").textContent = manga ? "แก้ไขเรื่อง" : "เพิ่มเรื่องใหม่";
  el("#mangaFormName").value = manga ? manga.name : "";
  el("#mangaFormSources").innerHTML = "";
  const urls = manga ? (manga.sources || []).map((s) => s.url) : [""];
  for (const u of urls) addSourceRow(u);
  const msg = el("#mangaFormMsg");
  msg.className = "form-msg";
  msg.textContent = "";
  el("#mangaFormModal").hidden = false;
}

function closeMangaModal() {
  el("#mangaFormModal").hidden = true;
}

function initMangaForm() {
  el("#openAddMangaBtn").addEventListener("click", () => openMangaModal());
  el("#addSourceRowBtn").addEventListener("click", () => addSourceRow());
  el("#mangaFormCancel").addEventListener("click", closeMangaModal);

  el("#mangaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("#mangaFormName").value.trim();
    const sources = els("#mangaFormSources .source-url")
      .map((input) => input.value.trim())
      .filter(Boolean);
    const msg = el("#mangaFormMsg");
    msg.className = "form-msg";
    msg.textContent = editingMangaId ? "กำลังบันทึก..." : "กำลังเพิ่ม...";

    try {
      const url = editingMangaId ? `/api/manga/${editingMangaId}` : "/api/manga";
      const res = await fetch(url, {
        method: editingMangaId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sources }),
      });
      const data = await res.json();
      if (!res.ok) {
        msg.classList.add("error");
        msg.textContent = data.error || "บันทึกไม่สำเร็จ";
        return;
      }
      closeMangaModal();
      await Promise.all([loadCatalog(), loadManga()]);
      renderSettings();
    } catch (err) {
      msg.classList.add("error");
      msg.textContent = "เกิดข้อผิดพลาด: " + err;
    }
  });
}

// ---------- Chapter list ----------
let currentManga = null; // { id, name, latest_chapter_url }
let currentChapters = []; // รายการตอนทั้งหมดที่โหลดมา (ยังไม่กรอง) ไว้ใช้กรองตอนค้นหา
let lastReadUrl = null; // ตอนล่าสุดที่อ่าน ไว้เลื่อนหาอัตโนมัติตอนเปิดหน้าเลือกตอน
let lastScrollInfo = null; // { url, fraction } ตำแหน่งที่เลื่อนค้างไว้ในตอนล่าสุดที่อ่าน (ยังอ่านไม่จบ)
let mangaListStale = false; // อ่านตอนใหม่ไปแล้ว หน้าแรกควรโหลดใหม่ตอนกลับไป

// รายชื่อตอนที่เคยโหลดแล้ว (ต่อเรื่อง) ไว้โชว์ทันทีตอนเปิดซ้ำ แล้วค่อยเช็คของใหม่ทีหลัง
const chapterListCache = new Map();

const BOOKMARK_ICON =
  '<svg class="bookmark-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" fill="currentColor"/></svg>';

function openChapterList(manga) {
  if (!manga) return;
  currentManga = { id: manga.id, name: manga.name, latest_chapter_url: manga.latest_chapter_url };
  const view = el("#chapterListView");
  view.hidden = false;
  document.body.style.overflow = "hidden";
  el("#chapterListMangaName").textContent = manga.name;
  el("#chapterSearch").value = "";

  lastChapterRowsSignature = null;
  const cached = chapterListCache.get(manga.id);
  if (cached && (cached.chapters || []).length > 0) {
    // เคยเปิดเรื่องนี้แล้ว โชว์ของเดิมทันที แล้วค่อยเช็คของใหม่เบื้องหลัง
    applyChapterData(cached);
    renderChapterRows(currentChapters);
    scrollToLastRead();
    renderChapterList({ keepScroll: true });
    return;
  }
  currentChapters = [];
  el("#chapterListBody").innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  renderChapterList();
}

function applyChapterData(data) {
  currentChapters = data.chapters || [];
  lastReadUrl = data.last_read_url || null;
  lastScrollInfo = data.last_scroll || null;
}

async function renderChapterList({ keepScroll = false } = {}) {
  const body = el("#chapterListBody");
  const mangaId = currentManga.id;
  try {
    const data = await getJSON(`/api/manga/${mangaId}/chapters`);
    if (!currentManga || currentManga.id !== mangaId) return; // ผู้ใช้เปลี่ยนเรื่องไปแล้วระหว่างรอ
    chapterListCache.set(mangaId, data);

    applyChapterData(data);
    if (currentChapters.length === 0) {
      // บางเว็บ (ธีม Madara บางเจ้า) ดึงรายชื่อตอนทั้งหมดไม่ได้ แต่รู้ลิงก์ตอนล่าสุดแน่ ๆ
      // เลยเปิดอ่านตอนล่าสุดตรง ๆ ได้ ถึงจะเลือกอ่านตอนอื่นย้อนหลังไม่ได้ก็ตาม
      if (currentManga.latest_chapter_url) {
        body.innerHTML = `
          <div class="reader-msg">
            เว็บนี้ยังไม่รองรับรายชื่อตอนทั้งหมด แต่อ่านตอนล่าสุดได้เลย<br><br>
            <button class="btn primary" id="readLatestBtn">อ่านตอนล่าสุด</button>
          </div>
        `;
        el("#readLatestBtn").addEventListener("click", () => openReader(currentManga.latest_chapter_url));
        return;
      }
      const hint = state.currentUser.is_admin
        ? 'ลองรีเฟรชเรื่องนี้ในแท็บ "ตั้งค่า" ก่อน'
        : "แจ้ง admin ให้กดรีเฟรชเรื่องนี้ก่อน";
      body.innerHTML = `<div class="reader-msg">ยังไม่มีข้อมูลรายชื่อตอน ${hint}</div>`;
      return;
    }

    const scrollTop = body.scrollTop;
    const changed = renderChapterRows(currentChapters);
    if (!changed) return;
    if (keepScroll && scrollTop > 0) body.scrollTop = scrollTop;
    else scrollToLastRead();
  } catch (e) {
    if (currentChapters.length > 0) return; // มีของเดิมโชว์อยู่แล้ว ไม่ต้องล้างทิ้งเพราะเน็ตสะดุด
    currentChapters = [];
    body.innerHTML = `<div class="reader-msg">${escapeHtml(e.body?.error || "โหลดไม่สำเร็จ")}</div>`;
  }
}

let lastChapterRowsSignature = null;
function renderChapterRows(chapters) {
  const body = el("#chapterListBody");

  if (chapters.length === 0) {
    lastChapterRowsSignature = null;
    body.innerHTML = '<div class="reader-msg">ไม่พบตอนที่ค้นหา</div>';
    return true;
  }

  const signature = JSON.stringify([lastReadUrl, chapters.map((c) => [c.url, c.is_read])]);
  if (signature === lastChapterRowsSignature) return false;
  lastChapterRowsSignature = signature;

  // สร้าง HTML ทีเดียวทั้งก้อน (เรื่องหนึ่งมีได้เป็นพันตอน การสร้างทีละ element + ผูก listener
  // ทีละแถวช้ากว่ามาก) แล้วใช้ event delegation ตัวเดียวที่ตัว container แทน
  body.innerHTML = chapters
    .map((c) => {
      const isLastRead = c.url === lastReadUrl;
      return `
        <div class="chapter-row${c.is_read ? " read" : ""}${isLastRead ? " last-read" : ""}" data-url="${escapeHtml(c.url)}">
          ${isLastRead ? BOOKMARK_ICON : ""}
          <span class="chapter-text">${escapeHtml(c.text)}</span>
          ${c.date ? `<span class="chapter-date">${escapeHtml(c.date)}</span>` : ""}
          ${!c.is_read ? '<span class="new-badge">NEW!</span>' : ""}
        </div>`;
    })
    .join("");
  return true;
}

// เลื่อนหาแถวตอนล่าสุดที่อ่าน ให้อยู่กลางจอ จะได้อ่านต่อง่ายไม่ต้องไล่หาเอง
function scrollToLastRead() {
  if (!lastReadUrl) return;
  const body = el("#chapterListBody");
  const row = body.querySelector(`.chapter-row[data-url="${CSS.escape(lastReadUrl)}"]`);
  if (row) row.scrollIntoView({ block: "center", behavior: "auto" });
}

function initChapterListClicks() {
  el("#chapterListBody").addEventListener("click", (e) => {
    const row = e.target.closest(".chapter-row");
    if (row) openReader(row.dataset.url);
  });
}

function initChapterSearch() {
  el("#chapterSearch").addEventListener(
    "input",
    debounce((e) => {
      const q = e.target.value.trim();
      renderChapterRows(q ? currentChapters.filter((c) => c.text.includes(q)) : currentChapters);
    }, 120)
  );
}

function closeChapterList() {
  el("#chapterListView").hidden = true;
  document.body.style.overflow = "";
  currentManga = null;
  currentChapters = [];
  lastChapterRowsSignature = null;
  if (mangaListStale) {
    mangaListStale = false;
    loadManga();
  }
  reloadIfPending();
}

function findChapterText(url) {
  const match = currentChapters.find((c) => c.url === url);
  return match ? match.text : "";
}

// ---------- Reader ----------
// เลื่อนจนสุดตอนจริง ๆ -> เปลี่ยนไปตอนถัดไปให้อัตโนมัติ (เหมือนเลื่อน slide ต่อ)
// ตั้งใจให้เป็น hard page change ไม่ใช่ต่อรูปเข้ามาเรื่อย ๆ แบบ infinite scroll เพราะทดสอบแล้วพบว่า
// การ prefetch/มาร์คตอนถัดไปว่าอ่านแล้วล่วงหน้าก่อนเลื่อนไปถึงจริง ทำให้ "ตอนล่าสุดที่อ่าน" เพี้ยน
let readerMangaId = null;
let currentChapterData = { url: null, prevUrl: null, nextUrl: null };
let autoAdvancing = false;
let awaitingConfirmScroll = false; // ถึงล่างสุดแล้ว รอให้เลื่อน/สไลด์อีกทีเพื่อยืนยันไปตอนถัดไป
let gestureArmed = true; // พร้อมเปลี่ยนตอนไหม — ปลดเป็น false หลังเปลี่ยน 1 ตอน รอสไลด์รอบใหม่

let currentScrollFraction = 0; // สัดส่วนที่เลื่อนอ่านมาแล้วของตอนปัจจุบัน (0-1) อัปเดตทุกครั้งที่เลื่อน

// รายการรูปของตอนที่โหลดล่วงหน้าไว้ (url -> data) ไว้ให้เปลี่ยนตอนแล้วขึ้นทันที
const prefetchedChapters = new Map();
let prefetchingUrl = null;

async function openReader(chapterUrl) {
  el("#chapterListView").hidden = true;
  const restoreFraction =
    chapterUrl === lastReadUrl && lastScrollInfo && lastScrollInfo.url === chapterUrl
      ? lastScrollInfo.fraction
      : null;
  await loadChapter(currentManga.id, chapterUrl, restoreFraction);
}

function appendChapterImages(images) {
  const body = el("#readerBody");
  const frag = document.createDocumentFragment();
  images.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = proxied(src);
    img.decoding = "async";
    // 2 รูปแรกคือสิ่งที่ผู้ใช้เห็นทันทีที่เปิดตอน ให้ browser จัดคิวโหลดก่อนรูปที่เหลือ
    if (i < 2) img.fetchPriority = "high";
    frag.appendChild(img);
  });
  body.appendChild(frag);
}

// จำตำแหน่งที่อ่านค้างไว้ในหน้าเว็บเองทันที (ไม่รอเซิร์ฟเวอร์) — เดิมพึ่งการโหลดรายชื่อตอนใหม่จาก
// เซิร์ฟเวอร์ทุกครั้งที่ปิดหน้าอ่าน ซึ่งวิ่งชนกับการบันทึกที่ส่งไปพร้อมกัน (โหลดเสร็จก่อนบันทึกเขียนถึงไฟล์
// ได้ค่าเก่ากลับมา) จึงกลับมาอ่านแล้วไม่ไปที่เดิม ตัวเลข 0.95 ต้องตรงกับเซิร์ฟเวอร์ (อ่านจบแล้วไม่จำ)
function rememberScroll() {
  if (!readerMangaId || !currentChapterData.url) return;
  const url = currentChapterData.url;
  const info = currentScrollFraction >= 0.95 ? null : { url, fraction: currentScrollFraction };
  lastReadUrl = url;
  lastScrollInfo = info;
  const cached = chapterListCache.get(readerMangaId);
  if (cached) {
    cached.last_read_url = url;
    cached.last_scroll = info;
  }
}

// เก็บตำแหน่งที่เลื่อนค้างไว้ของตอนปัจจุบัน ไว้กลับมาอ่านต่อจากจุดเดิมได้
let lastSavedScroll = null; // "url|fraction" ที่ส่งเซิร์ฟเวอร์ไปล่าสุด กันส่งซ้ำค่าเดิม
let scrollSaveTimer = null;

function saveScrollPosition() {
  clearTimeout(scrollSaveTimer);
  if (!readerMangaId || !currentChapterData.url) return Promise.resolve();
  rememberScroll();
  const signature = `${currentChapterData.url}|${currentScrollFraction.toFixed(3)}`;
  if (signature === lastSavedScroll) return Promise.resolve();
  lastSavedScroll = signature;
  return fetch(`/api/manga/${readerMangaId}/scroll_position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: currentChapterData.url, fraction: currentScrollFraction }),
    keepalive: true,
  }).catch(() => {
    lastSavedScroll = null; // ส่งไม่สำเร็จ ให้ลองใหม่รอบหน้า
  });
}

// บันทึกระหว่างอ่านด้วย (หน่วงไว้หลังหยุดเลื่อน) ไม่ใช่แค่ตอนกดปิด — บนมือถือแอปโดนระบบปิด/เบราว์เซอร์
// โดนเคลียร์ตอนสลับแอปไปมาได้ ถ้าพึ่งแค่ตอนปิดตำแหน่งจะหายทั้งที่อ่านไปไกลแล้ว
function scheduleScrollSave() {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveScrollPosition, 1500);
}

// เปลี่ยนตอนแล้วต้องเริ่มอ่านจากบนสุดเสมอ — ตั้ง scrollTop=0 ครั้งเดียว (หรือสองครั้ง) ไม่พอ เพราะ
// ตอนเปลี่ยนด้วยการสไลด์ นิ้วยังลากค้างอยู่ (และหลังยกนิ้วยังมีแรงเฉื่อยอีกพัก) เบราว์เซอร์จะเลื่อน
// เนื้อหาชุดใหม่ต่อให้ตามระยะที่ลากค้าง จึงไม่ถึงบนสุดเป็นบางครั้ง ไม่แน่นอน วิธีที่ได้ผลคือ "ตรึง"
// ไว้ที่บนสุด (ทุก scroll event ดึงกลับเป็น 0) จนกว่าผู้ใช้จะเริ่มสไลด์รอบใหม่จริง ๆ (แตะใหม่ / หมุนล้อ
// หลังหยุดนิ่ง / กดคีย์ / จับ scrollbar) แล้วค่อยปล่อย
let pinnedToTop = false;
let pinReleaseTimer = null;

function releaseTopPin() {
  pinnedToTop = false;
  clearTimeout(pinReleaseTimer);
}

function scrollReaderToTop() {
  const body = el("#readerBody");
  pinnedToTop = true;
  // กันค้างถาวรเผื่อไม่มี event ไหนมาปล่อย (ปกติมีตลอด) — 2.5 วิพอเผื่อแรงเฉื่อยที่ยาวที่สุดของมือถือ
  clearTimeout(pinReleaseTimer);
  pinReleaseTimer = setTimeout(releaseTopPin, 2500);
  // ปิด/เปิด overflow ชั่วขณะ เป็นวิธีที่ iOS ยอมหยุดแรงเฉื่อยที่กำลังเลื่อนอยู่ (ตั้ง scrollTop เฉย ๆ
  // ระหว่างที่แรงเฉื่อยยังวิ่งอยู่ iOS ไม่สนใจ)
  body.style.overflowY = "hidden";
  body.scrollTop = 0;
  body.style.overflowY = "";
  requestAnimationFrame(() => { body.scrollTop = 0; });
}

function initTopPin() {
  const body = el("#readerBody");
  body.addEventListener(
    "scroll",
    () => {
      if (pinnedToTop && body.scrollTop !== 0) body.scrollTop = 0;
    },
    { passive: true }
  );
  // ผู้ใช้เริ่มขยับเองจริง ๆ แล้ว ปล่อยให้เลื่อนได้ตามปกติ
  body.addEventListener("touchstart", releaseTopPin, { passive: true });
  body.addEventListener("mousedown", releaseTopPin, { passive: true });
  document.addEventListener("keydown", releaseTopPin);
}

// เลื่อนไปตำแหน่งที่ค้างไว้ — รูปหน้ามังงะโหลดทยอยกัน (ตอนหนึ่งหลาย MB บนมือถือใช้เวลาหลายวินาที)
// ความสูงรวมจึงยังไม่นิ่ง เดิมลองแค่ 3 ครั้งภายใน 1.2 วิ ถ้ารูปยังโหลดไม่ทันจะเลื่อนไปผิดที่ (ติดเพดาน
// ความสูงที่มีตอนนั้น) แถมพอเลื่อนแล้ว scroll handler ก็ไปเขียนทับตำแหน่งที่จะบันทึกด้วยค่าผิดนั้นอีก
// ตอนนี้เลื่อนซ้ำทุกครั้งที่รูปโหลดเสร็จ จนกว่าผู้ใช้จะเริ่มเลื่อนเอง (หรือรูปครบ / ครบ 30 วิ)
// และระหว่างนั้นไม่ให้ตำแหน่งที่จะบันทึกถูกเขียนทับ
let restoreTarget = null;
let restoreTimer = null;

function cancelRestore() {
  restoreTarget = null;
  clearTimeout(restoreTimer);
}

function restoreScrollPosition(fraction) {
  const body = el("#readerBody");
  restoreTarget = fraction;
  currentScrollFraction = fraction;
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(cancelRestore, 30000);

  const apply = () => {
    if (restoreTarget === null) return;
    const max = body.scrollHeight - body.clientHeight;
    if (max > 0) body.scrollTop = restoreTarget * max;
    currentScrollFraction = restoreTarget;
  };
  apply();

  const imgs = [...body.querySelectorAll("img")];
  let pending = imgs.filter((img) => !img.complete).length;
  const onSettled = () => {
    apply();
    if (--pending <= 0) setTimeout(() => { apply(); cancelRestore(); }, 150);
  };
  imgs.filter((img) => !img.complete).forEach((img) => {
    img.addEventListener("load", onSettled, { once: true });
    img.addEventListener("error", onSettled, { once: true });
  });
  if (pending === 0) setTimeout(() => { apply(); cancelRestore(); }, 150);
}

// ผู้ใช้เริ่มเลื่อนเองแล้ว เลิกดึงกลับไปตำแหน่งเดิม ไม่งั้นจะสู้กับนิ้วผู้ใช้
function initRestoreCancel() {
  const body = el("#readerBody");
  ["touchstart", "wheel", "mousedown"].forEach((type) =>
    body.addEventListener(type, cancelRestore, { passive: true })
  );
  document.addEventListener("keydown", cancelRestore);
}

function goPrevChapter() {
  if (currentChapterData.prevUrl) loadChapter(readerMangaId, currentChapterData.prevUrl);
}

function goNextChapter() {
  if (currentChapterData.nextUrl) loadChapter(readerMangaId, currentChapterData.nextUrl);
}

// โหลดรายการรูปของตอนถัดไปไว้ล่วงหน้า (peek=1 = ห้ามมาร์คว่าอ่านแล้ว) พร้อมอุ่นรูปแรก ๆ ไว้ใน
// cache ของ browser — พอเลื่อนไปถึงจริงจะเปลี่ยนตอนได้ทันทีไม่ต้องรอโหลดใหม่
async function prefetchNextChapter() {
  const url = currentChapterData.nextUrl;
  if (!url || prefetchedChapters.has(url) || prefetchingUrl === url) return;
  prefetchingUrl = url;
  try {
    const data = await getJSON(`/api/manga/${readerMangaId}/chapter?url=${encodeURIComponent(url)}&peek=1`);
    prefetchedChapters.set(url, data);
    for (const src of (data.images || []).slice(0, 3)) new Image().src = proxied(src);
  } catch (e) {
    // ไม่เป็นไร ค่อยโหลดตอนกดจริง
  } finally {
    prefetchingUrl = null;
  }
}

function renderChapter(data, chapterUrl, restoreFraction) {
  const body = el("#readerBody");
  el("#readerMangaName").textContent = data.manga_name || "";
  el("#readerChapterName").textContent = data.chapter_text || findChapterText(chapterUrl) || "";

  if (!data.images || data.images.length === 0) {
    body.innerHTML = '<div class="reader-msg">ไม่พบรูปภาพในตอนนี้</div>';
  } else {
    body.innerHTML = "";
    appendChapterImages(data.images);
    if (restoreFraction) {
      releaseTopPin();
      restoreScrollPosition(restoreFraction);
    } else {
      cancelRestore();
      scrollReaderToTop();
    }
  }

  currentChapterData = { url: data.chapter_url || chapterUrl, prevUrl: data.prev_url, nextUrl: data.next_url };
  currentScrollFraction = restoreFraction || 0;
  el("#readerPrev").disabled = !data.prev_url;
  el("#readerNext").disabled = !data.next_url;

  awaitingConfirmScroll = false;
  if (data.next_url) {
    const hint = document.createElement("div");
    hint.className = "next-hint";
    hint.id = "nextHint";
    hint.textContent = "เลื่อนต่ออีกทีเพื่อไปตอนถัดไป ›";
    body.appendChild(hint);
  }
  initNextChapterConfirm();

  // อ่านตอนนี้แล้ว: อัปเดตสถานะในรายชื่อตอนที่ถืออยู่ในมือเลย ไม่ต้องรอโหลดใหม่จากเซิร์ฟเวอร์
  const row = currentChapters.find((c) => c.url === currentChapterData.url);
  if (row) {
    row.is_read = true;
    lastReadUrl = row.url;
    const cached = chapterListCache.get(readerMangaId);
    if (cached) cached.last_read_url = row.url;
  }
  mangaListStale = true;
}

async function loadChapter(mangaId, chapterUrl, restoreFraction = null) {
  const reader = el("#reader");
  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
  const bottombar = el("#readerBottombar");
  reader.hidden = false;
  document.body.style.overflow = "hidden";
  el("#readerPrev").disabled = true;
  el("#readerNext").disabled = true;
  // กันไว้ตลอดช่วงโหลด (ไม่ปล่อยจนกว่าจะเสร็จ) เพราะการ set scrollTop=0 ด้านล่างเองก็ยิง
  // scroll event ได้ ถ้าปล่อย flag เร็วไปจะเช็คซ้ำจากเนื้อหา "กำลังโหลด..." ที่สั้นมาก แล้วยิงเปลี่ยนตอนซ้อนอีกรอบ
  autoAdvancing = true;
  readerMangaId = mangaId;

  // เผื่อพื้นที่บน/ล่างให้พอดีกับแถบ nav ทั้งสอง (ลอยทับ) กันไม่ให้บังรูป
  topbar.classList.remove("nav-hidden");
  bottombar.classList.remove("nav-hidden");
  body.style.paddingTop = topbar.offsetHeight + "px";
  body.style.paddingBottom = bottombar.offsetHeight + "px";
  body.scrollTop = 0;
  initReaderAutoHide();

  const prefetched = prefetchedChapters.get(chapterUrl);
  if (prefetched) {
    // มีข้อมูลตอนนี้อยู่แล้วจากที่โหลดล่วงหน้าไว้ — วาดทันที แล้วค่อยแจ้งเซิร์ฟเวอร์ว่าอ่านแล้ว
    // เบื้องหลัง (ครั้งนี้ไม่ใส่ peek) หน้าอ่านจึงเปลี่ยนตอนได้โดยไม่มีจังหวะค้างรอเน็ตเลย
    prefetchedChapters.delete(chapterUrl);
    renderChapter(prefetched, chapterUrl, restoreFraction);
    autoAdvancing = false;
    fetch(`/api/manga/${mangaId}/chapter?url=${encodeURIComponent(chapterUrl)}`).catch(() => {});
    prefetchNextChapter();
    return;
  }

  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  const qs = chapterUrl ? `?url=${encodeURIComponent(chapterUrl)}` : "";
  try {
    const data = await getJSON(`/api/manga/${mangaId}/chapter${qs}`);
    renderChapter(data, chapterUrl, restoreFraction);
  } catch (e) {
    body.innerHTML = `<div class="reader-msg">${escapeHtml(e.body?.error || "เกิดข้อผิดพลาด: " + e)}</div>`;
  } finally {
    autoAdvancing = false;
  }
}

// เช็คทุกครั้งที่เลื่อน ว่าถึงล่างสุดของตอนที่กำลังอ่านจริง ๆ หรือยัง ถ้าถึงแล้วโชว์ข้อความ
// "เลื่อนต่ออีกทีเพื่อไปตอนถัดไป" ไว้ก่อน ยังไม่เปลี่ยนตอนทันที ต้องรอ confirm อีกจังหวะ
// (กันเปลี่ยนตอนเร็วเกินไปทั้งที่ยังอ่านหน้าสุดท้ายไม่จบ)
function checkAutoAdvance() {
  const hint = el("#nextHint");
  if (!currentChapterData.nextUrl) return;
  const body = el("#readerBody");
  const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
  // ต้องมีเนื้อหาให้เลื่อนจริง ๆ ก่อน — ช่วงแรกหลังเปลี่ยนตอน รูปยังโหลดไม่เสร็จจึงยังไม่มีความสูง
  // ถ้าไม่เช็คตรงนี้ หน้าที่ยังว่างอยู่จะนับว่า "ถึงล่างสุดแล้ว" ทันที แล้วสไลด์ทีเดียวข้ามไปหลายตอนรวด
  const scrollable = body.scrollHeight > body.clientHeight + 40;
  const atBottom = scrollable && remaining < 40;
  awaitingConfirmScroll = atBottom;
  if (hint) hint.classList.toggle("show", atBottom);
  // อ่านมาเกินครึ่งตอนแล้ว เริ่มโหลดตอนถัดไปรอไว้เงียบ ๆ
  if (currentScrollFraction > 0.5) prefetchNextChapter();
}

function confirmAdvanceToNext() {
  if (autoAdvancing || !gestureArmed || !awaitingConfirmScroll || !currentChapterData.nextUrl) return;
  autoAdvancing = true;
  awaitingConfirmScroll = false;
  // หนึ่งครั้งที่สไลด์ = เปลี่ยนได้ตอนเดียว ต้องยกนิ้วแล้วสไลด์ใหม่ถึงจะไปตอนถัดไปได้อีก
  gestureArmed = false;
  loadChapter(readerMangaId, currentChapterData.nextUrl);
}

// ต้องดักจังหวะ "เลื่อน/สไลด์ต่อ" หลังจากถึงล่างสุดแล้ว (scrollTop ไปต่อไม่ได้แล้ว เลย
// ไม่มี scroll event เกิดขึ้นอีก) ด้วย wheel (เมาส์/trackpad) และ touchmove (มือถือ) แทน
let nextChapterConfirmInit = false;
function initNextChapterConfirm() {
  if (nextChapterConfirmInit) return;
  nextChapterConfirmInit = true;
  initTopPin();
  initRestoreCancel();

  const body = el("#readerBody");
  // เมาส์/trackpad ไม่มีจังหวะ "ยกนิ้ว" ให้จับ ใช้การหยุดหมุนสั้น ๆ แทนเป็นตัวแบ่งว่าเป็นคนละครั้ง
  // (trackpad ส่ง event ต่อเนื่องจากแรงเฉื่อยอีกพักหลังยกนิ้ว ถ้าไม่รอให้นิ่งก่อนจะข้ามตอนรวด)
  let wheelIdleTimer = null;
  let lastWheelAt = 0;
  body.addEventListener(
    "wheel",
    (e) => {
      // ล้อหมุนครั้งแรกหลังเงียบไปนาน = เริ่มสไลด์รอบใหม่ (กรณีเพิ่งเปลี่ยนตอนด้วยนิ้วบนจอทัชมา
      // gestureArmed จะยังเป็น false อยู่ ถ้าไม่เช็คตรงนี้ ล้อรอบแรกจะถูกกลืนไปเปล่า ๆ)
      const now = performance.now();
      if (now - lastWheelAt > 400) gestureArmed = true;
      lastWheelAt = now;
      if (awaitingConfirmScroll && e.deltaY > 0) confirmAdvanceToNext();
      clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        gestureArmed = true;
        releaseTopPin(); // หยุดหมุนไปแล้ว รอบต่อไปคือการเลื่อนอ่านจริง
      }, 400);
    },
    { passive: true }
  );

  let touchStartY = null;
  body.addEventListener(
    "touchstart",
    (e) => {
      touchStartY = e.touches[0].clientY;
      gestureArmed = true; // แตะใหม่ = เริ่มนับเป็นการสไลด์ครั้งใหม่
    },
    { passive: true }
  );
  body.addEventListener(
    "touchmove",
    (e) => {
      if (touchStartY === null || !awaitingConfirmScroll) return;
      const draggedUp = touchStartY - e.touches[0].clientY; // นิ้วเลื่อนขึ้น = พยายามเลื่อนเนื้อหาลงต่อ
      if (draggedUp > 40) confirmAdvanceToNext();
    },
    { passive: true }
  );
}

// ซ่อนแถบ nav ตอนเลื่อนลงอ่าน โชว์กลับมาตอนเลื่อนขึ้น (เหมือนเว็บแอปทั่วไป)
let readerAutoHideInit = false;
function initReaderAutoHide() {
  if (readerAutoHideInit) return;
  readerAutoHideInit = true;

  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
  const bottombar = el("#readerBottombar");
  let lastScrollTop = 0;
  let ticking = false;

  body.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const scrollTop = body.scrollTop;
        const delta = scrollTop - lastScrollTop;
        if (scrollTop < 40) {
          topbar.classList.remove("nav-hidden");
          bottombar.classList.remove("nav-hidden");
        } else if (delta > 4) {
          topbar.classList.add("nav-hidden");
          bottombar.classList.add("nav-hidden");
        } else if (delta < -4) {
          topbar.classList.remove("nav-hidden");
          bottombar.classList.remove("nav-hidden");
        }
        lastScrollTop = scrollTop;
        // ระหว่างกำลังเลื่อนกลับไปตำแหน่งเดิม (รูปยังโหลดไม่ครบ) ค่าที่อ่านได้ตอนนี้เพี้ยน ห้ามเอาไปทับ
        if (restoreTarget === null && !pinnedToTop) {
          const max = body.scrollHeight - body.clientHeight;
          currentScrollFraction = max > 0 ? Math.max(0, Math.min(1, scrollTop / max)) : 0;
          scheduleScrollSave();
        }
        checkAutoAdvance();
        ticking = false;
      });
    },
    { passive: true }
  );

  // เผื่อกดออกแอป/สลับแท็บโดยไม่ได้กดปุ่มกลับ (เช่นมีธุระเข้ากะทันหัน) ยังเซฟตำแหน่งให้ — pagehide
  // ด้วยเพราะ iOS Safari บางครั้งปิดหน้าโดยไม่ยิง visibilitychange
  const saveIfReading = () => {
    if (!el("#reader").hidden) saveScrollPosition();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveIfReading();
  });
  window.addEventListener("pagehide", saveIfReading);
}

async function closeReader() {
  // saveScrollPosition จำตำแหน่งไว้ในหน้าเว็บทันที (ก่อนส่งเซิร์ฟเวอร์) หน้าเลือกตอนด้านล่างจึงวาดจากค่าที่
  // ถูกต้องได้เลย ไม่ต้องรอ — ส่วนการโหลดรายชื่อตอนใหม่จากเซิร์ฟเวอร์ต้องรอให้บันทึกเสร็จก่อนเสมอ ไม่งั้น
  // สองคำขอวิ่งชนกันและได้ค่าเก่ากลับมา
  const saved = saveScrollPosition();
  cancelRestore();
  el("#reader").hidden = true;
  prefetchedChapters.clear();
  document.body.style.overflow = "";
  if (currentManga) {
    // กลับไปหน้าเลือกตอน พร้อมสถานะอ่านแล้วที่อัปเดตล่าสุด (วาดจากของในมือก่อน แล้วค่อยเช็คของจริง)
    el("#chapterListView").hidden = false;
    document.body.style.overflow = "hidden";
    renderChapterRows(currentChapters);
    scrollToLastRead();
    await saved;
    renderChapterList({ keepScroll: true });
  }
}

function init() {
  applyAdminGating();
  renderGrid();

  initTabs();
  initSubTabs();
  initGridClicks();
  initSettingsClicks();
  initChapterListClicks();
  initMangaForm();
  initChapterSearch();
  initCatalogSearch();
  initAddUserForm();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });

  el("#refreshAllBtn").addEventListener("click", refreshAll);
  el("#readerClose").addEventListener("click", closeReader);
  el("#chapterListClose").addEventListener("click", closeChapterList);
  el("#readerPrev").addEventListener("click", goPrevChapter);
  el("#readerNext").addEventListener("click", goNextChapter);
}

init();
