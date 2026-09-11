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
let currentChapters = []; // รายการตอนทั้งหมดที่โหลดมา (ยังไม่กรอง) ไว้ใช้กรองตอนค้นหา
let lastReadUrl = null; // ตอนล่าสุดที่อ่าน ไว้เลื่อนหาอัตโนมัติตอนเปิดหน้าเลือกตอน

async function openChapterList(manga) {
  currentManga = { id: manga.id, name: manga.name };
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
    if (currentChapters.length === 0) {
      body.innerHTML = '<div class="reader-msg">ยังไม่มีข้อมูลรายชื่อตอน ลองรีเฟรชเรื่องนี้ในแท็บ "ตั้งค่า" ก่อน</div>';
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
    const row = document.createElement("div");
    row.className = "chapter-row" + (c.is_read ? " read" : "");
    row.dataset.url = c.url;
    row.innerHTML = `
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
// อ่านต่อเนื่องแบบ Webtoon/Kakaotoon: เลื่อนใกล้ท้ายตอนแล้วต่อรูปตอนถัดไปให้อัตโนมัติ
// โดยไม่ reload หน้า — ปุ่ม/หัวข้อขยับตามจริงว่าตอนนี้เลื่อนมาอยู่ตอนไหนแล้ว
let activeChapterMeta = { url: null, text: "", prevUrl: null, nextUrl: null };
let initialChapterMeta = activeChapterMeta; // ตอนแรกที่เปิดมา (hard reload) ไว้ย้อนกลับตอนเลื่อนขึ้นเหนือ divider ทั้งหมด
let loadedDividers = []; // [{ el, meta }] เรียงตามลำดับที่ต่อท้ายเข้ามา ไว้เช็คว่าเลื่อนผ่านตอนไหนมาแล้ว
let loadedChapterUrls = new Set();
let tailNextUrl = null; // ตอนถัดไปของ "ตอนสุดท้ายที่โหลดมาต่อท้ายแล้ว" (ไว้เช็คตอนเลื่อนใกล้ล่างสุด)
let isLoadingNextChapter = false;
let readerMangaId = null;

async function openReader(chapterUrl) {
  el("#chapterListView").hidden = true;
  await loadChapter(currentManga.id, chapterUrl);
}

function updateChapterMeta(meta) {
  activeChapterMeta = meta;
  el("#readerChapterName").textContent = meta.text || "";
  el("#readerPrev").disabled = !meta.prevUrl;
  el("#readerNext").disabled = !meta.nextUrl;
}

function goPrevChapter() {
  if (activeChapterMeta.prevUrl) loadChapter(readerMangaId, activeChapterMeta.prevUrl);
}

function goNextChapter() {
  if (activeChapterMeta.nextUrl) loadChapter(readerMangaId, activeChapterMeta.nextUrl);
}

function appendChapterImages(images) {
  const body = el("#readerBody");
  for (const src of images) {
    const img = document.createElement("img");
    img.src = proxied(src);
    img.loading = "lazy";
    body.appendChild(img);
  }
}

async function loadChapter(mangaId, chapterUrl) {
  const reader = el("#reader");
  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
  const bottombar = el("#readerBottombar");
  reader.hidden = false;
  document.body.style.overflow = "hidden";
  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  el("#readerPrev").disabled = true;
  el("#readerNext").disabled = true;

  // เปิดตอนใหม่แบบ hard reload เคลียร์สถานะของ infinite scroll เดิมทิ้ง
  loadedDividers = [];
  loadedChapterUrls = new Set();
  tailNextUrl = null;
  isLoadingNextChapter = false;
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
    const chapterText = data.chapter_text || findChapterText(chapterUrl) || "";
    const resolvedUrl = data.chapter_url || chapterUrl;

    if (!data.images || data.images.length === 0) {
      body.innerHTML = '<div class="reader-msg">ไม่พบรูปภาพในตอนนี้</div>';
    } else {
      body.innerHTML = "";
      appendChapterImages(data.images);
    }

    loadedChapterUrls.add(resolvedUrl);
    initialChapterMeta = { url: resolvedUrl, text: chapterText, prevUrl: data.prev_url, nextUrl: data.next_url };
    updateChapterMeta(initialChapterMeta);
    tailNextUrl = data.next_url || null;
    checkLoadMoreOnScroll(); // เผื่อตอนสั้นจนไม่ต้องเลื่อนก็เห็นท้ายสุดอยู่แล้ว

    // อัปเดตสถานะ NEW ที่หน้าหลักและหน้าเลือกตอนแบบเงียบ ๆ ในพื้นหลัง
    loadManga();
  } catch (e) {
    body.innerHTML = `<div class="reader-msg">เกิดข้อผิดพลาด: ${e}</div>`;
  }
}

// เช็คทุกครั้งที่เลื่อน (เรียกจาก scroll handler เดียวกับ auto-hide) ว่าใกล้ล่างสุดของที่โหลดมาแล้วหรือยัง
// ใช้ scrollHeight สดจากตำแหน่งจริง ไม่ใช้ IntersectionObserver สังเกต element เพราะรูปที่ยังโหลดไม่เสร็จ
// ไม่มี width/height สำรองพื้นที่ไว้ ทำให้ layout ยังไม่นิ่งตอน element เพิ่งถูกแทรกเข้ามา
function checkLoadMoreOnScroll() {
  if (!tailNextUrl || isLoadingNextChapter) return;
  const body = el("#readerBody");
  const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
  if (remaining < 800) appendNextChapter(readerMangaId, tailNextUrl);
}

async function appendNextChapter(mangaId, chapterUrl) {
  if (!chapterUrl || loadedChapterUrls.has(chapterUrl)) return;
  isLoadingNextChapter = true;
  const body = el("#readerBody");

  const divider = document.createElement("div");
  divider.className = "chapter-divider";
  divider.textContent = "กำลังโหลดตอนถัดไป...";
  body.appendChild(divider);

  try {
    const res = await fetch(`/api/manga/${mangaId}/chapter?url=${encodeURIComponent(chapterUrl)}`);
    const data = await res.json();
    if (!res.ok || !data.images || data.images.length === 0) {
      divider.textContent = "โหลดตอนถัดไปไม่สำเร็จ";
      tailNextUrl = null;
      return;
    }

    const resolvedUrl = data.chapter_url || chapterUrl;
    const chapterText = data.chapter_text || findChapterText(chapterUrl) || "ตอนถัดไป";
    loadedChapterUrls.add(resolvedUrl);
    divider.textContent = `— ${chapterText} —`;

    appendChapterImages(data.images);
    loadedDividers.push({
      el: divider,
      meta: { url: resolvedUrl, text: chapterText, prevUrl: data.prev_url, nextUrl: data.next_url },
    });
    tailNextUrl = data.next_url || null;

    // เซิร์ฟเวอร์มาร์คตอนนี้ว่าอ่านแล้วตอน fetch ไปแล้ว รีเฟรชสถานะ NEW เงียบ ๆ ในพื้นหลัง
    loadManga();
  } catch (e) {
    divider.textContent = "เกิดข้อผิดพลาด: " + e;
    tailNextUrl = null;
  } finally {
    isLoadingNextChapter = false;
  }
  checkLoadMoreOnScroll(); // เช็คอีกทีหลังปลดล็อกแล้ว เผื่อตอนที่เพิ่งต่อมาก็สั้นอีก จะได้ไล่โหลดต่อเป็นทอด ๆ
}

// เช็คว่าตอนนี้เลื่อนผ่าน divider ตัวไหนมาแล้ว (ไล่หาตัวสุดท้ายที่ขอบบนเลยเส้น threshold ขึ้นไป)
// อัปเดตหัวข้อ/ปุ่มตอนก่อนหน้า-ถัดไปให้ตรงกับตอนที่กำลังอ่านอยู่จริง ไม่ใช้ IntersectionObserver
// เพราะมันยิง callback ทันทีตอน observe() ถ้า element ที่สังเกตอยู่ในโซนอยู่แล้ว (เช่นตอนสั้นมาก)
function updateActiveChapterFromScroll() {
  const body = el("#readerBody");
  if (body.scrollTop < 60 || loadedDividers.length === 0) {
    if (activeChapterMeta.url !== initialChapterMeta.url) updateChapterMeta(initialChapterMeta);
    return;
  }

  const topbar = el("#readerTopbar");
  const threshold = topbar.offsetHeight + 20;
  let active = null;
  for (const d of loadedDividers) {
    if (d.el.getBoundingClientRect().top <= threshold) {
      active = d.meta;
    } else {
      break; // เรียงตามลำดับอยู่แล้ว ถ้าตัวนี้ยังไม่ผ่าน ตัวถัดไปก็ยังไม่ผ่านแน่นอน
    }
  }

  const target = active || initialChapterMeta;
  if (target.url !== activeChapterMeta.url) updateChapterMeta(target);
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
      updateActiveChapterFromScroll();
      checkLoadMoreOnScroll();
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
  initChapterSearch();
  el("#refreshAllBtn").addEventListener("click", refreshAll);
  el("#readerClose").addEventListener("click", closeReader);
  el("#chapterListClose").addEventListener("click", closeChapterList);
  el("#readerPrev").addEventListener("click", goPrevChapter);
  el("#readerNext").addEventListener("click", goNextChapter);
  loadManga();
}

document.addEventListener("DOMContentLoaded", init);
