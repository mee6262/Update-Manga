const state = {
  manga: [],
  catalog: [],
  currentUser: { username: null, is_admin: false },
};

const el = (sel) => document.querySelector(sel);
const els = (sel) => Array.from(document.querySelectorAll(sel));

function proxied(url) {
  if (!url) return "";
  return "/api/img?src=" + encodeURIComponent(url);
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

// ---------- Current user / admin gating ----------
async function loadCurrentUser() {
  try {
    const res = await fetch("/api/me");
    state.currentUser = await res.json();
  } catch (e) {
    state.currentUser = { username: null, is_admin: false };
  }
  els(".admin-only").forEach((elm) => { elm.hidden = !state.currentUser.is_admin; });
}

// ---------- Tabs ----------
function initTabs() {
  els(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els(".tab-btn").forEach((b) => b.classList.remove("active"));
      els(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      el(`#${btn.dataset.tab}View`).classList.add("active");
      if (btn.dataset.tab === "settings") loadCatalog().then(renderSettings);
      if (btn.dataset.tab === "catalog") loadCatalog().then(() => renderCatalog(filterCatalog()));
      if (btn.dataset.tab === "settings") renderUserList();
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
  const res = await fetch("/api/manga");
  state.manga = await res.json();
  renderGrid();
}

function renderGrid() {
  const grid = el("#mangaGrid");
  const empty = el("#emptyState");
  grid.innerHTML = "";

  if (state.manga.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const m of state.manga) {
    const card = document.createElement("div");
    card.className = "manga-card";
    card.innerHTML = `
      ${m.is_new ? '<span class="new-badge">NEW!</span>' : ""}
      <img class="manga-cover" src="${m.cover_url ? proxied(m.cover_url) : ""}" alt="${m.name}" loading="lazy" onerror="this.style.opacity=0" />
      <div class="manga-info">
        <div class="manga-name">${escapeHtml(m.name)}</div>
        <div class="manga-chapter">${m.latest_chapter ? escapeHtml(m.latest_chapter) : "ยังไม่ทราบตอนล่าสุด"}</div>
        <div class="manga-chapter">${timeAgo(m.last_checked_at)}</div>
      </div>
    `;
    card.addEventListener("click", () => openChapterList(m));
    grid.appendChild(card);
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
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
function renderSettings() {
  const list = el("#settingsList");
  list.innerHTML = "";
  for (const m of state.catalog) {
    const sourceCount = (m.sources || []).length;
    const sourceLabel = sourceCount > 1 ? `${escapeHtml(m.source)} +${sourceCount - 1} แหล่ง` : escapeHtml(m.source);
    const row = document.createElement("li");
    row.className = "settings-row";
    row.innerHTML = `
      <img src="${m.cover_url ? proxied(m.cover_url) : ""}" alt="" onerror="this.style.opacity=0" />
      <div class="grow">
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="meta">${sourceLabel} — ${m.latest_chapter ? escapeHtml(m.latest_chapter) : "-"}</div>
      </div>
      <button class="btn" data-action="edit">แก้ไข</button>
      <button class="btn" data-action="refresh">รีเฟรช</button>
      <button class="btn danger" data-action="delete">ลบออกจากระบบ</button>
    `;
    row.querySelector('[data-action="edit"]').addEventListener("click", () => openMangaModal(m));
    row.querySelector('[data-action="refresh"]').addEventListener("click", () => refreshOne(m.id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteManga(m.id, m.name));
    list.appendChild(row);
  }
}

async function refreshOne(id) {
  await fetch(`/api/manga/${id}/refresh`, { method: "POST" });
  await loadManga();
  await loadCatalog();
  renderSettings();
}

async function deleteManga(id, name) {
  if (!confirm(`ลบ "${name}" ออกจากระบบ? (ทุกคนจะติดตามไม่ได้อีก)`)) return;
  await fetch(`/api/manga/${id}`, { method: "DELETE" });
  await loadManga();
  await loadCatalog();
  renderSettings();
}

// ---------- Catalog (เรื่องทั้งหมดในระบบ ไว้เลือกติดตาม) ----------
async function loadCatalog() {
  const res = await fetch("/api/catalog");
  state.catalog = await res.json();
}

function renderCatalog(items = state.catalog) {
  const grid = el("#catalogGrid");
  const empty = el("#catalogEmpty");
  grid.innerHTML = "";

  if (items.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const m of items) {
    const card = document.createElement("div");
    card.className = "manga-card";
    card.innerHTML = `
      <img class="manga-cover" src="${m.cover_url ? proxied(m.cover_url) : ""}" alt="${m.name}" loading="lazy" onerror="this.style.opacity=0" />
      <div class="manga-info">
        <div class="manga-name">${escapeHtml(m.name)}</div>
        <div class="manga-chapter">${m.latest_chapter ? escapeHtml(m.latest_chapter) : "ยังไม่ทราบตอนล่าสุด"}</div>
        <button class="follow-btn${m.is_subscribed ? " subscribed" : ""}" data-action="toggle-follow">
          ${m.is_subscribed ? "✓ ติดตามอยู่" : "+ ติดตาม"}
        </button>
      </div>
    `;
    card.addEventListener("click", () => openChapterList(m));
    card.querySelector('[data-action="toggle-follow"]').addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSubscribe(m.id, m.is_subscribed);
    });
    grid.appendChild(card);
  }
}

async function toggleSubscribe(id, currentlySubscribed) {
  const action = currentlySubscribed ? "unsubscribe" : "subscribe";
  await fetch(`/api/catalog/${id}/${action}`, { method: "POST" });
  await loadCatalog();
  renderCatalog(filterCatalog());
  loadManga(); // อัปเดตหน้าแรกด้วยเงียบ ๆ
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

async function initCatalogSearch() {
  el("#catalogSearch").addEventListener("input", () => renderCatalog(filterCatalog()));

  const sortSelect = el("#catalogSort");
  // ลำดับที่เลือกไว้เก็บฝั่งเซิร์ฟเวอร์แยกบัญชีใครบัญชีมัน (ไม่ใช่ localStorage) ผู้ใช้แต่ละคน
  // ตั้งค่าของตัวเองได้อิสระ ไม่ปนกัน
  try {
    const res = await fetch("/api/prefs");
    const prefs = await res.json();
    if (prefs.catalog_sort) sortSelect.value = prefs.catalog_sort;
  } catch (e) {
    // ใช้ค่า default ต่อไปได้ถ้าโหลดไม่สำเร็จ
  }
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
    const res = await fetch("/api/users");
    if (!res.ok) return; // ไม่ใช่ admin หรือยังไม่ login
    const users = await res.json();
    list.innerHTML = "";
    for (const u of users) {
      const row = document.createElement("li");
      row.className = "settings-row";
      row.innerHTML = `
        <div class="grow">
          <div class="name">${escapeHtml(u.username)}${u.is_admin ? " (admin)" : ""}</div>
        </div>
      `;
      list.appendChild(row);
    }
  } catch (e) {
    // เงียบไว้ ไม่ใช่ประเด็นสำคัญถ้าโหลดรายชื่อสมาชิกไม่ได้
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
      await loadCatalog();
      await loadManga();
      renderSettings();
    } catch (err) {
      msg.classList.add("error");
      msg.textContent = "เกิดข้อผิดพลาด: " + err;
    }
  });
}

// ---------- Chapter list ----------
let currentManga = null; // { id, name }
let currentChapters = []; // รายการตอนทั้งหมดที่โหลดมา (ยังไม่กรอง) ไว้ใช้กรองตอนค้นหา
let lastReadUrl = null; // ตอนล่าสุดที่อ่าน ไว้เลื่อนหาอัตโนมัติตอนเปิดหน้าเลือกตอน
let lastScrollInfo = null; // { url, fraction } ตำแหน่งที่เลื่อนค้างไว้ในตอนล่าสุดที่อ่าน (ยังอ่านไม่จบ)

const BOOKMARK_ICON =
  '<svg class="bookmark-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" fill="currentColor"/></svg>';

async function openChapterList(manga) {
  currentManga = { id: manga.id, name: manga.name, latest_chapter_url: manga.latest_chapter_url };
  const view = el("#chapterListView");
  const body = el("#chapterListBody");
  const search = el("#chapterSearch");
  view.hidden = false;
  document.body.style.overflow = "hidden";
  el("#chapterListMangaName").textContent = manga.name;
  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  search.value = "";

  await renderChapterList();
}

async function renderChapterList() {
  const body = el("#chapterListBody");
  try {
    const res = await fetch(`/api/manga/${currentManga.id}/chapters`);
    const data = await res.json();
    if (!res.ok) {
      currentChapters = [];
      body.innerHTML = `<div class="reader-msg">${escapeHtml(data.error || "โหลดไม่สำเร็จ")}</div>`;
      return;
    }

    currentChapters = data.chapters || [];
    lastReadUrl = data.last_read_url || null;
    lastScrollInfo = data.last_scroll || null;
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

    renderChapterRows(currentChapters);
    scrollToLastRead();
  } catch (e) {
    currentChapters = [];
    body.innerHTML = `<div class="reader-msg">เกิดข้อผิดพลาด: ${e}</div>`;
  }
}

function renderChapterRows(chapters) {
  const body = el("#chapterListBody");
  body.innerHTML = "";

  if (chapters.length === 0) {
    body.innerHTML = '<div class="reader-msg">ไม่พบตอนที่ค้นหา</div>';
    return;
  }

  for (const c of chapters) {
    const isLastRead = c.url === lastReadUrl;
    const row = document.createElement("div");
    row.className = "chapter-row" + (c.is_read ? " read" : "") + (isLastRead ? " last-read" : "");
    row.dataset.url = c.url;
    row.innerHTML = `
      ${isLastRead ? BOOKMARK_ICON : ""}
      <span class="chapter-text">${escapeHtml(c.text)}</span>
      ${c.date ? `<span class="chapter-date">${escapeHtml(c.date)}</span>` : ""}
      ${!c.is_read ? '<span class="new-badge">NEW!</span>' : ""}
    `;
    row.addEventListener("click", () => openReader(c.url));
    body.appendChild(row);
  }
}

// เลื่อนหาแถวตอนล่าสุดที่อ่าน ให้อยู่กลางจอ จะได้อ่านต่อง่ายไม่ต้องไล่หาเอง
function scrollToLastRead() {
  if (!lastReadUrl) return;
  const body = el("#chapterListBody");
  const row = body.querySelector(`.chapter-row[data-url="${CSS.escape(lastReadUrl)}"]`);
  if (row) row.scrollIntoView({ block: "center", behavior: "auto" });
}

function initChapterSearch() {
  el("#chapterSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    if (!q) {
      renderChapterRows(currentChapters);
      return;
    }
    const filtered = currentChapters.filter((c) => c.text.includes(q));
    renderChapterRows(filtered);
  });
}

