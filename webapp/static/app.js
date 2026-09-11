const state = {
  manga: [],
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

// ---------- Tabs ----------
function initTabs() {
  els(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els(".tab-btn").forEach((b) => b.classList.remove("active"));
      els(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      el(`#${btn.dataset.tab}View`).classList.add("active");
      if (btn.dataset.tab === "settings") renderSettings();
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
  btn.textContent = "กำลังรีเฟรช...";
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
    btn.textContent = "รีเฟรชทั้งหมด";
    setTimeout(() => { status.hidden = true; }, 6000);
  }
}

// ---------- Settings ----------
function renderSettings() {
  const list = el("#settingsList");
  list.innerHTML = "";
  for (const m of state.manga) {
    const row = document.createElement("li");
    row.className = "settings-row";
    row.innerHTML = `
      <img src="${m.cover_url ? proxied(m.cover_url) : ""}" alt="" onerror="this.style.opacity=0" />
      <div class="grow">
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="meta">${escapeHtml(m.source)} — ${m.latest_chapter ? escapeHtml(m.latest_chapter) : "-"}</div>
      </div>
      <button class="btn" data-action="refresh">รีเฟรช</button>
      <button class="btn danger" data-action="delete">ลบ</button>
    `;
    row.querySelector('[data-action="refresh"]').addEventListener("click", () => refreshOne(m.id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteManga(m.id, m.name));
    list.appendChild(row);
  }
}

async function refreshOne(id) {
  await fetch(`/api/manga/${id}/refresh`, { method: "POST" });
  await loadManga();
  renderSettings();
}

async function deleteManga(id, name) {
  if (!confirm(`ลบ "${name}" ออกจากรายการ?`)) return;
  await fetch(`/api/manga/${id}`, { method: "DELETE" });
  await loadManga();
  renderSettings();
}

function initAddForm() {
  el("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("#addName").value.trim();
    const url = el("#addUrl").value.trim();
    const msg = el("#addFormMsg");
    msg.className = "form-msg";
    msg.textContent = "กำลังเพิ่ม...";

    try {
      const res = await fetch("/api/manga", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      const data = await res.json();
      if (!res.ok) {
        msg.classList.add("error");
        msg.textContent = data.error || "เพิ่มไม่สำเร็จ";
        return;
      }
      msg.classList.add("success");
      msg.textContent = `เพิ่ม "${name}" สำเร็จ`;
      el("#addForm").reset();
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

async function openChapterList(manga) {
  currentManga = { id: manga.id, name: manga.name };
  const view = el("#chapterListView");
  const body = el("#chapterListBody");
  view.hidden = false;
  document.body.style.overflow = "hidden";
  el("#chapterListMangaName").textContent = manga.name;
  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';

  await renderChapterList();
}

async function renderChapterList() {
  const body = el("#chapterListBody");
  try {
    const res = await fetch(`/api/manga/${currentManga.id}/chapters`);
    const data = await res.json();
    if (!res.ok) {
      body.innerHTML = `<div class="reader-msg">${escapeHtml(data.error || "โหลดไม่สำเร็จ")}</div>`;
      return;
    }

    if (!data.chapters || data.chapters.length === 0) {
      body.innerHTML = '<div class="reader-msg">ยังไม่มีข้อมูลรายชื่อตอน ลองรีเฟรชเรื่องนี้ในแท็บ "ตั้งค่า" ก่อน</div>';
      return;
    }

    body.innerHTML = "";
    for (const c of data.chapters) {
      const row = document.createElement("div");
      row.className = "chapter-row" + (c.is_read ? " read" : "");
      row.innerHTML = `
        <span class="chapter-text">${escapeHtml(c.text)}</span>
        ${c.date ? `<span class="chapter-date">${escapeHtml(c.date)}</span>` : ""}
        ${!c.is_read ? '<span class="new-badge">NEW!</span>' : ""}
      `;
      row.addEventListener("click", () => openReader(c.url));
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = `<div class="reader-msg">เกิดข้อผิดพลาด: ${e}</div>`;
  }
}

function closeChapterList() {
  el("#chapterListView").hidden = true;
  document.body.style.overflow = "";
  currentManga = null;
  loadManga();
}

// ---------- Reader ----------
async function openReader(chapterUrl) {
  el("#chapterListView").hidden = true;
  await loadChapter(currentManga.id, chapterUrl);
}

async function loadChapter(mangaId, chapterUrl) {
  const reader = el("#reader");
  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
  reader.hidden = false;
  document.body.style.overflow = "hidden";
  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  el("#readerPrev").disabled = true;
  el("#readerNext").disabled = true;

  // เผื่อพื้นที่ด้านบนให้พอดีกับแถบ nav (ลอยทับ) กันไม่ให้บังรูปหน้าแรก
  topbar.classList.remove("nav-hidden");
  body.style.paddingTop = topbar.offsetHeight + "px";
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
    el("#readerChapterName").textContent = data.chapter_text || "";

    if (!data.images || data.images.length === 0) {
      body.innerHTML = '<div class="reader-msg">ไม่พบรูปภาพในตอนนี้</div>';
    } else {
      body.innerHTML = "";
      for (const src of data.images) {
        const img = document.createElement("img");
        img.src = proxied(src);
        img.loading = "lazy";
        body.appendChild(img);
      }
    }

    el("#readerPrev").disabled = !data.prev_url;
    el("#readerNext").disabled = !data.next_url;
    el("#readerPrev").onclick = () => loadChapter(mangaId, data.prev_url);
    el("#readerNext").onclick = () => loadChapter(mangaId, data.next_url);

    // อัปเดตสถานะ NEW ที่หน้าหลักและหน้าเลือกตอนแบบเงียบ ๆ ในพื้นหลัง
    loadManga();
  } catch (e) {
    body.innerHTML = `<div class="reader-msg">เกิดข้อผิดพลาด: ${e}</div>`;
  }
}

// ซ่อนแถบ nav ตอนเลื่อนลงอ่าน โชว์กลับมาตอนเลื่อนขึ้น (เหมือนเว็บแอปทั่วไป)
let readerAutoHideInit = false;
function initReaderAutoHide() {
  if (readerAutoHideInit) return;
  readerAutoHideInit = true;

  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
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
      } else if (delta > 4) {
        topbar.classList.add("nav-hidden");
      } else if (delta < -4) {
        topbar.classList.remove("nav-hidden");
      }
      lastScrollTop = scrollTop;
      ticking = false;
    });
  });
}

function closeReader() {
  el("#reader").hidden = true;
  document.body.style.overflow = "";
  if (currentManga) {
    // กลับไปหน้าเลือกตอน พร้อมสถานะอ่านแล้วที่อัปเดตล่าสุด
    el("#chapterListView").hidden = false;
    document.body.style.overflow = "hidden";
    renderChapterList();
  }
}

function init() {
  initTabs();
  initAddForm();
  el("#refreshAllBtn").addEventListener("click", refreshAll);
  el("#readerClose").addEventListener("click", closeReader);
  el("#chapterListClose").addEventListener("click", closeChapterList);
  loadManga();
}

document.addEventListener("DOMContentLoaded", init);