function closeChapterList() {
  el("#chapterListView").hidden = true;
  document.body.style.overflow = "";
  currentManga = null;
  currentChapters = [];
  loadManga();
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

let currentScrollFraction = 0; // สัดส่วนที่เลื่อนอ่านมาแล้วของตอนปัจจุบัน (0-1) อัปเดตทุกครั้งที่เลื่อน

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
  for (const src of images) {
    const img = document.createElement("img");
    img.src = proxied(src);
    body.appendChild(img);
  }
}

// เก็บตำแหน่งที่เลื่อนค้างไว้ของตอนปัจจุบัน ไว้กลับมาอ่านต่อจากจุดเดิมได้ (fire-and-forget)
function saveScrollPosition() {
  if (!readerMangaId || !currentChapterData.url) return Promise.resolve();
  return fetch(`/api/manga/${readerMangaId}/scroll_position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: currentChapterData.url, fraction: currentScrollFraction }),
    keepalive: true,
  }).catch(() => {});
}

// เลื่อนไปตำแหน่งที่ค้างไว้ ทำซ้ำหลายจังหวะเพราะรูปโหลดแบบทยอย ๆ scrollHeight รวมจะค่อย ๆ นิ่งขึ้นเรื่อย ๆ
function restoreScrollPosition(fraction) {
  const body = el("#readerBody");
  const apply = () => {
    const max = body.scrollHeight - body.clientHeight;
    if (max > 0) body.scrollTop = fraction * max;
  };
  apply();
  setTimeout(apply, 400);
  setTimeout(apply, 1200);
}

function goPrevChapter() {
  if (currentChapterData.prevUrl) loadChapter(readerMangaId, currentChapterData.prevUrl);
}

function goNextChapter() {
  if (currentChapterData.nextUrl) loadChapter(readerMangaId, currentChapterData.nextUrl);
}

async function loadChapter(mangaId, chapterUrl, restoreFraction = null) {
  const reader = el("#reader");
  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
  const bottombar = el("#readerBottombar");
  reader.hidden = false;
  document.body.style.overflow = "hidden";
  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
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

  const qs = chapterUrl ? `?url=${encodeURIComponent(chapterUrl)}` : "";
  try {
    const res = await fetch(`/api/manga/${mangaId}/chapter${qs}`);
    const data = await res.json();
    if (!res.ok) {
      body.innerHTML = `<div class="reader-msg">${escapeHtml(data.error || "โหลดไม่สำเร็จ")}</div>`;
      return;
    }

    el("#readerMangaName").textContent = data.manga_name || "";
    el("#readerChapterName").textContent = data.chapter_text || findChapterText(chapterUrl) || "";

    if (!data.images || data.images.length === 0) {
      body.innerHTML = '<div class="reader-msg">ไม่พบรูปภาพในตอนนี้</div>';
    } else {
      body.innerHTML = "";
      appendChapterImages(data.images);
      if (restoreFraction) restoreScrollPosition(restoreFraction);
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

    // อัปเดตสถานะ NEW ที่หน้าหลักและหน้าเลือกตอนแบบเงียบ ๆ ในพื้นหลัง
    loadManga();
  } catch (e) {
    body.innerHTML = `<div class="reader-msg">เกิดข้อผิดพลาด: ${e}</div>`;
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
  const atBottom = remaining < 40;
  awaitingConfirmScroll = atBottom;
  if (hint) hint.classList.toggle("show", atBottom);
}

function confirmAdvanceToNext() {
  if (autoAdvancing || !awaitingConfirmScroll || !currentChapterData.nextUrl) return;
  autoAdvancing = true;
  awaitingConfirmScroll = false;
  loadChapter(readerMangaId, currentChapterData.nextUrl);
}

// ต้องดักจังหวะ "เลื่อน/สไลด์ต่อ" หลังจากถึงล่างสุดแล้ว (scrollTop ไปต่อไม่ได้แล้ว เลย
// ไม่มี scroll event เกิดขึ้นอีก) ด้วย wheel (เมาส์/trackpad) และ touchmove (มือถือ) แทน
let nextChapterConfirmInit = false;
function initNextChapterConfirm() {
  if (nextChapterConfirmInit) return;
  nextChapterConfirmInit = true;

  const body = el("#readerBody");
  body.addEventListener(
    "wheel",
    (e) => {
      if (awaitingConfirmScroll && e.deltaY > 0) confirmAdvanceToNext();
    },
    { passive: true }
  );

  let touchStartY = null;
  body.addEventListener(
    "touchstart",
    (e) => {
      touchStartY = e.touches[0].clientY;
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

  body.addEventListener("scroll", () => {
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
      const max = body.scrollHeight - body.clientHeight;
      currentScrollFraction = max > 0 ? Math.max(0, Math.min(1, scrollTop / max)) : 0;
      checkAutoAdvance();
      ticking = false;
    });
  });

  // เผื่อกดออกแอป/สลับแท็บโดยไม่ได้กดปุ่มกลับ (เช่นมีธุระเข้ากะทันหัน) ยังเซฟตำแหน่งให้
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !el("#reader").hidden) saveScrollPosition();
  });
}

async function closeReader() {
  await saveScrollPosition();
  el("#reader").hidden = true;
  document.body.style.overflow = "";
  if (currentManga) {
    // กลับไปหน้าเลือกตอน พร้อมสถานะอ่านแล้วที่อัปเดตล่าสุด
    el("#chapterListView").hidden = false;
    document.body.style.overflow = "hidden";
    renderChapterList();
  }
}

async function init() {
  initTabs();
  initSubTabs();
  initMangaForm();
  initChapterSearch();
  await initCatalogSearch();
  initAddUserForm();
  el("#refreshAllBtn").addEventListener("click", refreshAll);
  el("#readerClose").addEventListener("click", closeReader);
  el("#chapterListClose").addEventListener("click", closeChapterList);
  el("#readerPrev").addEventListener("click", goPrevChapter);
  el("#readerNext").addEventListener("click", goNextChapter);
  await loadCurrentUser();
  loadManga();
}

document.addEventListener("DOMContentLoaded", init);
