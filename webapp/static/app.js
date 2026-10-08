// ข้อมูลชุดแรก (ผู้ใช้ปัจจุบัน + เรื่องที่ติดตาม + ค่าตั้งค่า) ฝังมากับหน้า HTML แล้ว (ดู index())
// หน้าแรกจึงขึ้นได้ทันทีโดยไม่ต้องรอยิง API ต่อกันหลายรอบก่อนจะวาดอะไรได้
const BOOT = window.__BOOT__ || {};

const state = {
  manga: BOOT.manga || [],
  catalog: [],
  prefs: BOOT.prefs || {},
  currentUser: BOOT.me || { username: null, is_admin: false },
  videos: [],
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

// justNow: ข้อความตอนไม่ถึงนาที — ค่าเริ่มต้นสำหรับเวลาเช็คตอนใหม่, คอมเมนต์/แจ้งเตือน/คลิปใช้ "เมื่อสักครู่"
function timeAgo(iso, justNow = "เพิ่งตรวจสอบ") {
  if (!iso) return "ยังไม่เคยตรวจสอบ";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return justNow;
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
  el("#accountName").textContent = state.currentUser.username || "ผู้ใช้";
  el("#accountRole").textContent = state.currentUser.is_admin ? "ผู้ดูแลระบบ" : "สมาชิก";
}

// ---------- Tabs (เมนูล่าง) ----------
// วาดจากข้อมูลที่มีอยู่ทันที แล้วค่อยดึงของใหม่มาอัปเดตทีหลัง (ไม่ปล่อยจอว่างรอเน็ต)
const tabHistory = []; // แท็บที่เคยอยู่ก่อนหน้า — ปัดขอบซ้ายย้อนกลับไปทีละแท็บ

function showTab(tab, fromBack = false) {
  if (!fromBack && state.tab && state.tab !== tab) tabHistory.push(state.tab);
  if (tabHistory.length > 20) tabHistory.shift();
  state.tab = tab;
  document.body.dataset.tab = tab;
  els(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  els(".view").forEach((v) => v.classList.toggle("active", v.id === `${tab}View`));
  els(".topbar-title").forEach((t) => { t.hidden = t.dataset.for !== tab; });
  updateCategoryBar();
  window.scrollTo(0, 0);

  if (tab === "list") {
    loadHistory();
    loadVideos();
  }
  if (tab === "catalog") {
    renderCatalog(filterCatalog());
    loadCatalog().then(() => renderCatalog(filterCatalog()));
  }
  if (tab === "search") {
    renderSearch();
    loadCatalog().then(renderSearch);
    loadVideos(); // ให้ค้นคลิปได้ด้วย (renderVideos อัปเดตผลค้นหาเอง)
  }
  if (tab === "videos") loadVideos();
  if (tab === "settings" && state.currentUser.is_admin) {
    renderSettings();
    renderCategoryAdmin();
    loadCatalog().then(() => { renderSettings(); renderCategoryAdmin(); });
    renderUserList();
    loadSiteSettings();
  }
}

// ---------- MeeMovie (คลิป Facebook) ----------
// แยก state ออกจาก reader มังงะโดยสิ้นเชิง: วิดีโอจำเวลาเป็นวินาที ไม่แตะ chapter/read_state เดิม
let videoLoading = false;
let activeVideo = null;
let activeFbPlayer = null;
let videoSaveTimer = null;
let lastSavedVideoPosition = null;
let activeVideoFinished = false;
// iPhone (โดยเฉพาะเปิดจากไอคอนหน้าจอโฮม) เล่นคลิปแบบเต็มจอของระบบ แล้ว getCurrentPosition() ของ Facebook
// ตอบ 0 ตลอด → เดิมบันทึกได้แต่ 0.0 จึงนับเวลาเล่นเองเป็นตัวสำรอง ใช้เมื่อ API ไม่เคยตอบเลขเกิน 0
let videoApiWorks = false;
let videoClockBase = 0;
let videoClockStartedAt = null;
let facebookSdkPromise = null;
let videoSubmitting = false;
const VIDEO_PAGE_SIZE = 15;
let videoTab = "home"; // home = ทั้งหมด, saved = คลังวิดีโอ (กดบันทึก), history = ประวัติการดู
let videoShown = VIDEO_PAGE_SIZE;

function videoCardHtml(video) {
  const image = video.thumbnail_url
    ? `<img class="video-thumb" src="${escapeHtml(video.thumbnail_url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'video-placeholder',textContent:'▶'}))" />`
    : '<span class="video-placeholder" aria-hidden="true">▶</span>';
  // ดูค้างไว้: แถบหลอดใต้ภาพ + ป้าย "ดูต่อ" (ไม่รู้ความยาวคลิปก็ยังขึ้นป้าย แต่ไม่มีหลอด)
  const pos = Number(video.position_seconds) || 0;
  const dur = Number(video.duration_seconds) || 0;
  const pct = pos > 0 && dur > 0 ? Math.min(100, Math.max(3, (pos / dur) * 100)) : 0;
  const resume = pos > 0
    ? `<span class="video-resume-badge">ดูต่อ</span>${pct ? `<span class="video-progress"><span style="width:${pct.toFixed(1)}%"></span></span>` : ""}`
    : "";
  // มุมขวาล่างเหนือหลอด: ยังไม่เคยดู "111 นาที" / ดูค้าง "12.23/111 นาที" (นาที.วินาที ที่ดูถึง / ความยาวเป็นนาที)
  const at = pos > 0 ? `${Math.floor(pos / 60)}.${String(Math.floor(pos % 60)).padStart(2, "0")}` : "";
  const total = dur > 0 ? `${Math.max(1, Math.round(dur / 60))} นาที` : "";
  const timeLabel = at || total ? `<span class="video-time">${at && total ? `${at}/${total}` : at ? `${at} นาที` : total}</span>` : "";
  const info = `<span class="video-card-info"><span class="video-card-title">${escapeHtml(video.title)}</span><span class="video-card-meta">เพิ่มโดย ${escapeHtml(video.added_by)} · ${timeAgo(video.created_at, "เมื่อสักครู่")}</span></span>`;
  // คลิปที่ Facebook ไม่ให้เล่นแบบฝัง (ไม่สาธารณะ/ปิดการฝัง): เป็นลิงก์จริงให้ iPhone เปิดในแอป Facebook ที่ล็อกอินอยู่
  // (universal link ทำงานกับการแตะ <a> เท่านั้น window.open จาก JS จะไปเปิดในเบราว์เซอร์แทน) ไม่มีจำจุดดูค้าง
  if (video.external) {
    return videoItemHtml(video, `<a class="video-card" data-video-id="${escapeHtml(video.id)}" href="${escapeHtml(video.facebook_url)}" target="_blank" rel="noopener"><span class="video-media">${image}<span class="video-resume-badge video-external-badge">เปิดใน Facebook</span>${video.can_delete ? '<span class="video-card-delete" data-delete-video role="button">ลบ</span>' : ""}</span>${info}</a>`);
  }
  // คลิปเดี่ยวที่เพิ่มภายใน 3 วันและยังไม่ได้ดู (ตอนของ playlist ใช้ป้ายบนการ์ดเรื่องแทน)
  const fresh = !video.playlist_id && !video.watched_at && isRecent(video.created_at) ? '<span class="new-badge">NEW</span>' : "";
  return videoItemHtml(video, `<button class="video-card" data-video-id="${escapeHtml(video.id)}"><span class="video-media">${image}${fresh}${resume}${timeLabel}</span>${info}</button>`);
}

// ปุ่ม "บันทึก" แยกจากการ์ด (ปุ่มซ้อนใน <button>/<a> ของการ์ดไม่ได้)
function videoItemHtml(video, card) {
  const saved = !!video.saved_at;
  return `<div class="video-item" data-video-id="${escapeHtml(video.id)}">${card}<button class="btn video-save-btn${saved ? " saved" : ""}" data-save-video>${saved ? "✓ บันทึกแล้ว" : "บันทึก"}</button></div>`;
}

// ชิป "คลิปเดี่ยว" (ไม่ใช่หมวดจริง) — ดูเฉพาะคลิปที่ไม่อยู่ใน playlist
const CLIPS_FILTER = "__clips";

// ตารางคลิปด้านล่าง ใช้เฉพาะตอนเลือกชิปหมวด/คลิปเดี่ยว — หน้าหลัก "ทั้งหมด" และคลังของฉัน วาดแบบแถว/รายการเอง
function videosForTab() {
  if (videoTab !== "home" || !videoCategoryFilter) return [];
  if (videoCategoryFilter === CLIPS_FILTER) return state.videos.filter((v) => !v.playlist_id);
  return state.videos.filter((v) => !v.playlist_id && v.category_id === videoCategoryFilter);
}

// ตอนใน playlist ไม่มีหมวดของตัวเอง ใช้หมวดของ playlist
function videoCategoryOf(video) {
  if (!video.playlist_id) return video.category_id;
  return (state.videoPlaylists || []).find((p) => p.id === video.playlist_id)?.category_id || null;
}

function isLibraryTab() {
  return videoTab === "saved" || videoTab === "history";
}

function renderVideos() {
  const library = isLibraryTab();
  const rows = videoTab === "home" && !videoCategoryFilter;
  const list = videosForTab();
  el("#videoGrid").hidden = rows || library;
  el("#videoGrid").innerHTML = list.slice(0, videoShown).map(videoCardHtml).join("");
  el("#videoMoreBtn").hidden = list.length <= videoShown;
  el("#videoEmpty").textContent = "ยังไม่มีคลิปในหมวดนี้";
  el("#videoEmpty").hidden = rows || library || list.length > 0 || visiblePlaylists().length > 0;
  els(".video-tab").forEach((b) => b.classList.toggle("active", b.dataset.videoTab === (library ? "library" : "home")));
  els("#librarySeg [data-video-tab]").forEach((b) => b.classList.toggle("active", b.dataset.videoTab === videoTab));
  el("#librarySeg").hidden = !library;
  // ผลค้นหาในหน้าค้นหาใช้ข้อมูลคลิปชุดเดียวกัน — บันทึก/ลบ/ดูค้างแล้วต้องอัปเดตตามด้วย
  if (el("#searchInput").value.trim()) renderSearch();
  renderVideoCategoryChips();
  renderContinue();
  el("#videoToolbar").hidden = videoTab !== "home";
  el("#videoHome").hidden = !rows;
  if (rows) renderVideoHome();
  el("#libraryView").hidden = !library;
  if (library) renderLibrary();
  renderPlaylistRow();
  if (!el("#playlistView").hidden) renderPlaylistView();
  if (activeVideo && !el("#videoPlayer").hidden) renderPlayerEpisodes(activeVideo);
}

async function loadVideos() {
  if (videoLoading) return;
  videoLoading = true;
  try {
    // เซิร์ฟเวอร์ส่งทั้งคลัง หน้าเว็บแบ่งแสดงเอง
    const data = await getJSON("/api/videos");
    state.videos = data.items || [];
    state.videoCategories = data.categories || [];
    state.videoPlaylists = data.playlists || [];
    renderVideos();
  } catch (e) {
    el("#videoGrid").innerHTML = `<div class="reader-msg">${escapeHtml(e.body?.error || "โหลดคลิปไม่สำเร็จ")}</div>`;
  } finally {
    videoLoading = false;
  }
}

// ---------- ป้าย NEW (คลิป/เรื่องใหม่, ตอนใหม่ของ playlist) ----------
// ใหม่ = เพิ่มภายใน 3 วัน และคนนี้ยังไม่ได้ดู
const NEW_DAYS = 3;
function isRecent(iso, days = NEW_DAYS) {
  return !!iso && Date.now() - new Date(iso).getTime() < days * 86400000;
}

// ตอนที่เพิ่มทีหลังเรื่อง (เกิน 10 นาทีจากตอนสร้างเรื่อง = ไม่ใช่ชุดแรก)
function isLaterEpisode(playlist, video) {
  return new Date(video.created_at).getTime() > new Date(playlist.created_at || 0).getTime() + 10 * 60000;
}

function newEpisodes(playlist, episodes = playlistEpisodes(playlist.id)) {
  return episodes.filter((v) => !v.watched_at && isRecent(v.created_at) && isLaterEpisode(playlist, v));
}

function isFreshPlaylist(p, episodes) {
  return p.is_fresh && isRecent(p.created_at) && !episodes.some((v) => v.watched_at);
}

function playlistBadge(p, episodes) {
  if (isFreshPlaylist(p, episodes)) return '<span class="new-badge">NEW</span>';
  return newEpisodes(p, episodes).length ? '<span class="new-badge">NEW EP</span>' : "";
}

function playlistById(id) {
  return (state.videoPlaylists || []).find((p) => p.id === id);
}

function shortEp(video) {
  return `ต.${Number(video.episode)}`;
}

function thumbHtml(url) {
  return url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" />` : '<span class="video-placeholder" aria-hidden="true">▶</span>';
}

function progressBarHtml(pos, dur) {
  return pos > 0 && dur > 0 ? `<span class="video-progress"><span style="width:${Math.min(100, Math.max(3, (pos / dur) * 100)).toFixed(1)}%"></span></span>` : "";
}

// ---------- หน้าหลักแบบแถว: แบนเนอร์ + ดูต่อ / ตอนใหม่ล่าสุด / แต่ละหมวด / คลิปเดี่ยว ----------
const HOME_ROW_LIMIT = 10;

// แบนเนอร์: เรื่องที่มีของใหม่ก่อน (ลำดับจากเซิร์ฟเวอร์ = อัปเดตล่าสุดก่อน) → เรื่องที่ดูค้างล่าสุด → เรื่องอัปเดตล่าสุด
function pickHeroPlaylist() {
  const lists = state.videoPlaylists || [];
  const withNew = lists.find((p) => playlistBadge(p, playlistEpisodes(p.id)));
  if (withNew) return withNew;
  const last = state.videos.filter((v) => v.playlist_id && v.watched_at).sort((a, b) => b.watched_at.localeCompare(a.watched_at))[0];
  return (last && playlistById(last.playlist_id)) || lists[0] || null;
}

function heroHtml(p) {
  const eps = playlistEpisodes(p.id);
  const resume = playlistResume(eps);
  const started = eps.some((v) => v.watched_at);
  const fresh = newEpisodes(p, eps);
  const meta = fresh.length ? `${episodeLabel(fresh[fresh.length - 1])} มาแล้ว · ${p.count} ตอน` : `${p.count} ตอน`;
  const cover = (fresh.length ? fresh[fresh.length - 1] : resume).thumbnail_url || p.thumbnail_url;
  return `<div class="mm-hero" data-playlist-id="${escapeHtml(p.id)}">${thumbHtml(cover)}
    <div class="mm-hero-info">${playlistBadge(p, eps).replace("new-badge", "new-badge mm-hero-badge")}
      <div class="mm-hero-name">${escapeHtml(p.name)}</div><div class="mm-hero-meta">${meta}</div>
      <button class="btn primary" data-hero-play="${escapeHtml(resume.id)}">▶ ${started ? "ดูต่อ" : "เริ่มดู"} ${episodeLabel(resume)}</button>
    </div></div>`;
}

function homeRowHtml(title, tiles, more = "") {
  return `<section class="mm-section"><div class="mm-row-head"><h2 class="section-title">${title}</h2>${more}</div><div class="mm-row">${tiles}</div></section>`;
}

// การ์ดเล็กของคลิป/ตอน ในแถวหน้าหลัก
function videoTileHtml(v, { name, meta, badge = "" }) {
  const pos = Number(v.position_seconds) || 0;
  const dur = Number(v.duration_seconds) || 0;
  return `<button class="mm-tile" data-video-id="${escapeHtml(v.id)}"><span class="mm-thumb">${thumbHtml(v.thumbnail_url)}${badge}${progressBarHtml(pos, dur)}</span><span class="mm-name">${escapeHtml(name)}</span><span class="mm-meta">${escapeHtml(meta)}</span></button>`;
}

function videoNameAndEp(v) {
  const p = v.playlist_id && playlistById(v.playlist_id);
  return p ? { name: p.name, ep: episodeLabel(v) } : { name: v.title, ep: "" };
}

function renderVideoHome() {
  const playlists = state.videoPlaylists || [];
  const parts = [];
  const hero = pickHeroPlaylist();
  if (hero) parts.push(heroHtml(hero));
  const cont = state.videos.filter((v) => !v.external && Number(v.position_seconds) > 0)
    .sort((a, b) => String(b.watched_at || "").localeCompare(String(a.watched_at || ""))).slice(0, 12);
  if (cont.length) {
    parts.push(homeRowHtml("ดูต่อ", cont.map((v) => {
      const { name, ep } = videoNameAndEp(v);
      return videoTileHtml(v, { name, meta: `${ep ? `${ep} · ` : ""}ค้าง ${formatVideoTime(Number(v.position_seconds))}` });
    }).join("")));
  }
  // ตอนที่เพิ่มทีหลังเรื่อง ภายใน 14 วัน ล่าสุดก่อน
  const latest = state.videos.filter((v) => {
    const p = v.playlist_id && playlistById(v.playlist_id);
    return p && isRecent(v.created_at, 14) && isLaterEpisode(p, v);
  }).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 15);
  if (latest.length) {
    parts.push(homeRowHtml("ตอนใหม่ล่าสุด", latest.map((v) => {
      const fresh = !v.watched_at && isRecent(v.created_at);
      return videoTileHtml(v, { name: playlistById(v.playlist_id).name, meta: `${episodeLabel(v)} · ${timeAgo(v.created_at, "เมื่อสักครู่")}`, badge: fresh ? '<span class="new-badge">NEW</span>' : "" });
    }).join("")));
  }
  for (const cat of state.videoCategories || []) {
    const inCat = playlists.filter((p) => p.category_id === cat.id);
    if (!inCat.length) continue;
    const more = `<button class="link-btn mm-more" data-row-filter="${escapeHtml(cat.id)}">ทั้งหมด ${inCat.length} ›</button>`;
    parts.push(homeRowHtml(escapeHtml(cat.name), inCat.slice(0, HOME_ROW_LIMIT).map(playlistCardHtml).join(""), more));
  }
  const loose = playlists.filter((p) => !p.category_id);
  if (loose.length) parts.push(homeRowHtml("เรื่องยาวอื่น ๆ", loose.map(playlistCardHtml).join("")));
  const clips = state.videos.filter((v) => !v.playlist_id);
  if (clips.length) {
    const more = `<button class="link-btn mm-more" data-row-filter="${CLIPS_FILTER}">ทั้งหมด ${clips.length} ›</button>`;
    parts.push(homeRowHtml("คลิปเดี่ยว", clips.slice(0, HOME_ROW_LIMIT).map((v) => {
      const dur = Number(v.duration_seconds) || 0;
      const fresh = !v.watched_at && isRecent(v.created_at) ? '<span class="new-badge">NEW</span>' : "";
      return videoTileHtml(v, { name: v.title, meta: dur ? `${Math.max(1, Math.round(dur / 60))} นาที` : timeAgo(v.created_at, "เมื่อสักครู่"), badge: fresh });
    }).join(""), more));
  }
  el("#videoHome").innerHTML = parts.join("") || '<div class="empty-state">ยังไม่มีคลิปในคลัง</div>';
}

// ---------- คลังของฉัน: บันทึกไว้ / ประวัติการดู ----------
let lastLibraryTab = "saved";
let libraryEditing = false;
const librarySelected = new Set(); // "p:<playlist id>" / "v:<video id>"

function renderLibrary() {
  const saved = videoTab === "saved";
  el("#historySearch").hidden = saved;
  el("#libraryEditBtn").hidden = !saved;
  el("#libraryEditBtn").textContent = libraryEditing ? "เสร็จ" : "แก้ไข";
  el("#libraryBody").innerHTML = saved ? savedLibraryHtml() : historyHtml();
}

function libraryCheck(key) {
  return libraryEditing ? `<span class="lib-check${librarySelected.has(key) ? " on" : ""}" aria-hidden="true">✓</span>` : "";
}

function savedLibraryHtml() {
  const clipsOnly = videoCategoryFilter === CLIPS_FILTER;
  const lists = clipsOnly ? [] : (state.videoPlaylists || []).filter((p) => p.saved_at && (!videoCategoryFilter || p.category_id === videoCategoryFilter))
    .map((p) => ({ p, eps: playlistEpisodes(p.id) }))
    .map((x) => ({ ...x, hasNew: !!playlistBadge(x.p, x.eps) }))
    .sort((a, b) => (b.hasNew - a.hasNew) || b.p.saved_at.localeCompare(a.p.saved_at));
  const clips = state.videos.filter((v) => v.saved_at && (clipsOnly ? !v.playlist_id : !videoCategoryFilter || videoCategoryOf(v) === videoCategoryFilter))
    .sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  if (!lists.length && !clips.length) return '<div class="empty-state">ยังไม่มีอะไรในคลัง — กด "บันทึก" ใต้การ์ดเรื่องหรือคลิป</div>';
  const cards = lists.map(({ p, eps }) => {
    const watched = eps.filter((v) => v.watched_at && !(Number(v.position_seconds) > 0)).length;
    const started = eps.some((v) => v.watched_at);
    const resume = playlistResume(eps);
    const key = `p:${p.id}`;
    return `<button class="lib-card${librarySelected.has(key) ? " selected" : ""}" data-lib-key="${key}"><span class="mm-thumb">${thumbHtml(p.thumbnail_url)}${playlistBadge(p, eps)}${libraryCheck(key)}</span>
      <span class="mm-name">${escapeHtml(p.name)}</span><span class="lib-bar"><span style="width:${((watched / Math.max(1, eps.length)) * 100).toFixed(1)}%"></span></span>
      <span class="mm-meta">${started ? `${shortEp(resume)}/${eps.length}` : "ยังไม่เริ่ม"}</span></button>`;
  }).join("");
  const rows = clips.map((v) => {
    const pos = Number(v.position_seconds) || 0;
    const dur = Number(v.duration_seconds) || 0;
    const { name, ep } = videoNameAndEp(v);
    const meta = pos > 0 ? `ดูไป ${Math.floor(pos / 60)}${dur ? `/${Math.max(1, Math.round(dur / 60))}` : ""} นาที` : v.watched_at ? "ดูจบแล้ว" : `ยังไม่ดู${dur ? ` · ${Math.max(1, Math.round(dur / 60))} นาที` : ""}`;
    const key = `v:${v.id}`;
    return `<button class="lib-row${librarySelected.has(key) ? " selected" : ""}" data-lib-key="${key}"><span class="lib-thumb">${thumbHtml(v.thumbnail_url)}${libraryCheck(key)}</span>
      <span class="lib-info"><span class="mm-name">${escapeHtml(ep ? `${name} · ${ep}` : name)}</span>${pos > 0 && dur > 0 ? `<span class="lib-bar"><span style="width:${Math.min(100, (pos / dur) * 100).toFixed(1)}%"></span></span>` : ""}<span class="mm-meta">${meta}</span></span>
      ${libraryEditing ? "" : '<span class="lib-play" aria-hidden="true">▶</span>'}</button>`;
  }).join("");
  const remove = libraryEditing ? `<button class="btn danger lib-remove" data-lib-remove${librarySelected.size ? "" : " disabled"}>เอาออกจากคลัง (${librarySelected.size})</button>` : "";
  return `${lists.length ? `<h2 class="section-title">เรื่องที่บันทึก · ${lists.length}</h2><div class="lib-grid">${cards}</div>` : ""}
    ${clips.length ? `<h2 class="section-title">คลิปที่บันทึก · ${clips.length}</h2><div class="lib-list">${rows}</div>` : ""}${remove}`;
}

function historyDayLabel(iso) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(iso))) / 86400000);
  if (diff <= 0) return "วันนี้";
  if (diff === 1) return "เมื่อวาน";
  if (diff < 7) return "สัปดาห์นี้";
  return "เก่ากว่านั้น";
}

function historyGroups() {
  const groups = new Map();
  for (const v of state.videos) {
    if (!v.watched_at) continue;
    if (v.playlist_id) {
      const p = playlistById(v.playlist_id);
      if (!p) continue;
      const g = groups.get(p.id) || { kind: "pl", p, eps: [], at: "" };
      g.eps.push(v);
      if (v.watched_at > g.at || (v.watched_at === g.at && (v.episode || 0) > (g.last.episode || 0))) { g.at = v.watched_at; g.last = v; }
      groups.set(p.id, g);
    } else {
      groups.set(v.id, { kind: "clip", v, at: v.watched_at });
    }
  }
  const q = el("#historySearch").value.trim().toLowerCase();
  return [...groups.values()]
    .filter((g) => !q || (g.kind === "pl" ? [g.p.name, ...g.eps.map((v) => v.title)] : [g.v.title]).some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// แถวประวัติ: ปุ่มขวาเปลี่ยนตามสถานะ — ค้างกลางตอน "ดูต่อ" / จบตอน "ต.ถัดไป ›" / ครบทั้งเรื่อง ✓
function historyRowHtml(g) {
  if (g.kind === "clip") {
    const v = g.v;
    const pos = Number(v.position_seconds) || 0;
    const dur = Number(v.duration_seconds) || 0;
    const meta = pos > 0 ? `คลิปเดี่ยว · ${Math.floor(pos / 60)}${dur ? `/${Math.max(1, Math.round(dur / 60))}` : ""} นาที` : "คลิปเดี่ยว · ดูจบแล้ว";
    return `<div class="hist-row" data-history-video="${escapeHtml(v.id)}"><span class="lib-thumb">${thumbHtml(v.thumbnail_url)}${progressBarHtml(pos, dur)}</span>
      <span class="lib-info"><span class="mm-name">${escapeHtml(v.title)}</span><span class="mm-meta">${meta}</span></span>
      <button class="btn hist-action" data-history-play="${escapeHtml(v.id)}">${pos > 0 ? "ดูต่อ" : "ดูอีกครั้ง"}</button></div>`;
  }
  const { p, eps, last } = g;
  const all = playlistEpisodes(p.id);
  const pos = Number(last.position_seconds) || 0;
  const dur = Number(last.duration_seconds) || 0;
  const next = all[all.indexOf(last) + 1];
  const allDone = all.every((v) => v.watched_at && !(Number(v.position_seconds) > 0));
  let meta;
  let action;
  if (pos > 0) {
    meta = `ดู ${eps.length} ตอน · ล่าสุด ${shortEp(last)} ค้าง ${formatVideoTime(pos)}`;
    action = `<button class="btn hist-action" data-history-play="${escapeHtml(last.id)}">ดูต่อ</button>`;
  } else if (allDone) {
    meta = `ดูครบ ${all.length} ตอน`;
    action = '<span class="hist-done" aria-label="ดูครบแล้ว">✓</span>';
  } else if (next) {
    meta = `ดู ${eps.length} ตอน · จบ ${shortEp(last)}`;
    action = `<button class="btn hist-action" data-history-play="${escapeHtml(next.id)}">${shortEp(next)} ›</button>`;
  } else {
    meta = `ดู ${eps.length} ตอน · จบ ${shortEp(last)}`;
    action = `<button class="btn hist-action" data-history-open="${escapeHtml(p.id)}">เปิด</button>`;
  }
  return `<div class="hist-row" data-history-playlist="${escapeHtml(p.id)}"><span class="lib-thumb">${thumbHtml(last.thumbnail_url || p.thumbnail_url)}${progressBarHtml(pos, dur)}</span>
    <span class="lib-info"><span class="mm-name">${escapeHtml(p.name)}</span><span class="mm-meta">${meta}</span></span>${action}</div>`;
}

function historyHtml() {
  const groups = historyGroups();
  if (!groups.length) return `<div class="empty-state">${el("#historySearch").value.trim() ? "ไม่พบในประวัติ" : "ยังไม่มีประวัติการดู"}</div>`;
  let html = "";
  let label = "";
  for (const g of groups) {
    const day = historyDayLabel(g.at);
    if (day !== label) { html += `<div class="hist-day">${day}</div>`; label = day; }
    html += historyRowHtml(g);
  }
  return html;
}

async function removeLibrarySelection() {
  const keys = [...librarySelected];
  if (!keys.length) return;
  await Promise.all(keys.map(async (key) => {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    try {
      if (kind === "p") {
        await sendJSON("POST", `/api/video-playlists/${encodeURIComponent(id)}/save`, { saved: false });
        const p = playlistById(id);
        if (p) p.saved_at = null;
      } else {
        await sendJSON("POST", `/api/videos/${encodeURIComponent(id)}/save`, { saved: false });
        const v = state.videos.find((x) => x.id === id);
        if (v) v.saved_at = null;
      }
    } catch (e) { /* ตัวที่ไม่สำเร็จยังอยู่ในคลัง */ }
  }));
  librarySelected.clear();
  libraryEditing = false;
  renderVideos();
}

function initLibrary() {
  el("#libraryEditBtn").addEventListener("click", () => {
    libraryEditing = !libraryEditing;
    librarySelected.clear();
    renderLibrary();
  });
  el("#historySearch").addEventListener("input", debounce(() => { if (videoTab === "history") renderLibrary(); }, 150));
  el("#libraryBody").addEventListener("click", (event) => {
    if (event.target.closest("[data-lib-remove]")) return removeLibrarySelection();
    const keyEl = event.target.closest("[data-lib-key]");
    if (keyEl) {
      const key = keyEl.dataset.libKey;
      if (libraryEditing) {
        if (librarySelected.has(key)) librarySelected.delete(key); else librarySelected.add(key);
        return renderLibrary();
      }
      const id = key.slice(2);
      if (key.startsWith("p:")) return openPlaylist(id);
      const v = state.videos.find((x) => x.id === id);
      if (v) openVideo(v);
      return;
    }
    const play = event.target.closest("[data-history-play]")?.dataset.historyPlay;
    if (play) {
      const v = state.videos.find((x) => x.id === play);
      if (v) openVideo(v);
      return;
    }
    const open = event.target.closest("[data-history-open], [data-history-playlist]");
    if (open) return openPlaylist(open.dataset.historyOpen || open.dataset.historyPlaylist);
    const clip = event.target.closest("[data-history-video]")?.dataset.historyVideo;
    const v = clip && state.videos.find((x) => x.id === clip);
    if (v) openVideo(v);
  });
}

// ---------- Playlist (เรื่องยาวหลายตอน) ----------
let openPlaylistId = null;
const PLAYLIST_PAGE = 12;
let playlistShown = PLAYLIST_PAGE;

// ตารางการ์ดเรื่อง: เฉพาะตอนเลือกชิปหมวด (หน้าหลัก "ทั้งหมด" ใช้แถวแทน)
function visiblePlaylists() {
  if (videoTab !== "home" || !videoCategoryFilter || videoCategoryFilter === CLIPS_FILTER) return [];
  return (state.videoPlaylists || []).filter((p) => p.category_id === videoCategoryFilter);
}

function playlistSaveButton(p) {
  return `<button class="btn video-save-btn${p.saved_at ? " saved" : ""}" data-save-playlist="${escapeHtml(p.id)}">${p.saved_at ? "✓ บันทึกแล้ว" : "บันทึก"}</button>`;
}

async function togglePlaylistSave(id, btn) {
  const p = playlistById(id);
  if (!p) return;
  btn.disabled = true;
  try {
    const data = await sendJSON("POST", `/api/video-playlists/${encodeURIComponent(id)}/save`, { saved: !p.saved_at });
    p.saved_at = data.saved_at || null;
    renderVideos();
  } catch (e) { alert(e.message || "บันทึกไม่สำเร็จ"); btn.disabled = false; }
}

// เลื่อนใกล้ท้ายหน้า: เติมการ์ดเรื่องก่อนจนครบ แล้วค่อยเติมคลิป
function loadMoreVideoCards() {
  if (state.tab !== "videos") return false;
  const lists = visiblePlaylists();
  if (playlistShown < lists.length) {
    playlistShown += PLAYLIST_PAGE;
    renderPlaylistRow();
    return true;
  }
  if (videoShown < videosForTab().length) {
    videoShown += VIDEO_PAGE_SIZE;
    renderVideos();
    return true;
  }
  return false;
}

function resetVideoPaging() {
  videoShown = VIDEO_PAGE_SIZE;
  playlistShown = PLAYLIST_PAGE;
}

function initVideoInfiniteScroll() {
  const sentinel = el("#videoSentinel");
  const near = () => {
    const rect = sentinel.getBoundingClientRect();
    return rect.height >= 0 && rect.top < window.innerHeight + 800 && sentinel.offsetParent;
  };
  // เติมแล้วท้ายหน้ายังอยู่ในจอ (จอสูง/การ์ดน้อย) เติมต่อจนล้นจอ
  const fill = () => { for (let i = 0; i < 20 && near() && loadMoreVideoCards(); i++); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) fill(); }, { rootMargin: "0px 0px 800px 0px" }).observe(sentinel);
  }
  window.addEventListener("scroll", () => { if (near()) fill(); }, { passive: true });
}

function playlistEpisodes(playlistId) {
  return state.videos.filter((v) => v.playlist_id === playlistId).sort((a, b) => (a.episode || 0) - (b.episode || 0));
}

function episodeLabel(video) {
  return `ตอนที่ ${Number(video.episode)}`;
}

// ชื่อตอน (ถ้ามี) = ชื่อคลิปที่ตัดชื่อเรื่อง/เลขตอนออก เช่น "THE4 โดนซองขาว" → "โดนซองขาว"
function episodeSubtitle(video, playlistName) {
  let rest = video.title.startsWith(playlistName) ? video.title.slice(playlistName.length) : video.title;
  rest = rest.replace(/^[\s,.:|-]*(ep\.?|ตอนที่|ตอน|part)?\s*\d+(\.\d+)?\.?\s*(จบ)?/i, "").trim();
  return rest && rest !== video.title ? rest : "";
}

// ตอนที่ควรเล่นเมื่อกด "ดูต่อ": ตอนล่าสุดที่เปิด — ดูค้างอยู่ = ตอนนั้น, ดูจบแล้ว = ตอนถัดไป, ยังไม่เคยดู = ตอนแรก
function playlistResume(episodes) {
  const last = episodes.reduce((best, v) => (v.watched_at && (!best || v.watched_at > best.watched_at) ? v : best), null);
  if (!last) return episodes[0];
  if (Number(last.position_seconds) > 0) return last;
  return episodes[episodes.indexOf(last) + 1] || last;
}

function renderPlaylistRow() {
  const lists = visiblePlaylists();
  el("#playlistSection").hidden = !lists.length;
  el("#playlistRow").innerHTML = lists.slice(0, playlistShown).map(playlistCardHtml).join("");
}

function playlistCardHtml(p) {
  const eps = playlistEpisodes(p.id);
  const resume = eps.some((v) => v.watched_at) ? playlistResume(eps) : null;
  return `<div class="video-item playlist-item"><button class="video-card playlist-card" data-playlist-id="${escapeHtml(p.id)}"><span class="video-media">${thumbHtml(p.thumbnail_url).replace("<img ", '<img class="video-thumb" ')}${playlistBadge(p, eps)}<span class="video-time">${p.count} ตอน</span></span><span class="video-card-info"><span class="video-card-title">${escapeHtml(p.name)}</span><span class="video-card-meta">${resume ? `ดูต่อ ${episodeLabel(resume)}` : "ยังไม่เคยดู"}</span></span></button>${playlistSaveButton(p)}</div>`;
}

// ---------- หน้าเรื่อง: หัวเรื่อง + ปุ่มดูต่อ + ตารางเลขตอน ----------
const EP_RANGE = 20;
let playlistRange = 0;
let playlistDesc = false;

function openPlaylist(playlistId) {
  openPlaylistId = playlistId;
  playlistDesc = false;
  // เปิดมาที่ช่วงตอนที่จะดูต่อ
  const eps = playlistEpisodes(playlistId);
  playlistRange = eps.length ? Math.floor(eps.indexOf(playlistResume(eps)) / EP_RANGE) : 0;
  el("#playlistView").hidden = false;
  document.body.style.overflow = "hidden";
  renderPlaylistView();
  el("#playlistBody").scrollTop = 0;
}

function closePlaylist() {
  openPlaylistId = null;
  el("#playlistView").hidden = true;
  if (el("#videoPlayer").hidden || el("#videoPlayer").classList.contains("mini")) document.body.style.overflow = "";
}

// ช่องเลขตอน: ดูจบ = เลขจาง + ✓ มุม, ดูค้าง = กรอบสี + หลอด, ตอนใหม่ = ป้าย NEW มุม
function episodeTileHtml(v, playlist, { fresh = false, playing = false } = {}) {
  const pos = Number(v.position_seconds) || 0;
  const dur = Number(v.duration_seconds) || 0;
  const done = v.watched_at && !pos;
  const sub = episodeSubtitle(v, playlist.name);
  const cls = ["ep-tile", done ? "done" : "", pos > 0 ? "cur" : "", playing ? "playing" : "", sub ? "has-sub" : ""].filter(Boolean).join(" ");
  return `<button class="${cls}" data-episode-id="${escapeHtml(v.id)}" title="${escapeHtml(sub || episodeLabel(v))}"><span class="ep-num">${Number(v.episode)}</span>${sub ? `<span class="ep-sub">${escapeHtml(sub)}</span>` : ""}${done ? '<span class="ep-check" aria-label="ดูแล้ว">✓</span>' : ""}${fresh ? '<span class="ep-new">NEW</span>' : ""}${pos > 0 && dur > 0 ? `<span class="ep-pg" style="width:${Math.min(100, (pos / dur) * 100).toFixed(1)}%"></span>` : ""}</button>`;
}

function renderPlaylistView() {
  const playlist = playlistById(openPlaylistId);
  const episodes = playlistEpisodes(openPlaylistId);
  if (!playlist || !episodes.length) return closePlaylist();
  el("#playlistTitle").textContent = playlist.name;
  const resume = playlistResume(episodes);
  const started = episodes.some((v) => v.watched_at);
  const watched = episodes.filter((v) => v.watched_at && !(Number(v.position_seconds) > 0)).length;
  const fresh = new Set(newEpisodes(playlist, episodes).map((v) => v.id));
  const ordered = playlistDesc ? [...episodes].reverse() : episodes;
  const ranges = Math.ceil(ordered.length / EP_RANGE);
  playlistRange = Math.min(playlistRange, ranges - 1);
  const chips = ranges > 1 ? Array.from({ length: ranges }, (_, i) => {
    const part = ordered.slice(i * EP_RANGE, (i + 1) * EP_RANGE);
    return `<button class="video-chip${i === playlistRange ? " active" : ""}" data-ep-range="${i}">${Number(part[0].episode)}${part.length > 1 ? `–${Number(part[part.length - 1].episode)}` : ""}</button>`;
  }).join("") : "";
  const tiles = ordered.slice(playlistRange * EP_RANGE, (playlistRange + 1) * EP_RANGE)
    .map((v) => episodeTileHtml(v, playlist, { fresh: fresh.has(v.id) })).join("");
  el("#playlistBody").innerHTML = `<div class="pl-cover">${thumbHtml(resume.thumbnail_url || playlist.thumbnail_url)}${playlistBadge(playlist, episodes)}</div>
    <h2 class="pl-name">${escapeHtml(playlist.name)}</h2>
    <div class="pl-meta">${episodes.length} ตอน · อัปเดต ${timeAgo(playlist.updated_at, "เมื่อสักครู่")} · ดูไป ${watched}/${episodes.length}</div>
    <div class="lib-bar pl-bar"><span style="width:${((watched / episodes.length) * 100).toFixed(1)}%"></span></div>
    <div class="pl-actions"><button class="btn primary" data-episode-id="${escapeHtml(resume.id)}">▶ ${started ? "ดูต่อ" : "เริ่มดู"} ${episodeLabel(resume)}</button>${playlistSaveButton(playlist)}</div>
    <div class="pl-controls">${chips}<button class="video-chip" data-ep-sort>${playlistDesc ? "ล่าสุดก่อน" : "ตอนแรกก่อน"} ⇅</button></div>
    <div class="ep-grid">${tiles}</div>`;
}

function neighborEpisode(video, step) {
  if (!video?.playlist_id) return null;
  const episodes = playlistEpisodes(video.playlist_id);
  return episodes[episodes.findIndex((v) => v.id === video.id) + step] || null;
}

function renderEpisodeNav(video) {
  const nav = el("#episodeNav");
  nav.hidden = !video.playlist_id;
  renderPlayerEpisodes(video);
  if (nav.hidden) return;
  const episodes = playlistEpisodes(video.playlist_id);
  el("#episodeLabel").textContent = `${episodeLabel(video)} / ${episodes.length}`;
  renderAutoNext();
  el("#episodePrev").disabled = !neighborEpisode(video, -1);
  el("#episodeNext").disabled = !neighborEpisode(video, 1);
}

// แถบเลขตอนใต้คลิป — กดสลับตอนได้โดยไม่ต้องปิดตัวเล่น
function renderPlayerEpisodes(video) {
  const box = el("#playerEpisodes");
  const playlist = video.playlist_id && playlistById(video.playlist_id);
  box.hidden = !playlist;
  if (!playlist) return;
  const episodes = playlistEpisodes(playlist.id);
  const fresh = new Set(newEpisodes(playlist, episodes).map((v) => v.id));
  const scroll = box.scrollLeft;
  box.innerHTML = episodes.map((v) => episodeTileHtml(v, playlist, { fresh: fresh.has(v.id), playing: v.id === video.id })).join("");
  const playing = box.querySelector(".playing");
  if (box.dataset.for === video.id) box.scrollLeft = scroll;
  else if (playing) box.scrollLeft = playing.offsetLeft - box.clientWidth / 2 + playing.offsetWidth / 2;
  box.dataset.for = video.id;
}

// เปลี่ยนตอนโดยไม่ปิดหน้าตัวเล่น — ใช้ <video> ตัวเดิม iPhone จึงยอมเล่นต่ออัตโนมัติ (ตัวใหม่ต้องแตะเล่นเอง)
function playEpisode(video) {
  if (!video) return;
  cancelNextCountdown();
  closeComments();
  stopVideoClock();
  saveActiveVideoProgress(true);
  clearInterval(videoSaveTimer);
  videoSaveTimer = null;
  if (nativeVideo) nativeVideo.pause();
  openVideo(video, { autoplay: true });
}

// เล่นตอนถัดไปเองเมื่อจบตอน — เปิด/ปิดได้ จำต่อเครื่อง (ค่าเริ่มต้น: เปิด)
const AUTO_NEXT_KEY = "videoAutoNext";
function autoNextOn() {
  try { return localStorage.getItem(AUTO_NEXT_KEY) !== "off"; } catch (e) { return true; }
}

function renderAutoNext() {
  const on = autoNextOn();
  const btn = el("#autoNextBtn");
  btn.textContent = on ? "⏭ เล่นต่อ: เปิด" : "⏭ เล่นต่อ: ปิด";
  btn.title = "เล่นตอนถัดไปอัตโนมัติเมื่อจบตอน";
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
}

// จบตอน: นับถอยหลัง 5 วิ (ยกเลิก/เล่นเลยได้) แล้วเล่นตอนถัดไป
const NEXT_COUNTDOWN = 5;
let nextTimer = null;
function playNextEpisode() {
  if (!autoNextOn()) return;
  const next = neighborEpisode(activeVideo, 1);
  if (!next) return;
  let left = NEXT_COUNTDOWN;
  const tick = () => { el("#nextOverlayText").textContent = `ตอนถัดไป: ${episodeLabel(next)} · เริ่มใน ${left} วิ`; };
  cancelNextCountdown();
  el("#nextOverlay").hidden = false;
  el("#nextOverlay").dataset.next = next.id;
  tick();
  nextTimer = setInterval(() => {
    left -= 1;
    if (left > 0) return tick();
    cancelNextCountdown();
    playEpisode(next);
  }, 1000);
}

function cancelNextCountdown() {
  clearInterval(nextTimer);
  nextTimer = null;
  el("#nextOverlay").hidden = true;
}

// ---------- ย่อจอ: คลิปเล่นต่อเป็นแถบเล็กเหนือเมนูล่าง ระหว่างเลือกเรื่องอื่น ----------
function isVideoMini() {
  return el("#videoPlayer").classList.contains("mini");
}

function renderMiniPlay() {
  const paused = nativeVideo ? nativeVideo.paused : false;
  el("#miniPlay").textContent = paused ? "▶" : "⏸";
}

function setVideoMini(on) {
  el("#videoPlayer").classList.toggle("mini", on);
  el("#miniBar").hidden = !on;
  if (nativeVideo) nativeVideo.controls = !on;
  if (on) {
    cancelNextCountdown();
    el("#miniExpand").textContent = el("#videoPlayerTitle").textContent;
    renderMiniPlay();
  }
  document.body.style.overflow = on && el("#playlistView").hidden ? "" : "hidden";
}

function showVideoForm(show) {
  el("#videoFormModal").hidden = !show;
  if (show) el("#videoForm [name=facebook_url]").focus();
}

function videoFormMsg(message, isError = false) {
  const target = el("#videoFormMsg");
  target.textContent = message;
  target.classList.toggle("error", isError);
}

function loadFacebookSdk() {
  if (window.FB) return Promise.resolve(window.FB);
  if (facebookSdkPromise) return facebookSdkPromise;
  facebookSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.src = "https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v22.0";
    script.onload = () => window.FB ? resolve(window.FB) : reject(new Error("Facebook SDK ไม่พร้อมใช้งาน"));
    script.onerror = () => reject(new Error("โหลด Facebook SDK ไม่สำเร็จ"));
    document.head.appendChild(script);
  });
  return facebookSdkPromise;
}

async function mountFacebookVideo(video, position) {
  const body = el("#videoPlayerBody");
  body.innerHTML = '<div id="fb-root"></div><div id="facebookVideoMount" class="fb-video" data-href="" data-show-text="false" data-allowfullscreen="true" data-width="500"></div>';
  const mount = el("#facebookVideoMount");
  mount.dataset.href = video.facebook_url;
  // กว้างเต็มพื้นที่ที่มี (หัก padding ซ้าย-ขวา 16px) แต่ไม่เกิน 500px
  mount.dataset.width = Math.max(200, Math.min(500, Math.floor(body.clientWidth - 32)));
  const FB = await loadFacebookSdk();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (player) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (FB.Event?.unsubscribe) FB.Event.unsubscribe("xfbml.ready", onReady);
      resolve(player);
    };
    const onReady = (message) => {
      // หน้า player parse อยู่เพียง embed เดียว จึงจับ instance วิดีโอที่ SDK ส่งกลับมาได้โดยตรง
      if (message?.type === "video" && message.instance) finish(message.instance);
    };
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("Facebook ไม่ตอบกลับสำหรับคลิปนี้")); }
    }, 12000);
    FB.Event.subscribe("xfbml.ready", onReady);
    try { FB.XFBML.parse(body); } catch (e) { clearTimeout(timeout); reject(e); }
  }).then((player) => {
    activeFbPlayer = player;
    // นาฬิกาสำรองเริ่มนับจากจุดที่ดูค้าง (ถ้า seek อัตโนมัติไม่ได้ ผู้ใช้เลื่อนไปเองตามป้ายบอกเวลา)
    videoClockBase = position;
    if (position > 0) {
      const hint = document.createElement("div");
      hint.className = "video-resume-hint";
      hint.textContent = `ดูค้างไว้ที่ ${formatVideoTime(position)}`;
      el("#videoPlayerBody").appendChild(hint);
    }
    if (position > 0) {
      try { player.seek(position); } catch (e) { /* provider ไม่ยอม seek: ยังเล่นจากต้นได้ */ }
    }
    // seek ก่อนคลิปเริ่มเล่น Facebook มักไม่สนใจ (โดยเฉพาะบนมือถือที่ต้องแตะเล่นเอง) เลยกระโดดซ้ำอีกครั้ง
    // ตอนเริ่มเล่นจริงครั้งแรก — นี่คือเหตุที่เดิมเปิดคลิปแล้วเริ่มจากต้นทุกครั้ง
    let resumed = false;
    try {
      player.subscribe("startedPlaying", () => {
        startVideoClock();
        rememberVideoDuration();
        if (resumed || position <= 0) return;
        resumed = true;
        try { if (Number(player.getCurrentPosition()) < position - 3) player.seek(position); } catch (e) { /* เล่นจากต้นต่อได้ */ }
      });
      player.subscribe("paused", () => { stopVideoClock(); saveActiveVideoProgress(true); });
      player.subscribe("finishedPlaying", () => { stopVideoClock(); clearActiveVideoProgress(); playNextEpisode(); });
    } catch (e) { /* SDK บางรุ่นไม่มี event เหล่านี้ */ }
    return player;
  });
}

// ---------- ตัวเล่นของเว็บเอง (ไฟล์ MP4 ตรงจาก Facebook) ----------
// ได้ตำแหน่งจริงทุกเครื่อง (รวม iPhone) + seek ไปจุดดูค้างได้ + เล่นในกรอบ/PiP ได้
// ไม่มีไฟล์/เล่นไม่ได้ → กลับไปใช้ตัวเล่น Facebook แบบฝังเหมือนเดิม
const VIDEO_QUALITY_KEY = "videoQuality"; // auto | hd | sd (จำต่อเครื่อง)
const VIDEO_QUALITY_LABEL = { auto: "อัตโนมัติ", hd: "720p", sd: "360p" };
let nativeVideo = null;
let nativeSources = null;
let nativeQualityPref = "auto";
let nativeCurrentQuality = null;
let nativeStalls = [];

function readVideoQualityPref() {
  try { const v = localStorage.getItem(VIDEO_QUALITY_KEY); return VIDEO_QUALITY_LABEL[v] ? v : "auto"; } catch (e) { return "auto"; }
}

// Safari บน iPhone ไม่บอกชนิดเน็ต จึงวัดเอง: โหลดข้อมูลสุ่ม 256KB จากเซิร์ฟเวอร์เรา (ไฟล์ 720p ใช้ราว 1 Mbps)
// วัดกับไฟล์ fbcdn ตรง ๆ ไม่ได้ — fbcdn ไม่ส่ง CORS ให้ fetch อ่าน (แต่ <video> เล่นได้)
async function measureVideoBandwidthMbps() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  const t0 = performance.now();
  try {
    const res = await fetch(`/api/videos/speedtest?t=${Date.now()}`, { signal: ctrl.signal, cache: "no-store" });
    const bytes = (await res.arrayBuffer()).byteLength;
    return (bytes * 8) / ((performance.now() - t0) / 1000) / 1e6;
  } catch (e) {
    return 0; // ช้าจนเกิน 4 วิ = เน็ตช้า
  } finally { clearTimeout(timer); }
}

async function pickAutoQuality(sources) {
  if (!sources.hd) return "sd";
  if (!sources.sd) return "hd";
  return (await measureVideoBandwidthMbps()) >= 3 ? "hd" : "sd";
}

function renderQualityButtons() {
  const box = el("#videoQuality");
  if (!box || !nativeSources) return;
  const options = ["auto", ...["hd", "sd"].filter((q) => nativeSources[q])];
  box.innerHTML = options.map((q) => {
    const label = q === "auto" && nativeCurrentQuality ? `อัตโนมัติ (${VIDEO_QUALITY_LABEL[nativeCurrentQuality]})` : VIDEO_QUALITY_LABEL[q];
    return `<button class="video-quality-btn${q === nativeQualityPref ? " active" : ""}" data-quality="${q}">${label}</button>`;
  }).join("");
}

// เปลี่ยนไฟล์แล้วเล่นต่อจากวินาทีเดิม (สะดุดสั้น ๆ ระหว่างโหลดหัวไฟล์ใหม่)
function setNativeQuality(quality, startAt, autoplay = false) {
  const v = nativeVideo;
  if (!v || !nativeSources[quality]) return;
  const at = startAt ?? v.currentTime;
  const wasPlaying = autoplay || (startAt === undefined && !v.paused);
  nativeCurrentQuality = quality;
  nativeStalls = [];
  v.src = nativeSources[quality];
  v.addEventListener("loadedmetadata", () => {
    // สั่งเล่นหลัง seek เสร็จ — สั่ง play ระหว่าง seek เบราว์เซอร์หยุดเองหลังกระโดดเสร็จ (เจอตอนสลับ 360p↔720p)
    const resume = () => { if (wasPlaying) v.play().catch(() => {}); };
    if (at > 0) {
      v.addEventListener("seeked", resume, { once: true });
      v.currentTime = at;
    } else resume();
  }, { once: true });
  renderQualityButtons();
}

function mountNativeVideo(video, position, sources) {
  const body = el("#videoPlayerBody");
  body.innerHTML = `<div class="native-wrap"><video id="nativeVideo" class="native-video" controls playsinline preload="metadata"></video>
    <div class="tap-zone left" data-seek="-10"></div><div class="tap-zone right" data-seek="10"></div>
    <div id="seekBubble" class="seek-bubble" hidden></div></div>
    <div id="videoQuality" class="video-quality"></div>
    <div class="video-quality"><span id="videoSpeed" class="video-quality"></span><button id="sleepBtn" class="video-quality-btn">⏾ ตั้งเวลาปิด</button><button id="pipBtn" class="video-quality-btn" hidden>⧉ จอลอย</button></div>`;
  const v = el("#nativeVideo");
  nativeVideo = v;
  nativeSources = sources;
  nativeQualityPref = readVideoQualityPref();
  return new Promise(async (resolve, reject) => {
    const quality = nativeQualityPref === "auto" || !sources[nativeQualityPref] ? await pickAutoQuality(sources) : nativeQualityPref;
    if (nativeVideo !== v) return reject(new Error("closed"));
    const fail = () => { clearTimeout(timer); reject(new Error("native video failed")); };
    const timer = setTimeout(fail, 15000);
    v.addEventListener("error", fail, { once: true });
    v.addEventListener("loadedmetadata", () => {
      clearTimeout(timer);
      v.removeEventListener("error", fail);
      resolve();
    }, { once: true });
    setNativeQuality(quality, position);
  }).then(() => {
    activeFbPlayer = { getCurrentPosition: () => v.currentTime, getDuration: () => v.duration };
    videoApiWorks = true; // ตำแหน่งจริง ไม่ต้องใช้นาฬิกาสำรอง
    rememberVideoDuration();
    v.addEventListener("pause", () => { if (!v.ended) saveActiveVideoProgress(true); renderMiniPlay(); });
    v.addEventListener("play", renderMiniPlay);
    v.addEventListener("ended", () => { clearActiveVideoProgress(); playNextEpisode(); });
    v.addEventListener("webkitendfullscreen", nudgeViewport);
    initNativeExtras(v);
    // อัตโนมัติ: กระตุก (waiting) 2 ครั้งใน 60 วิ ขณะเล่น 720p → ลดเป็น 360p
    v.addEventListener("waiting", () => {
      if (nativeQualityPref !== "auto" || nativeCurrentQuality !== "hd" || !nativeSources.sd || v.seeking) return;
      const now = Date.now();
      nativeStalls = nativeStalls.filter((t) => now - t < 60000).concat(now);
      if (nativeStalls.length >= 2) setNativeQuality("sd");
    });
    el("#videoQuality").addEventListener("click", async (event) => {
      const q = event.target.closest("[data-quality]")?.dataset.quality;
      if (!q || q === nativeQualityPref) return;
      nativeQualityPref = q;
      try { localStorage.setItem(VIDEO_QUALITY_KEY, q); } catch (e) { /* ไม่จำก็ได้ */ }
      setNativeQuality(q === "auto" ? await pickAutoQuality(nativeSources) : q);
    });
  });
}

// ตอนถัดไปของ playlist: เปลี่ยนไฟล์ใน <video> ตัวเดิม (listener ต่าง ๆ อ้างตัวแปรกลาง ใช้ต่อได้เลย) แล้วสั่งเล่น
function reuseNativeVideo(position, sources) {
  const v = nativeVideo;
  nativeSources = sources;
  return new Promise(async (resolve, reject) => {
    const quality = nativeQualityPref === "auto" || !sources[nativeQualityPref] ? await pickAutoQuality(sources) : nativeQualityPref;
    if (nativeVideo !== v) return reject(new Error("closed"));
    const fail = () => { clearTimeout(timer); reject(new Error("native video failed")); };
    const timer = setTimeout(fail, 15000);
    v.addEventListener("error", fail, { once: true });
    v.addEventListener("loadedmetadata", () => {
      clearTimeout(timer);
      v.removeEventListener("error", fail);
      activeFbPlayer = { getCurrentPosition: () => v.currentTime, getDuration: () => v.duration };
      videoApiWorks = true;
      rememberVideoDuration();
      resolve();
    }, { once: true });
    setNativeQuality(quality, position, true);
  });
}

// iPhone (เว็บแอปจากหน้าจอโฮม): ดูเต็มจอแนวนอนแล้วออก/หมุนกลับแนวตั้ง Safari ยังจัดของที่ position: fixed
// (หน้าตัวเล่น, แถบเมนูล่าง) ตามความสูงจอแนวนอน → ตัวเล่นเหลือครึ่งจอ เมนูล่างลอยกลางจอ
// กระตุ้นให้คำนวณ viewport ใหม่ด้วยการเลื่อนหน้า 1px แล้วเลื่อนกลับ (ซ้ำหลังแอนิเมชันหมุนจอจบ)
function nudgeViewport() {
  [100, 500, 1000].forEach((ms) => setTimeout(() => {
    const y = window.scrollY;
    window.scrollTo(0, y + 1);
    window.scrollTo(0, y);
  }, ms));
}

// ---------- ความเร็ว / แตะสองครั้งข้าม 10 วิ / ตั้งเวลาปิด (เฉพาะตัวเล่นของเว็บเอง) ----------
const VIDEO_SPEED_KEY = "videoSpeed";
const VIDEO_SPEEDS = [1, 1.25, 1.5, 2];
const SLEEP_OPTIONS = [0, 15, 30, 60, 90]; // นาที, 0 = ปิด
let sleepChoice = 0;
let sleepTimer = null;
let sleepEndsAt = 0;
let sleepTicker = null;

function readVideoSpeed() {
  try { const v = Number(localStorage.getItem(VIDEO_SPEED_KEY)); return VIDEO_SPEEDS.includes(v) ? v : 1; } catch (e) { return 1; }
}

function renderSpeedButtons(v) {
  el("#videoSpeed").innerHTML = VIDEO_SPEEDS.map((sp) =>
    `<button class="video-quality-btn${v.playbackRate === sp ? " active" : ""}" data-speed="${sp}">${sp}x</button>`).join("");
}

function showSeekBubble(text, side) {
  const bubble = el("#seekBubble");
  if (!bubble) return;
  bubble.textContent = text;
  bubble.className = `seek-bubble ${side}`;
  bubble.hidden = false;
  clearTimeout(showSeekBubble.timer);
  showSeekBubble.timer = setTimeout(() => { bubble.hidden = true; }, 650);
}

function clearSleepTimer() {
  clearTimeout(sleepTimer);
  clearInterval(sleepTicker);
  sleepTimer = sleepTicker = null;
  sleepChoice = 0;
}

function renderSleepButton() {
  const btn = el("#sleepBtn");
  if (!btn) return;
  btn.classList.toggle("active", sleepChoice !== 0);
  btn.textContent = sleepChoice === 0 ? "⏾ ตั้งเวลาปิด"
    : `⏾ ปิดใน ${Math.max(1, Math.ceil((sleepEndsAt - Date.now()) / 60000))} นาที`;
}

function initNativeExtras(v) {
  v.playbackRate = readVideoSpeed();
  // เปลี่ยนไฟล์ (สลับความละเอียด) แล้วเบราว์เซอร์รีเซ็ตความเร็วเป็น 1x → ตั้งกลับทุกครั้งที่โหลดไฟล์ใหม่
  v.addEventListener("loadedmetadata", () => { v.playbackRate = readVideoSpeed(); renderSpeedButtons(v); });
  renderSpeedButtons(v);
  el("#videoSpeed").addEventListener("click", (event) => {
    const sp = Number(event.target.closest("[data-speed]")?.dataset.speed);
    if (!sp) return;
    v.playbackRate = sp;
    try { localStorage.setItem(VIDEO_SPEED_KEY, String(sp)); } catch (e) { /* ไม่จำก็ได้ */ }
    renderSpeedButtons(v);
  });

  // แตะสองครั้งฝั่งซ้าย/ขวาของภาพ = ย้อน/ข้าม 10 วิ, แตะครั้งเดียว = เล่น/หยุด
  // (เว้นแถบควบคุมด้านล่างของตัวเล่นไว้ให้กดได้ตามปกติ)
  // iPhone: ตัวเล่นของระบบมีปุ่มขยายจอ/เสียง (มุมบน) และย้อน/ข้าม 10 วิ (ซ้าย-ขวากลางภาพ) อยู่แล้ว
  // พื้นที่แตะของเราไปทับปุ่มพวกนั้นจนกดไม่ได้ → ไม่ใช้บน iPhone
  if (isIOS) els(".tap-zone").forEach((zone) => zone.remove());
  els(".tap-zone").forEach((zone) => {
    let lastTap = 0;
    let singleTimer = null;
    zone.addEventListener("click", () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        clearTimeout(singleTimer);
        const step = Number(zone.dataset.seek);
        v.currentTime = Math.min(Math.max(0, v.currentTime + step), v.duration || Infinity);
        showSeekBubble(step < 0 ? "⏪ 10 วิ" : "10 วิ ⏩", step < 0 ? "left" : "right");
        lastTap = 0;
        return;
      }
      lastTap = now;
      singleTimer = setTimeout(() => { if (v.paused) v.play().catch(() => {}); else v.pause(); }, 300);
    });
  });

  // ตั้งเวลาปิด: แตะวนตัวเลือก ปิด → 15 → 30 → 60 → 90 นาที → ปิด
  el("#sleepBtn").addEventListener("click", () => {
    const next = SLEEP_OPTIONS[(SLEEP_OPTIONS.indexOf(sleepChoice) + 1) % SLEEP_OPTIONS.length];
    clearSleepTimer();
    sleepChoice = next;
    if (next > 0) {
      sleepEndsAt = Date.now() + next * 60000;
      sleepTimer = setTimeout(() => { v.pause(); clearSleepTimer(); renderSleepButton(); }, next * 60000);
      sleepTicker = setInterval(renderSleepButton, 30000);
    }
    renderSleepButton();
  });
  renderSleepButton();
  initPictureInPicture(v);
}

// จอลอย (Picture-in-Picture): ดูคลิปต่อในหน้าต่างเล็กขณะใช้แอปอื่น — ทำได้เพราะเป็นตัวเล่นของเว็บเอง
// (ตัวเล่น Facebook แบบฝังสั่งไม่ได้) Chrome/Android/เดสก์ท็อปใช้ API มาตรฐาน, Safari/iPhone ใช้ webkitSetPresentationMode
function pipState(v) {
  // iPhone เว็บแอปจากหน้าจอโฮม: iOS ไม่ยอมเปิดจอลอย (ลองแล้ว: Safari ได้ / ไอคอนหน้าจอโฮมไม่ได้) → ซ่อนปุ่ม
  if (isIOS && isStandalone) return { supported: false, active: false };
  if (document.pictureInPictureEnabled && !v.disablePictureInPicture) {
    return { supported: true, active: document.pictureInPictureElement === v };
  }
  if (typeof v.webkitSetPresentationMode === "function" && v.webkitSupportsPresentationMode?.("picture-in-picture")) {
    return { supported: true, active: v.webkitPresentationMode === "picture-in-picture" };
  }
  return { supported: false, active: false };
}

function renderPipButton(v) {
  const btn = el("#pipBtn");
  if (!btn) return;
  const { supported, active } = pipState(v);
  btn.hidden = !supported;
  btn.classList.toggle("active", active);
  btn.textContent = active ? "⧉ ออกจากจอลอย" : "⧉ จอลอย";
}

function initPictureInPicture(v) {
  v.setAttribute("autopictureinpicture", ""); // Safari: ออกไปหน้าโฮมระหว่างเล่นเต็มจอ = ย่อเป็นจอลอยเอง
  el("#pipBtn").addEventListener("click", async () => {
    const { active } = pipState(v);
    // iPhone มีทั้งสองแบบ แต่แบบมาตรฐานใช้ไม่ได้ในบางโหมด → ลองแบบ webkit ของ Safari ก่อน แล้วค่อยแบบมาตรฐาน
    const webkit = typeof v.webkitSetPresentationMode === "function" && v.webkitSupportsPresentationMode?.("picture-in-picture");
    try {
      if (webkit) {
        v.webkitSetPresentationMode(active ? "inline" : "picture-in-picture");
      } else if (active) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      alert(`เปิดจอลอยไม่ได้: ${e.name || ""} ${e.message || e}`);
    }
    // สั่งแล้วไม่เข้าจอลอย (ระบบเงียบ ๆ ไม่ยอม) → บอกผู้ใช้ แทนที่ปุ่มจะดูเหมือนไม่ทำงาน
    setTimeout(() => {
      if (!active && !pipState(v).active) alert("เครื่องนี้ไม่ยอมเปิดจอลอยจากเว็บนี้ — บน iPhone ลองเปิดเว็บผ่าน Safari (ไม่ใช่ไอคอนหน้าจอโฮม) แล้วกดอีกครั้ง");
    }, 1200);
  });
  ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "loadedmetadata"].forEach((name) =>
    v.addEventListener(name, () => renderPipButton(v)));
  renderPipButton(v);
}

function unmountNativeVideo() {
  if (!nativeVideo) return;
  // หยุดโหลดทันที ไม่ให้เบราว์เซอร์โหลดคลิปต่อเบื้องหลังจนเปลืองเน็ต
  clearSleepTimer();
  nativeVideo.pause();
  nativeVideo.removeAttribute("src");
  nativeVideo.load();
  nativeVideo = null;
  nativeSources = null;
  nativeCurrentQuality = null;
}

async function openVideo(video, { autoplay = false } = {}) {
  cancelNextCountdown();
  if (isVideoMini()) setVideoMini(false);
  activeVideo = video;
  activeFbPlayer = null;
  activeVideoDuration = Number(video.duration_seconds) || null;
  lastSavedVideoPosition = null;
  activeVideoFinished = false;
  videoApiWorks = false;
  videoClockBase = 0;
  videoClockStartedAt = null;
  const playlist = video.playlist_id && (state.videoPlaylists || []).find((p) => p.id === video.playlist_id);
  el("#videoPlayerTitle").textContent = playlist ? `${playlist.name} · ${episodeLabel(video)}` : video.title;
  renderEpisodeNav(video);
  refreshCommentCount({ kind: "video", id: video.id }, el("#videoCommentCount"));
  el("#videoDeleteBtn").hidden = !video.can_delete;
  el("#videoPlayer").hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const [progress, sources] = await Promise.all([
      getJSON(`/api/videos/${encodeURIComponent(video.id)}/progress`),
      getJSON(`/api/videos/${encodeURIComponent(video.id)}/sources`).catch(() => ({})),
    ]);
    if (!activeVideo || activeVideo.id !== video.id) return;
    const position = Number(progress.position_seconds) || 0;
    let native = false;
    if ((sources.hd || sources.sd) && autoplay && nativeVideo) {
      native = await reuseNativeVideo(position, sources).then(() => true, () => false);
      if (!activeVideo || activeVideo.id !== video.id) return;
    } else if (sources.hd || sources.sd) {
      unmountNativeVideo();
      try { await mountNativeVideo(video, position, sources); native = true; }
      catch (e) { unmountNativeVideo(); if (!activeVideo || activeVideo.id !== video.id) return; }
    }
    if (!native) {
      unmountNativeVideo();
      await mountFacebookVideo(video, position);
    }
    clearInterval(videoSaveTimer);
    videoSaveTimer = setInterval(saveActiveVideoProgress, 10000);
  } catch (e) {
    if (activeVideo?.id === video.id) el("#videoPlayerBody").innerHTML = `<div class="reader-msg">${escapeHtml(e.body?.error || e.message || "เปิดคลิปไม่สำเร็จ")}</div>`;
  }
}

function activeVideoPosition() {
  if (!activeVideo || !activeFbPlayer) return null;
  try {
    const value = Number(activeFbPlayer.getCurrentPosition());
    if (Number.isFinite(value) && value > 0) videoApiWorks = true;
    if (videoApiWorks) return Number.isFinite(value) && value >= 0 ? value : null;
  } catch (e) { /* ใช้นาฬิกาสำรอง */ }
  // API ไม่เคยบอกตำแหน่งจริง: ใช้เวลาที่นับเอง (ยังไม่เคยเริ่มเล่น = 0 ไม่บันทึก)
  return videoClockPosition();
}

function videoClockPosition() {
  return videoClockBase + (videoClockStartedAt === null ? 0 : (Date.now() - videoClockStartedAt) / 1000);
}

function startVideoClock() {
  if (videoClockStartedAt === null) videoClockStartedAt = Date.now();
}

function stopVideoClock() {
  if (videoClockStartedAt === null) return;
  videoClockBase = videoClockPosition();
  videoClockStartedAt = null;
}

function formatVideoTime(seconds) {
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

let activeVideoDuration = null;

function rememberVideoDuration() {
  try {
    const d = Number(activeFbPlayer && activeFbPlayer.getDuration());
    if (Number.isFinite(d) && d > 0) activeVideoDuration = d;
  } catch (e) { /* ไม่รู้ความยาวก็ยังบันทึกตำแหน่งได้ */ }
}

function saveActiveVideoProgress(force = false) {
  const position = activeVideoPosition();
  if (activeVideoFinished || position === null || !activeVideo) return;
  if (!force && lastSavedVideoPosition !== null && Math.abs(position - lastSavedVideoPosition) < 5) return;
  rememberVideoDuration();
  // ดูไปไม่ถึง 5 วิ ไม่นับว่าดูค้าง / ดูเกือบจบ (95%) นับว่าจบ — เปิดใหม่ควรเริ่มจากต้น
  if (position < 5) return;
  if (activeVideoDuration && position >= activeVideoDuration * 0.95) return clearActiveVideoProgress();
  lastSavedVideoPosition = position;
  const video = activeVideo;
  // อัปเดตการ์ดในหน้าคลังทันที ไม่ต้องรอโหลดใหม่ (แถบความคืบหน้า + ป้ายดูต่อ)
  video.position_seconds = position;
  video.watched_at = new Date().toISOString();
  if (activeVideoDuration) video.duration_seconds = activeVideoDuration;
  fetch(`/api/videos/${encodeURIComponent(video.id)}/progress`, {
    method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
    body: JSON.stringify({ position_seconds: position, duration_seconds: activeVideoDuration || undefined }),
  }).catch(() => { lastSavedVideoPosition = null; });
}

function clearActiveVideoProgress() {
  if (!activeVideo) return;
  activeVideoFinished = true; // กัน close หลัง event จบเขียนเวลาสุดท้ายกลับเข้ามาแข่งกับ DELETE
  fetch(`/api/videos/${encodeURIComponent(activeVideo.id)}/progress`, { method: "DELETE", keepalive: true }).catch(() => {});
  activeVideo.position_seconds = 0;
  activeVideo.watched_at = new Date().toISOString();
  lastSavedVideoPosition = 0;
}

function closeVideo() {
  closeComments();
  stopVideoClock();
  saveActiveVideoProgress(true);
  unmountNativeVideo();
  clearInterval(videoSaveTimer);
  videoSaveTimer = null;
  activeFbPlayer = null;
  activeVideo = null;
  activeVideoFinished = false;
  cancelNextCountdown();
  el("#videoPlayer").classList.remove("mini");
  el("#miniBar").hidden = true;
  el("#videoPlayer").hidden = true;
  el("#videoDeleteBtn").hidden = true;
  el("#episodeNav").hidden = true;
  el("#playerEpisodes").hidden = true;
  el("#videoPlayerBody").innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  if (el("#playlistView").hidden) document.body.style.overflow = "";
  renderVideos();
  reloadIfPending();
}

function initVideos() {
  el("#addVideoBtn").addEventListener("click", () => { videoFormMsg(""); showVideoForm(true); });
  els("[data-close-video-form]").forEach((button) => button.addEventListener("click", () => showVideoForm(false)));
  el("#videoForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (videoSubmitting) return;
    videoSubmitting = true;
    const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const submitButton = formEl.querySelector(".btn.primary");
    submitButton.disabled = true;
    videoFormMsg("กำลังเพิ่ม...");
    try {
      const response = await fetch("/api/videos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error("request failed"), { body: data });
      formEl.reset();
      showVideoForm(false);
      // ดึงรายการจริงอีกครั้ง: แม้ network ตัดหลัง POST สำเร็จ/คำตอบไม่ครบ หน้าคลังก็ตรงกับเซิร์ฟเวอร์
      await loadVideos();
    } catch (e) { videoFormMsg(e.body?.error || "เพิ่มคลิปไม่สำเร็จ", true); }
    finally {
      videoSubmitting = false;
      submitButton.disabled = false;
    }
  });
  const onVideoGridClick = async (event) => {
    // การ์ดเรื่อง (playlist) ในผลค้นหา
    const savePlaylistBtn = event.target.closest("[data-save-playlist]");
    if (savePlaylistBtn) return togglePlaylistSave(savePlaylistBtn.dataset.savePlaylist, savePlaylistBtn);
    const playlistCard = event.target.closest("[data-playlist-id]");
    if (playlistCard) return openPlaylist(playlistCard.dataset.playlistId);
    const saveBtn = event.target.closest("[data-save-video]");
    if (saveBtn) {
      const item = state.videos.find((v) => v.id === saveBtn.closest(".video-item")?.dataset.videoId);
      if (!item) return;
      saveBtn.disabled = true;
      try {
        const data = await sendJSON("POST", `/api/videos/${encodeURIComponent(item.id)}/save`, { saved: !item.saved_at });
        item.saved_at = data.saved_at || null;
        renderVideos();
      } catch (e) { alert(e.message || "บันทึกไม่สำเร็จ"); saveBtn.disabled = false; }
      return;
    }
    const card = event.target.closest(".video-card");
    // คลิปแบบเปิดใน Facebook ไม่มีหน้าตัวเล่น (ที่มีปุ่มลบ) จึงลบจากปุ่มบนการ์ดแทน
    if (event.target.closest("[data-delete-video]")) {
      event.preventDefault();
      const target = state.videos.find((item) => item.id === card?.dataset.videoId);
      if (!target || !confirm(`ลบคลิป "${target.title}"?\n(ทุกคนจะไม่เห็นคลิปนี้อีก)`)) return;
      try { await sendJSON("DELETE", `/api/videos/${encodeURIComponent(target.id)}`); }
      catch (e) { alert(e.message || "ลบคลิปไม่สำเร็จ"); return; }
      await loadVideos();
      return;
    }
    const video = state.videos.find((item) => item.id === card?.dataset.videoId);
    if (video && !video.external) openVideo(video);
  };
  el("#videoGrid").addEventListener("click", onVideoGridClick);
  el("#searchVideoGrid").addEventListener("click", onVideoGridClick);
  el("#videoMoreBtn").addEventListener("click", () => { videoShown += VIDEO_PAGE_SIZE; renderVideos(); });
  el("#videoCategoryChips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-video-category]");
    if (!chip) return;
    videoCategoryFilter = chip.dataset.videoCategory || null;
    resetVideoPaging();
    renderVideos();
  });
  els("[data-video-tab]").forEach((button) => button.addEventListener("click", () => {
    // "คลังของฉัน" = กลับไปแท็บย่อยล่าสุด (บันทึกไว้ / ประวัติการดู)
    const tab = button.dataset.videoTab === "library" ? lastLibraryTab : button.dataset.videoTab;
    if (tab !== "home") lastLibraryTab = tab;
    videoTab = tab;
    libraryEditing = false;
    librarySelected.clear();
    resetVideoPaging();
    renderVideos();
    window.scrollTo(0, 0);
  }));
  el("#videoHome").addEventListener("click", (event) => {
    const play = event.target.closest("[data-hero-play]")?.dataset.heroPlay;
    if (play) {
      const v = state.videos.find((x) => x.id === play);
      if (v) openVideo(v);
      return;
    }
    const saveBtn = event.target.closest("[data-save-playlist]");
    if (saveBtn) return togglePlaylistSave(saveBtn.dataset.savePlaylist, saveBtn);
    const filter = event.target.closest("[data-row-filter]")?.dataset.rowFilter;
    if (filter) {
      videoCategoryFilter = filter;
      resetVideoPaging();
      renderVideos();
      window.scrollTo(0, 0);
      return;
    }
    const tile = event.target.closest(".mm-tile[data-video-id]");
    if (tile) {
      const v = state.videos.find((x) => x.id === tile.dataset.videoId);
      if (v) openVideo(v);
      return;
    }
    const card = event.target.closest("[data-playlist-id]");
    if (card) openPlaylist(card.dataset.playlistId);
  });
  el("#videoPlayerClose").addEventListener("click", closeVideo);
  el("#playlistRow").addEventListener("click", (event) => {
    const saveBtn = event.target.closest("[data-save-playlist]");
    if (saveBtn) return togglePlaylistSave(saveBtn.dataset.savePlaylist, saveBtn);
    const card = event.target.closest("[data-playlist-id]");
    if (card) openPlaylist(card.dataset.playlistId);
  });
  el("#playlistClose").addEventListener("click", closePlaylist);
  initVideoInfiniteScroll();
  el("#playlistBody").addEventListener("click", (event) => {
    const range = event.target.closest("[data-ep-range]")?.dataset.epRange;
    if (range !== undefined) { playlistRange = Number(range); return renderPlaylistView(); }
    if (event.target.closest("[data-ep-sort]")) { playlistDesc = !playlistDesc; playlistRange = 0; return renderPlaylistView(); }
    const saveBtn = event.target.closest("[data-save-playlist]");
    if (saveBtn) return togglePlaylistSave(saveBtn.dataset.savePlaylist, saveBtn);
    const id = event.target.closest("[data-episode-id]")?.dataset.episodeId;
    const video = id && state.videos.find((v) => v.id === id);
    if (video) openVideo(video);
  });
  el("#playerEpisodes").addEventListener("click", (event) => {
    const id = event.target.closest("[data-episode-id]")?.dataset.episodeId;
    const v = id && state.videos.find((x) => x.id === id);
    if (v && v.id !== activeVideo?.id) playEpisode(v);
  });
  el("#nextCancelBtn").addEventListener("click", cancelNextCountdown);
  el("#nextNowBtn").addEventListener("click", () => {
    const v = state.videos.find((x) => x.id === el("#nextOverlay").dataset.next);
    cancelNextCountdown();
    if (v) playEpisode(v);
  });
  el("#videoMinBtn").addEventListener("click", () => setVideoMini(true));
  el("#miniExpand").addEventListener("click", () => setVideoMini(false));
  el("#miniClose").addEventListener("click", closeVideo);
  el("#miniPlay").addEventListener("click", () => {
    try {
      if (nativeVideo) { if (nativeVideo.paused) nativeVideo.play(); else nativeVideo.pause(); }
      else if (activeFbPlayer) activeFbPlayer.pause();
    } catch (e) { /* ตัวเล่น Facebook บางรุ่นไม่รับคำสั่ง */ }
    setTimeout(renderMiniPlay, 100);
  });
  el("#episodePrev").addEventListener("click", () => playEpisode(neighborEpisode(activeVideo, -1)));
  el("#episodeNext").addEventListener("click", () => playEpisode(neighborEpisode(activeVideo, 1)));
  el("#autoNextBtn").addEventListener("click", () => {
    try { localStorage.setItem(AUTO_NEXT_KEY, autoNextOn() ? "off" : "on"); } catch (e) { /* ไม่จำก็ได้ */ }
    renderAutoNext();
  });
  window.addEventListener("pagehide", () => { stopVideoClock(); saveActiveVideoProgress(true); });
  window.addEventListener("orientationchange", nudgeViewport);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) nudgeViewport(); });
  document.addEventListener("webkitfullscreenchange", () => { if (!document.webkitFullscreenElement) nudgeViewport(); });
  // แตะเล่นในกรอบคลิป (iframe ของ Facebook) ทำให้หน้าเว็บเสียโฟกัส — ใช้เป็นสัญญาณเริ่มเล่นสำรอง
  // เผื่อ iPhone ไม่ส่ง startedPlaying มา
  window.addEventListener("blur", () => setTimeout(() => {
    if (activeFbPlayer && document.activeElement?.tagName === "IFRAME" && el("#videoPlayerBody").contains(document.activeElement)) {
      startVideoClock();
    }
  }, 0));
  // สลับแอป/ปิดจอบนมือถือ: pagehide มักไม่ยิง แต่ visibilitychange ยิงเสมอ
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !activeVideo) return;
    stopVideoClock(); // สลับแอป/ล็อกจอ คลิปหยุดเล่น นาฬิกาสำรองต้องหยุดด้วย
    saveActiveVideoProgress(true);
  });
  el("#videoDeleteBtn").addEventListener("click", async (event) => {
  const video = activeVideo;
  if (!video || !confirm(`ลบคลิป "${video.title}"?\n(ทุกคนจะไม่เห็นคลิปนี้อีก)`)) return;
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    await sendJSON("DELETE", `/api/videos/${encodeURIComponent(video.id)}`);
  } catch (e) {
    alert(e.message || "ลบคลิปไม่สำเร็จ");
    return;
  } finally {
    btn.disabled = false;
  }
  activeVideoFinished = true; // กัน closeVideo เซฟตำแหน่งของคลิปที่เพิ่งลบ
  closeVideo();
  await loadVideos();
});
}

function initTabs() {
  els(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      // กดแท็บเดิมซ้ำ = เลื่อนกลับบนสุด (เหมือนแอปทั่วไป)
      if (btn.dataset.tab === state.tab) return window.scrollTo({ top: 0, behavior: "smooth" });
      showTab(btn.dataset.tab);
    });
  });
  document.body.dataset.tab = "list";
  state.tab = "list";
}

// ---------- หน้าหลัก: "หน้าหลัก" (กริดเรื่องที่ติดตาม) / "รายการอ่านล่าสุด" ----------
state.homeMode = "grid";
state.history = [];
let readerFromHistory = false; // เปิดหน้าอ่านจากปุ่ม "อ่านต่อ" — ปิดแล้วกลับมารายการอ่านล่าสุด ไม่ใช่หน้าเลือกตอน

function setHomeMode(mode) {
  state.homeMode = mode;
  els(".home-tab").forEach((b) => b.classList.toggle("active", b.dataset.home === mode));
  el("#mangaGrid").hidden = mode !== "grid";
  el("#emptyState").hidden = mode !== "grid" || state.manga.length > 0;
  el("#historyView").hidden = mode !== "history";
  renderContinue();
  if (mode === "history") {
    renderHistory();
    loadHistory();
  }
}

function initHomeTabs() {
  els(".home-tab").forEach((b) => b.addEventListener("click", () => setHomeMode(b.dataset.home)));
  el("#historyList").addEventListener("click", (e) => {
    const row = e.target.closest(".history-row");
    if (!row) return;
    const item = state.history.find((h) => h.id === row.dataset.id);
    if (!item) return;
    if (e.target.closest('[data-action="resume"]')) resumeReading(item);
    else openChapterList(item);
  });
}

async function loadHistory() {
  try {
    state.history = (await getJSON("/api/history")).items;
    renderHistory();
    renderContinue();
  } catch (e) {
    // ใช้ของเดิมต่อ
  }
}

// "อ่านล่าสุดวันนี้" / "เมื่อวาน" / "N วันที่แล้ว" — นับตามวันในปฏิทินของเครื่อง ไม่ใช่ครบ 24 ชม.
function readAgo(iso) {
  if (!iso) return "";
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(new Date(iso))) / 86400000);
  if (days <= 0) return "อ่านล่าสุดวันนี้";
  if (days === 1) return "อ่านล่าสุดเมื่อวาน";
  if (days < 30) return `อ่านล่าสุด ${days} วันที่แล้ว`;
  return `อ่านล่าสุด ${new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}`;
}

function renderHistory() {
  const items = withoutSpecial(state.history);
  const unread = items.filter((h) => h.is_new).length;
  el("#historyStats").innerHTML = items.length
    ? `<span class="history-count">${items.length} เรื่อง</span><span class="history-unread">${unread} เรื่องที่มีตอนใหม่ยังไม่อ่าน</span>`
    : "";
  el("#historyEmpty").hidden = items.length > 0;
  el("#historyList").innerHTML = items
    .map(
      (h) => `
      <li class="history-row" data-id="${escapeHtml(h.id)}">
        <img class="history-cover" src="${proxied(h.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
        <div class="history-info">
          <div class="history-name">${h.is_new ? '<span class="badge-up" title="มีตอนใหม่ที่ยังไม่อ่าน">ใหม่</span>' : ""}<span>${escapeHtml(h.name)}</span></div>
          <div class="history-chapter">${escapeHtml(h.chapter_text || "")}${h.fraction ? ` · ค้างไว้ ${Math.round(h.fraction * 100)}%` : ""}</div>
          <div class="history-time">${readAgo(h.last_read_at)}</div>
        </div>
        <button class="btn resume-btn" data-action="resume"${h.chapter_url ? "" : " disabled"}>อ่านต่อ</button>
      </li>`
    )
    .join("");
}

// เปิดตอนที่อ่านล่าสุดตรง ๆ และเลื่อนไปจุดที่อ่านค้างไว้ (ใช้กลไกกู้ตำแหน่งเดียวกับหน้าเลือกตอน)
function resumeReading(item) {
  if (!item.chapter_url) return;
  currentManga = { id: item.id, name: item.name, latest_chapter_url: item.latest_chapter_url };
  readerFromHistory = true;
  lastReadUrl = item.chapter_url;
  lastScrollInfo = item.fraction ? { url: item.chapter_url, fraction: item.fraction } : null;
  const cached = chapterListCache.get(item.id);
  currentChapters = cached ? cached.chapters || [] : [];
  openReader(item.chapter_url);
  // รายชื่อตอนไว้แสดงชื่อตอน/มาร์คอ่านแล้วในเครื่อง ไม่ต้องรอ — หน้าอ่านเปิดได้ก่อน
  getJSON(`/api/manga/${item.id}/chapters`)
    .then((data) => {
      chapterListCache.set(item.id, data);
      if (currentManga && currentManga.id === item.id) currentChapters = data.chapters || [];
    })
    .catch(() => {});
}

// ---------- หมวดหมู่ในหน้า "ทั้งหมด" ----------
state.categories = BOOT.categories || [];
state.catalogMode = "all"; // "all" = เรื่องทั้งหมด, "category" = กรองตามหมวด
state.activeCategory = null;

function updateCategoryBar() {
  const show = state.tab === "catalog" && state.catalogMode === "category";
  el("#categoryBar").hidden = !show;
  if (!show) setCategoryPanel(false);
}

// ---------- หมวดพิเศษ ----------
// หมวดที่ admin ตั้งเป็น "พิเศษ" ซ่อนไว้ (ทั้งตัวหมวดและเรื่องที่อยู่ในหมวดนั้น) จนกว่าผู้ใช้จะเปิดเองในหน้าตั้งค่า
// เรื่องที่ผู้ใช้ติดตามอยู่แล้วยังขึ้นในหน้าหลักตามปกติ — ซ่อนเฉพาะตอนเลือกดู/ค้นหา
function showSpecial() {
  return Boolean(state.prefs.show_special);
}

function visibleCategories() {
  return showSpecial() ? state.categories : state.categories.filter((c) => !c.special);
}

// กรองเรื่องที่อยู่ในหมวดพิเศษออก (ถ้าผู้ใช้ไม่ได้เปิดแสดง) — ใช้ทั้งหน้าทั้งหมด, ค้นหา และรายการอ่านล่าสุด
function withoutSpecial(items) {
  if (showSpecial()) return items;
  const hidden = new Set(state.categories.filter((c) => c.special).map((c) => c.id));
  if (!hidden.size) return items;
  return items.filter((m) => !(m.categories || []).some((id) => hidden.has(id)));
}

function catalogVisible() {
  return withoutSpecial(state.catalog);
}

// ---------- ธีม ----------
const THEMES = [
  { id: "light", icon: "☀️", label: "โหมดสว่าง" },
  { id: "dark", icon: "🌙", label: "โหมดมืด" },
  { id: "system", icon: "📱", label: "ตามการตั้งค่าอุปกรณ์" },
];

function currentTheme() {
  return document.documentElement.dataset.theme || "dark";
}

// สีแถบสถานะ/แถบที่อยู่ของมือถือ ให้ตรงกับสีแถบด้านบนของเว็บในธีมที่ใช้อยู่จริง
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bg-elevated").trim();
  els('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
}

function renderThemeMenu() {
  const theme = THEMES.find((t) => t.id === currentTheme()) || THEMES[1];
  el("#themeBtn").textContent = `${theme.icon} ${theme.label}`;
  el("#themeMenu").innerHTML = THEMES.map(
    (t) =>
      `<button class="menu-item" role="menuitemradio" aria-checked="${t.id === theme.id}" data-theme="${t.id}">
         <span class="menu-check">${t.id === theme.id ? "✓" : ""}</span><span>${t.icon}</span><span>${t.label}</span>
       </button>`
  ).join("");
}

function setThemeMenu(open) {
  el("#themeMenu").hidden = !open;
  el("#themeBtn").setAttribute("aria-expanded", String(open));
}

function initTheme() {
  renderThemeMenu();
  syncThemeColor();
  // โหมด "ตามอุปกรณ์": เครื่องสลับสว่าง/มืดเอง (เช่นตามเวลา) ต้องเปลี่ยนสีแถบสถานะตามด้วย
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", syncThemeColor);
  // บางเครื่อง/บางเบราว์เซอร์ไม่ยิง event ข้างบนตอนแอปอยู่เบื้องหลัง — เช็คซ้ำทุกครั้งที่กลับมาเปิด
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncThemeColor(); });

  el("#themeBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    setThemeMenu(el("#themeMenu").hidden);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#themeMenu")) setThemeMenu(false);
  });
  el("#themeMenu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-theme]");
    if (!item) return;
    const theme = item.dataset.theme;
    document.documentElement.dataset.theme = theme;
    state.prefs.theme = theme;
    try {
      localStorage.setItem("theme", theme); // ให้หน้า login ใช้ธีมเดียวกันด้วย (หน้านั้นยังไม่รู้ว่าเป็นใคร)
    } catch (err) {
      // โหมดส่วนตัวบางเบราว์เซอร์เขียนไม่ได้ ไม่เป็นไร
    }
    renderThemeMenu();
    syncThemeColor();
    setThemeMenu(false);
    fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme }) });
  });
}

function renderPrefs() {
  el("#prefCard").hidden = !state.categories.some((c) => c.special);
  el("#showSpecialToggle").checked = showSpecial();
}

function initPrefs() {
  renderPrefs();
  el("#showSpecialToggle").addEventListener("change", (e) => {
    state.prefs.show_special = e.target.checked;
    lastCatalogSignature = null;
    renderCategoryChips();
    renderCatalog(filterCatalog());
    renderSearch();
    renderHistory();
    fetch("/api/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show_special: e.target.checked }),
    });
  });
}

function renderCategoryChips() {
  const cats = visibleCategories();
  if (!cats.some((c) => c.id === state.activeCategory)) state.activeCategory = cats[0] ? cats[0].id : null;
  const html = cats.length
    ? cats
        .map(
          (c) =>
            `<button class="chip${c.id === state.activeCategory ? " active" : ""}" data-cat="${escapeHtml(c.id)}" role="tab">${escapeHtml(c.name)}</button>`
        )
        .join("")
    : `<span class="chip-empty">ยังไม่มีหมวดหมู่${state.currentUser.is_admin ? " — เพิ่มได้ที่ ตั้งค่า → หมวดหมู่" : ""}</span>`;
  el("#categoryChips").innerHTML = html;
  el("#categoryPanel").innerHTML = html;
  el("#categoryExpand").hidden = cats.length === 0;
  const active = el(`#categoryChips .chip.active`);
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
}

function setCategoryPanel(open) {
  el("#categoryPanel").hidden = !open;
  el("#categoryExpand").classList.toggle("open", open);
  el("#categoryExpand").setAttribute("aria-expanded", String(open));
}

function initCatalogModes() {
  els(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.catalogMode = btn.dataset.catmode;
      els(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderCategoryChips();
      updateCategoryBar();
      renderCatalog(filterCatalog());
    });
  });
  const pick = (e) => {
    const chip = e.target.closest(".chip[data-cat]");
    if (!chip) return;
    state.activeCategory = chip.dataset.cat;
    setCategoryPanel(false);
    renderCategoryChips();
    renderCatalog(filterCatalog());
    window.scrollTo(0, 0);
  };
  el("#categoryChips").addEventListener("click", pick);
  el("#categoryPanel").addEventListener("click", pick);
  el("#categoryExpand").addEventListener("click", () => setCategoryPanel(el("#categoryPanel").hidden));
  renderCategoryChips();
}

function categoryNames(m) {
  const ids = m.categories || [];
  return visibleCategories().filter((c) => ids.includes(c.id)).map((c) => c.name);
}

// ---------- ค้นหา ----------
function coverTileHtml(m) {
  return `
    <div class="cover-tile" data-id="${escapeHtml(m.id)}">
      <img src="${proxied(m.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
      <div class="cover-tile-name">${escapeHtml(m.name)}</div>
    </div>`;
}

function searchMatches(q) {
  const needle = q.toLowerCase();
  return catalogVisible().filter(
    (m) => m.name.toLowerCase().includes(needle) || categoryNames(m).some((n) => n.toLowerCase().includes(needle))
  );
}

function renderSearch() {
  const q = el("#searchInput").value.trim();
  el("#searchHome").hidden = Boolean(q);
  el("#searchResults").hidden = !q;
  if (q) {
    const items = sortCatalog(searchMatches(q));
    const videos = renderSearchVideos(q);
    el("#searchCount").textContent = items.length
      ? `พบ ${items.length} เรื่อง`
      : videos ? `ไม่พบมังงะที่ตรงกับ "${q}"` : `ไม่พบเรื่องหรือคลิปที่ตรงกับ "${q}"`;
    el("#searchGrid").innerHTML = items.map(catalogCardHtml).join("");
    return;
  }
  // เรื่องที่มีคนติดตามเยอะสุด (ยังไม่มีใครติดตามเลยก็ใช้เรื่องที่อัปเดตล่าสุดแทน จะได้ไม่เป็นแถวว่าง)
  const updatedKey = (m) => m.latest_chapter_date || m.last_updated_at || "";
  const recent = [...catalogVisible()].sort((a, b) => updatedKey(b).localeCompare(updatedKey(a)));
  const popular = [...catalogVisible()].filter((m) => m.followers > 0).sort((a, b) => b.followers - a.followers || updatedKey(b).localeCompare(updatedKey(a)));
  el("#popularRow").innerHTML = (popular.length ? popular : recent).slice(0, 12).map(coverTileHtml).join("");
  el("#recentRow").innerHTML = recent.slice(0, 12).map(coverTileHtml).join("");
}

// คลิป MeeMovie ที่ชื่อตรงกับคำค้น — ใช้การ์ด/ปุ่มบันทึกชุดเดียวกับหน้าวิดีโอ คืนจำนวนที่เจอ
function renderSearchVideos(q) {
  const needle = q.toLowerCase();
  // ตอนของ playlist รวมเป็นการ์ดเรื่องเดียว (ค้น "ep" เดิมได้การ์ดตอนเป็นพันใบ)
  const hitPlaylists = new Set();
  const videos = state.videos.filter((v) => {
    if (!v.title.toLowerCase().includes(needle)) return false;
    if (v.playlist_id) hitPlaylists.add(v.playlist_id);
    return !v.playlist_id;
  });
  const playlists = (state.videoPlaylists || []).filter((p) => hitPlaylists.has(p.id) || p.name.toLowerCase().includes(needle));
  const total = videos.length + playlists.length;
  el("#searchVideoTitle").hidden = !total;
  el("#searchVideoTitle").textContent = `🎬 วิดีโอ (${playlists.length ? `${playlists.length} เรื่อง · ` : ""}${videos.length} คลิป)`;
  el("#searchVideoGrid").innerHTML = playlists.map(playlistCardHtml).join("") + videos.map(videoCardHtml).join("");
  return total;
}

function initSearch() {
  el("#searchInput").addEventListener("input", debounce(renderSearch, 120));
  // กด "ค้นหา" บนแป้นมือถือ = ปิดแป้น ให้เห็นผลเต็มจอ
  el("#searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
}

// ---------- แท็บย่อยในหน้าตั้งค่า (จัดการเรื่อง / จัดการสมาชิก) ----------
// ---------- ค้นหาในหน้าจัดการ (แอดมิน) ----------
// กรองแถวของทุกรายการในหน้าจัดการพร้อมกัน + ตัวเลขผลบนแท็บย่อย; รายการถูกวาดใหม่ (โหลด/แก้) ก็กรองซ้ำเอง
const ADMIN_SEARCH_ROWS = ["#settingsList", "#categoryList", "#userList", "#watchSourceList", "#playlistManageList", "#videoManageList", "#commentManageList"]
  .map((id) => `${id} > li`).join(", ");
let adminSearchLoaded = false;

function adminRowText(row) {
  const values = [...row.querySelectorAll("input:not([type=checkbox]), textarea")].map((i) => i.value);
  const selected = [...row.querySelectorAll("select")].map((s) => s.selectedOptions[0]?.textContent || "");
  return [row.textContent, ...values, ...selected].join(" ").toLowerCase();
}

function applyAdminSearch(jump = false) {
  const words = el("#adminSearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const counts = {};
  const searchable = new Set(["mangaManage", "categoryManage", "userManage", "videoManage", "commentManage"]);
  els(ADMIN_SEARCH_ROWS).forEach((row) => {
    const text = words.length ? adminRowText(row) : "";
    const hit = words.every((w) => text.includes(w));
    row.classList.toggle("search-miss", !hit);
    const sub = row.closest(".subview")?.id.replace(/Subview$/, "");
    if (hit && words.length) counts[sub] = (counts[sub] || 0) + 1;
  });
  els(".sub-tab-btn").forEach((btn) => {
    let badge = btn.querySelector(".sub-tab-count");
    const label = words.length && searchable.has(btn.dataset.subtab) ? ` ${counts[btn.dataset.subtab] || 0}` : "";
    if (!badge && label) btn.appendChild(badge = Object.assign(document.createElement("span"), { className: "sub-tab-count" }));
    if (badge && badge.textContent !== label) badge.textContent = label;
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  el(".admin-only").classList.toggle("searching", words.length > 0); // ซ่อนฟอร์ม/ปุ่ม ให้ผลอยู่บนสุด
  const msg = el("#adminSearchMsg");
  const text = words.length ? (total ? `พบ ${total} รายการ` : "ไม่พบ") : "";
  if (msg.textContent !== text) msg.textContent = text;
  msg.hidden = !words.length;
  // แท็บที่เปิดอยู่ไม่มีผล แต่แท็บอื่นมี → พาไปแท็บนั้น (เฉพาะตอนพิมพ์ ไม่กระโดดตอนรายการวาดใหม่)
  const active = el(".sub-tab-btn.active")?.dataset.subtab;
  if (jump && words.length && !counts[active]) {
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) el(`.sub-tab-btn[data-subtab="${best[0]}"]`).click();
  }
}

function initAdminSearch() {
  const box = el("#adminSearch");
  box.addEventListener("input", () => {
    if (!adminSearchLoaded) {
      // รายการคลิป/คอมเมนต์ปกติโหลดตอนกดแท็บ — ค้นหาครั้งแรกโหลดให้ครบทุกแท็บ
      adminSearchLoaded = true;
      Promise.all([
        loadVideos().then(() => { renderVideoManage(); return loadPlaylistWatch(); }),
        loadCommentManage(),
      ]).finally(() => applyAdminSearch(true)); // โหลดเสร็จแล้วค่อยพาไปแท็บที่มีผล
    }
    applyAdminSearch(true);
  });
  let pending = null;
  new MutationObserver(() => {
    if (!box.value.trim() || pending) return;
    pending = setTimeout(() => { pending = null; applyAdminSearch(); }, 50);
  }).observe(el(".admin-only"), { childList: true, subtree: true });
}

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
      ${m.is_new ? '<span class="new-badge">NEW EP</span>' : ""}
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
  empty.hidden = state.manga.length > 0 || state.homeMode !== "grid";

  const signature = JSON.stringify([
    Math.floor(Date.now() / 600000), // "x ชั่วโมงที่แล้ว" ต้องขยับเองแม้ข้อมูลไม่เปลี่ยน
    ...state.manga.map((m) => [m.id, m.is_new, m.latest_chapter, m.cover_url, m.last_updated_at])]
  );
  if (signature === lastGridSignature) return;
  lastGridSignature = signature;

  grid.innerHTML = state.manga
    // เวลาที่ตอนล่าสุดออก (last_updated_at เปลี่ยนเฉพาะตอนเจอตอนใหม่จริง) — เวลาเช็คดูได้ในหน้าแอดมิน
    .map((m) => cardHtml(m, `<div class="manga-chapter">${m.last_updated_at ? timeAgo(m.last_updated_at, "เมื่อสักครู่") : "&nbsp;"}</div>`))
    .join("");
}

// ใช้ event delegation ตัวเดียวต่อกริด แทนการผูก listener ทีละใบ (เร็วกว่าและไม่ค้างหลังวาดใหม่)
function initGridClicks() {
  el("#mangaGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".manga-card");
    if (card) openChapterList(mangaById(card.dataset.id));
  });

  const onCatalogClick = (e) => {
    const card = e.target.closest(".manga-card, .cover-tile");
    if (!card) return;
    const manga = state.catalog.find((m) => m.id === card.dataset.id);
    if (!manga) return;
    if (e.target.closest('[data-action="toggle-follow"]')) {
      e.stopPropagation();
      toggleSubscribe(manga);
      return;
    }
    openChapterList(manga);
  };
  ["#catalogGrid", "#searchGrid", "#popularRow", "#recentRow"].forEach((sel) => el(sel).addEventListener("click", onCatalogClick));
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
    loadCatalog().then(renderSettings); // ตอนล่าสุดในรายการจัดการเรื่องเปลี่ยนตาม
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
function catalogCardHtml(m) {
  return cardHtml(
    m,
    `<button class="follow-btn${m.is_subscribed ? " subscribed" : ""}" data-action="toggle-follow">
       ${m.is_subscribed ? "✓ ติดตามอยู่" : "+ ติดตาม"}
     </button>`
  );
}

function renderCatalog(items = state.catalog) {
  const grid = el("#catalogGrid");
  const empty = el("#catalogEmpty");
  empty.hidden = items.length > 0;
  empty.textContent =
    state.catalogMode === "category"
      ? state.categories.length ? "หมวดนี้ยังไม่มีเรื่อง" : "ยังไม่มีหมวดหมู่"
      : "ยังไม่มีเรื่องในระบบเลย";

  const signature = JSON.stringify(items.map((m) => [m.id, m.is_subscribed, m.latest_chapter, m.cover_url]));
  if (signature === lastCatalogSignature) return;
  lastCatalogSignature = signature;
  grid.innerHTML = items.map(catalogCardHtml).join("");
}

// สลับสถานะในจอทันที ไม่รอเซิร์ฟเวอร์ตอบ (ถ้าพลาดค่อยสลับกลับ) — กดแล้วรู้สึกตอบสนองทันที
async function toggleSubscribe(manga) {
  const wasSubscribed = manga.is_subscribed;
  manga.is_subscribed = !wasSubscribed;
  renderCatalog(filterCatalog());
  if (state.tab === "search") renderSearch();

  try {
    const action = wasSubscribed ? "unsubscribe" : "subscribe";
    const res = await fetch(`/api/catalog/${manga.id}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error("failed");
    loadManga(); // อัปเดตหน้าแรกด้วยเงียบ ๆ
  } catch (e) {
    manga.is_subscribed = wasSubscribed;
    renderCatalog(filterCatalog());
    if (state.tab === "search") renderSearch();
  }
}

function filterCatalog() {
  if (state.catalogMode !== "category") return sortCatalog(catalogVisible());
  const cat = state.activeCategory;
  return sortCatalog(cat ? catalogVisible().filter((m) => (m.categories || []).includes(cat)) : []);
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
  const sortSelect = el("#catalogSort");
  // ลำดับที่เลือกไว้เก็บฝั่งเซิร์ฟเวอร์แยกบัญชีใครบัญชีมัน (ไม่ใช่ localStorage) ผู้ใช้แต่ละคน
  // ตั้งค่าของตัวเองได้อิสระ ไม่ปนกัน — ค่ามาพร้อมหน้าเว็บแล้ว (BOOT.prefs) ไม่ต้องยิง API เพิ่ม
  if (state.prefs.catalog_sort) sortSelect.value = state.prefs.catalog_sort;

  sortSelect.addEventListener("change", () => {
    renderCatalog(filterCatalog());
    if (state.tab === "search") renderSearch();
    fetch("/api/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog_sort: sortSelect.value }),
    });
  });
}

// ---------- จัดการหมวดหมู่ (admin) ----------
// แต่ละแถว: ชื่อ + จำนวนเรื่อง, ปุ่ม ↑ ↓ (จัดลำดับ) / แก้ชื่อ / ลบ และ "เลือกเรื่อง" กางรายการเรื่องให้ติ๊ก
// ทุกการแก้บันทึกทันที ไม่มีปุ่มบันทึกรวม — แก้ทีละหมวดบนมือถือง่ายกว่า
const ICON_UP = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let openCategoryId = null; // หมวดที่กำลังกางรายการเรื่องอยู่
let editCategoryId = null; // หมวดที่กำลังแก้ชื่อ/ตั้งค่าพิเศษอยู่

async function sendJSON(method, url, body) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "บันทึกไม่สำเร็จ");
  return data;
}

function categoryMsg(text, isError = false) {
  const msg = el("#categoryMsg");
  msg.className = "form-msg" + (text ? (isError ? " error" : " success") : "");
  msg.textContent = text;
}

// เปลี่ยนหมวดหมู่แล้วต้องอัปเดตทุกที่ที่แสดง (แถบหมวดในหน้าทั้งหมด, หน้าค้นหา, รายการนี้เอง)
async function reloadCategories() {
  [state.categories] = await Promise.all([getJSON("/api/categories"), loadCatalog()]);
  renderCategoryChips();
  renderCategoryAdmin();
  renderPrefs();
  lastCatalogSignature = null;
  renderCatalog(filterCatalog());
}

function renderCategoryAdmin() {
  const list = el("#categoryList");
  if (!state.categories.length) {
    list.innerHTML = '<li class="empty-state small">ยังไม่มีหมวดหมู่</li>';
    return;
  }
  const count = (id) => state.catalog.filter((m) => (m.categories || []).includes(id)).length;
  const last = state.categories.length - 1;
  list.innerHTML = state.categories
    .map((c, i) => {
      const open = c.id === openCategoryId;
      const members = new Set(state.catalog.filter((m) => (m.categories || []).includes(c.id)).map((m) => m.id));
      const picker = open
        ? `<div class="category-members">
             ${[...state.catalog]
               .sort((a, b) => a.name.localeCompare(b.name, "th"))
               .map(
                 (m) => `<label class="member-row"><input type="checkbox" value="${escapeHtml(m.id)}"${members.has(m.id) ? " checked" : ""} />
                   <img src="${proxied(m.cover_url, THUMB_WIDTH)}" alt="" loading="lazy" onerror="this.style.opacity=0" /><span>${escapeHtml(m.name)}</span></label>`
               )
               .join("")}
             <div class="modal-actions"><button class="btn" data-action="close-members">ยกเลิก</button><button class="btn primary" data-action="save-members">บันทึก</button></div>
           </div>`
        : "";
      if (c.id === editCategoryId) {
        return `
        <li class="category-item open" data-id="${escapeHtml(c.id)}">
          <form class="settings-row category-edit">
            <input type="text" name="name" value="${escapeHtml(c.name)}" maxlength="40" required />
            <label class="checkbox-label"><input type="checkbox" name="special"${c.special ? " checked" : ""} /> หมวดพิเศษ</label>
            <div class="category-edit-actions">
              <button type="button" class="btn small" data-action="cancel-edit">ยกเลิก</button>
              <button type="submit" class="btn small primary">บันทึก</button>
            </div>
          </form>
        </li>`;
      }
      return `
        <li class="category-item${open ? " open" : ""}" data-id="${escapeHtml(c.id)}">
          <div class="settings-row">
            <div class="grow">
              <div class="name">${escapeHtml(c.name)}${c.special ? ' <span class="badge-special">พิเศษ</span>' : ""}</div>
              <div class="meta">${count(c.id)} เรื่อง</div>
            </div>
            <button class="btn small" data-action="members">${open ? "ปิด" : "เลือกเรื่อง"}</button>
            <button class="icon-btn" data-action="up" title="เลื่อนขึ้น"${i === 0 ? " disabled" : ""}>${ICON_UP}</button>
            <button class="icon-btn" data-action="down" title="เลื่อนลง"${i === last ? " disabled" : ""}>${ICON_DOWN}</button>
            <button class="icon-btn" data-action="edit" title="แก้ไข">${ICON_EDIT}</button>
            <button class="icon-btn danger" data-action="delete" title="ลบ">${ICON_DELETE}</button>
          </div>
          ${picker}
        </li>`;
    })
    .join("");
}

function initCategoryAdmin() {
  // บันทึกฟอร์มแก้ไขหมวด (ชื่อ + หมวดพิเศษ)
  el("#categoryList").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.closest(".category-item").dataset.id;
    const name = form.elements.name.value;
    const special = form.elements.special.checked;
    try {
      await sendJSON("PUT", `/api/categories/${id}`, { name, special });
      editCategoryId = null;
      categoryMsg(`บันทึกหมวด "${name.trim()}" แล้ว${special ? " (หมวดพิเศษ)" : ""}`);
      await reloadCategories();
    } catch (err) {
      categoryMsg(err.message, true);
    }
  });

  el("#addCategoryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = el("#newCategoryName");
    try {
      const special = el("#newCategorySpecial").checked;
      await sendJSON("POST", "/api/categories", { name: input.value, special });
      categoryMsg(`เพิ่มหมวด${special ? "พิเศษ" : ""} "${input.value.trim()}" แล้ว`);
      input.value = "";
      el("#newCategorySpecial").checked = false;
      await reloadCategories();
    } catch (err) {
      categoryMsg(err.message, true);
    }
  });

  el("#categoryList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const item = btn.closest(".category-item");
    const id = item.dataset.id;
    const cat = state.categories.find((c) => c.id === id);
    const action = btn.dataset.action;
    try {
      if (action === "members" || action === "close-members") {
        openCategoryId = action === "members" && openCategoryId !== id ? id : null;
        renderCategoryAdmin();
        return;
      }
      if (action === "save-members") {
        const ids = [...item.querySelectorAll(".category-members input:checked")].map((i) => i.value);
        await sendJSON("PUT", `/api/categories/${id}/manga`, { manga_ids: ids });
        openCategoryId = null;
        categoryMsg(`บันทึกเรื่องในหมวด "${cat.name}" แล้ว (${ids.length} เรื่อง)`);
      } else if (action === "up" || action === "down") {
        const ids = state.categories.map((c) => c.id);
        const i = ids.indexOf(id);
        const j = action === "up" ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await sendJSON("PUT", "/api/categories/order", { ids });
        categoryMsg("");
      } else if (action === "edit" || action === "cancel-edit") {
        editCategoryId = action === "edit" ? id : null;
        openCategoryId = null;
        renderCategoryAdmin();
        if (editCategoryId) el(`.category-item[data-id="${CSS.escape(id)}"] input[name="name"]`).focus();
        return;
      } else if (action === "delete") {
        if (!confirm(`ลบหมวด "${cat.name}"? (เรื่องในหมวดนี้ไม่ถูกลบ แค่ไม่อยู่ในหมวดนี้แล้ว)`)) return;
        await sendJSON("DELETE", `/api/categories/${id}`);
        categoryMsg(`ลบหมวด "${cat.name}" แล้ว`);
      }
      await reloadCategories();
    } catch (err) {
      categoryMsg(err.message, true);
    }
  });
}

// ---------- จัดการสมาชิก (admin เท่านั้น) ----------
async function renderUserList() {
  const list = el("#userList");
  try {
    const users = await getJSON("/api/users");
    list.innerHTML = users
      .map(
        (u) => `
        <li class="settings-row" data-user="${escapeHtml(u.username)}">
          <div class="grow">
            <div class="name">${escapeHtml(u.username)}${u.is_admin ? " (admin)" : ""}</div>
            <div class="meta">${escapeHtml(u.email || "ไม่มีอีเมล")}${u.must_change_password ? " · รอเปลี่ยนรหัสผ่าน" : ""}</div>
          </div>
          <button class="btn small" data-action="reset-password">รีเซ็ตรหัสผ่าน</button>
        </li>`
      )
      .join("");
  } catch (e) {
    // เงียบไว้ ไม่ใช่ประเด็นสำคัญถ้าโหลดรายชื่อสมาชิกไม่ได้ (หรือไม่ใช่ admin)
  }
}

async function loadSiteSettings() {
  try {
    el("#registrationToggle").checked = (await getJSON("/api/site_settings")).registration_open;
  } catch (e) {
    // ไม่ใช่ admin
  }
}

function initUserAdmin() {
  el("#registrationToggle").addEventListener("change", async (e) => {
    const msg = el("#addUserMsg");
    try {
      const res = await sendJSON("PUT", "/api/site_settings", { registration_open: e.target.checked });
      e.target.checked = res.registration_open;
      msg.className = "form-msg success";
      msg.textContent = res.registration_open ? "เปิดรับสมัครสมาชิกแล้ว" : "ปิดรับสมัครสมาชิกแล้ว";
    } catch (err) {
      e.target.checked = !e.target.checked;
      msg.className = "form-msg error";
      msg.textContent = err.message;
    }
  });

  el("#userList").addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-action="reset-password"]');
    if (!btn) return;
    const username = btn.closest("[data-user]").dataset.user;
    if (!confirm(`รีเซ็ตรหัสผ่านของ "${username}" เป็น 00000000?\n\nทุกเครื่องของสมาชิกคนนี้จะต้อง login ใหม่ด้วยรหัส 00000000 แล้วไปเปลี่ยนรหัสเองที่หน้าตั้งค่า`)) return;
    const msg = el("#addUserMsg");
    try {
      await sendJSON("POST", `/api/users/${encodeURIComponent(username)}/reset_password`);
      msg.className = "form-msg success";
      msg.textContent = `รีเซ็ตรหัสผ่านของ "${username}" เป็น 00000000 แล้ว`;
      renderUserList();
    } catch (err) {
      msg.className = "form-msg error";
      msg.textContent = err.message;
    }
  });
}

// ---------- เปลี่ยนรหัสผ่าน (ทุกคน) ----------
function initPasswordForm() {
  const mustChange = Boolean(state.currentUser.must_change_password);
  el("#pwNotice").hidden = !mustChange;
  if (mustChange) el("#passwordCard").open = true;

  el("#passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const msg = el("#passwordMsg");
    const body = { old: form.elements.old.value, new: form.elements.new.value, confirm: form.elements.confirm.value };
    if (body.new !== body.confirm) {
      msg.className = "form-msg error";
      msg.textContent = "ยืนยันรหัสผ่านใหม่ไม่ตรงกัน";
      return;
    }
    try {
      await sendJSON("POST", "/api/account/password", body);
      form.reset();
      msg.className = "form-msg success";
      msg.textContent = "เปลี่ยนรหัสผ่านแล้ว เครื่องอื่นที่ login ค้างไว้จะต้อง login ใหม่ด้วยรหัสใหม่";
      state.currentUser.must_change_password = false;
      el("#pwNotice").hidden = true;
      el("#homePwNotice").hidden = true;
    } catch (err) {
      msg.className = "form-msg error";
      msg.textContent = err.message;
    }
  });

  // เตือนที่หน้าแรกด้วย (ผู้ใช้ที่ถูกรีเซ็ตรหัสมักไม่ได้เข้าหน้าตั้งค่าเอง)
  el("#homePwNotice").hidden = !mustChange;
  el("#homePwNotice").addEventListener("click", () => showTab("settings"));
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
let editingOriginal = null; // ชื่อ/แหล่งที่มาเดิม — เปลี่ยนแค่หมวดหมู่ไม่ต้องส่งแก้ไขเรื่อง (ซึ่งต้องดึงเว็บใหม่ ช้า)

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
  editingOriginal = manga ? { name: manga.name, sources: urls.join("\n") } : null;
  const selected = new Set((manga && manga.categories) || []);
  el("#mangaFormCategoriesWrap").hidden = state.categories.length === 0;
  el("#mangaFormCategories").innerHTML = state.categories
    .map(
      (c) =>
        `<label class="chip-check"><input type="checkbox" value="${escapeHtml(c.id)}"${selected.has(c.id) ? " checked" : ""} /><span>${escapeHtml(c.name)}</span></label>`
    )
    .join("");
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

    const categoryIds = els("#mangaFormCategories input:checked").map((i) => i.value);
    const unchanged = editingOriginal && editingOriginal.name === name && editingOriginal.sources === sources.join("\n");

    try {
      let mangaId = editingMangaId;
      if (!unchanged) {
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
        mangaId = data.id || mangaId;
      }
      if (mangaId && state.categories.length) {
        await fetch(`/api/manga/${mangaId}/categories`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category_ids: categoryIds }),
        });
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
  readerFromHistory = false;
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
  if (state.homeMode === "history") loadHistory();
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
    img.dataset.src = src;
    img.decoding = "async";
    // 2 รูปแรกคือสิ่งที่ผู้ใช้เห็นทันทีที่เปิดตอน ให้ browser จัดคิวโหลดก่อนรูปที่เหลือ
    if (i < 2) img.fetchPriority = "high";
    img.addEventListener("error", retryChapterFromOtherSource, { once: true });
    frag.appendChild(img);
  });
  // แทรกก่อนข้อความ "เลื่อนต่อเพื่อไปตอนถัดไป" (ถ้ามี) ให้อยู่ท้ายสุดเสมอ
  body.insertBefore(frag, el("#nextHint"));
}

// รูปของตอนนี้โหลดไม่ขึ้น = เซิร์ฟเวอร์รูปของแหล่งนี้อาจล่มอยู่ ขอรายการรูปใหม่ 1 ครั้ง ตอนนี้เซิร์ฟเวอร์เรา
// รู้แล้วว่าเจ้านั้นล่ม (จำไว้ตอนพร็อกซีรูปพลาด) จะส่งรูปจากแหล่งสำรองที่ยังดีมาให้แทน ถ้าได้ชุดเดิมกลับมา
// แปลว่าไม่มีแหล่งอื่นให้สลับ ก็ปล่อยไว้แบบนั้น (ลองครั้งเดียวต่อตอน กันวนขอซ้ำไม่จบ)
let sourceRetryDone = false;

async function retryChapterFromOtherSource() {
  if (sourceRetryDone || !readerMangaId || !currentChapterData.url) return;
  sourceRetryDone = true;
  const mangaId = readerMangaId;
  const url = currentChapterData.url;
  try {
    const data = await getJSON(`/api/manga/${mangaId}/chapter?url=${encodeURIComponent(url)}&peek=1`);
    if (currentChapterData.url !== url || !(data.images || []).length) return; // ผู้ใช้เปลี่ยนตอนไปแล้ว
    const body = el("#readerBody");
    const oldImgs = [...body.querySelectorAll("img")];
    if (oldImgs[0] && oldImgs[0].dataset.src === data.images[0]) return;
    oldImgs.forEach((img) => img.remove());
    appendChapterImages(data.images);
    if (restoreTarget !== null) restoreScrollPosition(restoreTarget);
  } catch (e) {
    // ไม่มีทางเลือกอื่น ปล่อยตามเดิม
  }
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
  sourceRetryDone = false;
  if (data.next_url) {
    const hint = document.createElement("div");
    hint.className = "next-hint";
    hint.id = "nextHint";
    hint.textContent = "เลื่อนต่ออีกทีเพื่อไปตอนถัดไป ›";
    body.appendChild(hint);
  }
  initNextChapterConfirm();
  refreshCommentCount({ kind: "chapter", manga_id: readerMangaId, url: currentChapterData.url }, el("#readerCommentCount"));

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
  closeComments();
  el("#reader").hidden = true;
  prefetchedChapters.clear();
  document.body.style.overflow = "";
  if (readerFromHistory) {
    readerFromHistory = false;
    currentManga = null;
    currentChapters = [];
    await saved;
    loadHistory();
    if (mangaListStale) {
      mangaListStale = false;
      loadManga();
    }
    reloadIfPending();
    return;
  }
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

// ---------- แจ้งเตือนตอนใหม่ (Web Push) ----------
// iPhone/iPad รับแจ้งเตือนเว็บได้เฉพาะตอนเปิดจากไอคอนบนหน้าจอโฮม (iOS 16.4+) เปิดใน Safari ปกติจะไม่มี
// PushManager ให้ใช้เลย — ต้องบอกวิธีแทนการเงียบไป
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// การ์ดสถานะแจ้งเตือนแบบพุชในแผงกระดิ่ง — แสดงตลอด (ไม่มีปุ่มปัดทิ้ง) บอกสถานะเครื่องนี้ + ปุ่มเปิด/ปิด
let pushOn = false;

function setPushButton(on) {
  pushOn = on;
  renderPushCard();
}

function renderPushCard() {
  const btn = el("#pushCardBtn");
  let title, desc, label = null, primary = false;
  if (!BOOT.push_key) {
    [title, desc] = ["แจ้งเตือนแบบพุชยังไม่พร้อม", "เซิร์ฟเวอร์ยังไม่ได้เปิดระบบนี้ — ยังดูแจ้งเตือนในแผงนี้ได้ตามปกติ"];
  } else if (!pushSupported && isIOS && !isStandalone) {
    [title, desc, label] = ["การแจ้งเตือนแบบพุชปิดอยู่", "iPhone ต้องเปิดเว็บจากไอคอนบนหน้าจอโฮมก่อน ถึงจะเด้งแจ้งเตือนได้", "วิธีเปิด"];
  } else if (!pushSupported) {
    [title, desc] = ["เบราว์เซอร์นี้ไม่รองรับแจ้งเตือนแบบพุช", "ลองเปิดด้วย Chrome หรือ Safari เวอร์ชันล่าสุด"];
  } else if (pushOn) {
    [title, desc, label] = ["การแจ้งเตือนแบบพุชเปิดอยู่ ✓", "เครื่องนี้จะเด้งเตือนเมื่อเรื่องที่ติดตามมีตอนใหม่ หรือมีคนตอบคอมเมนต์", "ปิด"];
  } else {
    [title, desc, label, primary] = ["การแจ้งเตือนแบบพุชปิดอยู่", "เปิดเพื่อไม่พลาดตอนใหม่และคนตอบคอมเมนต์ของคุณ", "เปิด", true];
  }
  el("#pushCard").classList.toggle("on", pushOn);
  el("#pushCardTitle").textContent = title;
  el("#pushCardDesc").textContent = desc;
  btn.hidden = !label;
  btn.textContent = label || "";
  btn.classList.toggle("primary", primary);
}

// ---------- แผงการแจ้งเตือน (กดกระดิ่ง) ----------
let notifItems = [];
let notifFilter = "all";
const NOTIF_ICON = { chapter: "📚", reply: "💬", mention: "📣", thread: "🗨️" };

function setNotifBadge(unread) {
  const badge = el("#notifBadge");
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? "99+" : String(unread);
}

async function loadNotifications() {
  if (!state.currentUser.username) return;
  try {
    const data = await getJSON("/api/notifications");
    notifItems = data.items;
    setNotifBadge(data.unread);
    if (!el("#notifPanel").hidden) renderNotifications();
  } catch (e) { /* ใช้ของเดิม */ }
}

function renderNotifications() {
  els("[data-notif-filter]").forEach((b) => b.classList.toggle("active", b.dataset.notifFilter === notifFilter));
  const items = notifFilter === "unread" ? notifItems.filter((n) => !n.read) : notifItems;
  el("#notifList").innerHTML = items.length
    ? items.map((n) => `<li class="notif-item${n.read ? "" : " unread"}" data-notif-id="${escapeHtml(n.id)}">
        <span class="notif-icon">${NOTIF_ICON[n.type] || "🔔"}</span>
        <span class="grow"><span class="notif-text">${escapeHtml(n.text)}</span><span class="notif-time">${timeAgo(n.created_at, "เมื่อสักครู่")}</span></span>
        ${n.read ? "" : '<span class="notif-dot"></span>'}</li>`).join("")
    : `<li class="notif-empty">${notifFilter === "unread" ? "อ่านครบหมดแล้ว 🎉" : "ยังไม่มีการแจ้งเตือน"}</li>`;
}

function toggleNotifPanel(show = el("#notifPanel").hidden) {
  el("#notifPanel").hidden = !show;
  el("#notifBackdrop").hidden = !show;
  if (show) {
    renderPushCard();
    renderNotifications();
    loadNotifications();
  }
}

async function markNotificationsRead(body) {
  try {
    const res = await sendJSON("POST", "/api/notifications/read", body);
    setNotifBadge(res.unread);
  } catch (e) { /* ไม่เป็นไร รอบหน้าค่อยมาร์คใหม่ */ }
}

function initNotifications() {
  el("#notifBackdrop").addEventListener("click", () => toggleNotifPanel(false));
  el("#pushCardBtn").addEventListener("click", togglePush);
  els("[data-notif-filter]").forEach((b) => b.addEventListener("click", () => { notifFilter = b.dataset.notifFilter; renderNotifications(); }));
  el("#notifReadAll").addEventListener("click", () => {
    notifItems.forEach((n) => { n.read = true; });
    renderNotifications();
    markNotificationsRead({ all: true });
  });
  el("#notifList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-notif-id]");
    const item = row && notifItems.find((n) => n.id === row.dataset.notifId);
    if (!item) return;
    if (!item.read) {
      item.read = true;
      markNotificationsRead({ ids: [item.id] });
    }
    toggleNotifPanel(false);
    openFromUrl(new URL(item.url, location.origin));
  });
  loadNotifications();
  setInterval(() => { if (!document.hidden) loadNotifications(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadNotifications(); });
}

async function pushRegistration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

// ---------- ปุ่มเพิ่มไปยังหน้าจอโฮม (ข้างกระดิ่ง) ----------
// Android/Chrome: ใช้หน้าต่างติดตั้งของเบราว์เซอร์ (beforeinstallprompt)
// iPhone: ไม่มี API ให้สั่งติดตั้ง → บอกขั้นตอนผ่านปุ่มแชร์ของ Safari; เปิดจากไอคอนอยู่แล้ว = ซ่อนปุ่ม
let installPromptEvent = null;
const isAndroid = /Android/i.test(navigator.userAgent);

function updateInstallButton() {
  el("#installBtn").hidden = isStandalone || !(isIOS || isAndroid || installPromptEvent);
}

function initInstallButton() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // เก็บไว้เปิดตอนกดปุ่มเอง ไม่ให้แถบติดตั้งเด้งขึ้นมาเอง
    installPromptEvent = event;
    updateInstallButton();
  });
  window.addEventListener("appinstalled", () => {
    installPromptEvent = null;
    el("#installBtn").hidden = true;
  });
  el("#installBtn").addEventListener("click", async () => {
    if (installPromptEvent) {
      const event = installPromptEvent;
      installPromptEvent = null; // ใช้ได้ครั้งเดียว
      event.prompt();
      const choice = await event.userChoice.catch(() => null);
      if (choice?.outcome === "accepted") el("#installBtn").hidden = true;
      return;
    }
    alert(isIOS
      ? "เพิ่ม MeeManga ไปยังหน้าจอโฮม\n\n1. กดปุ่มแชร์ (สี่เหลี่ยมมีลูกศรขึ้น) ที่แถบล่างของ Safari\n2. เลื่อนลงแล้วเลือก \"เพิ่มไปยังหน้าจอโฮม\"\n3. กด \"เพิ่ม\" มุมขวาบน\n\n(ถ้าเปิดจากแอปอื่น เช่น LINE/Facebook ให้เปิดลิงก์ใน Safari ก่อน)"
      : "เพิ่ม MeeManga ไปยังหน้าจอหลัก\n\n1. กดเมนู ⋮ มุมขวาบนของ Chrome\n2. เลือก \"เพิ่มลงในหน้าจอหลัก\" หรือ \"ติดตั้งแอป\"\n3. กด \"เพิ่ม\"");
  });
  updateInstallButton();
}

async function initPush() {
  const btn = el("#pushBtn");
  if (!state.currentUser.username) return; // ไม่ได้ login = ไม่มีแจ้งเตือนส่วนตัว
  // กระดิ่ง = เปิดแผงการแจ้งเตือน (การเปิด/ปิดแจ้งเตือนแบบพุชย้ายไปอยู่ในแผง)
  btn.hidden = false;
  btn.addEventListener("click", () => toggleNotifPanel());
  initNotifications();
  renderPushCard();
  if (!BOOT.push_key) return;

  // เปิดจากการแตะแจ้งเตือนขณะหน้าเว็บเปิดค้างอยู่
  if (pushSupported) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "open") openFromUrl(new URL(e.data.url));
    });
  }
  if (!pushSupported) return setPushButton(false);

  try {
    const reg = await pushRegistration();
    const sub = await reg.pushManager.getSubscription();
    setPushButton(Boolean(sub) && Notification.permission === "granted");
    // ส่งให้เซิร์ฟเวอร์ซ้ำทุกครั้งที่เปิดเว็บ เผื่อฝั่งเซิร์ฟเวอร์ลบไปแล้ว (ย้ายเครื่อง/เปลี่ยนบัญชี) — ปลอดภัยเพราะซ้ำก็แค่ทับของเดิม
    if (sub && Notification.permission === "granted") postJSON("/api/push/subscribe", sub.toJSON()).catch(() => {});
  } catch (e) {
    setPushButton(false);
  }
}

function postJSON(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function togglePush() {
  if (!pushSupported) {
    alert(
      isIOS && !isStandalone
        ? "iPhone/iPad รับแจ้งเตือนได้เฉพาะตอนเปิดจากไอคอนบนหน้าจอโฮม\n\n1. กดปุ่มแชร์ (สี่เหลี่ยมมีลูกศรขึ้น)\n2. เลือก \"เพิ่มไปยังหน้าจอโฮม\"\n3. เปิดเว็บจากไอคอนนั้น แล้วกดกระดิ่ง → \"เปิด\"\n\n(ต้องเป็น iOS 16.4 ขึ้นไป)"
        : "เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองเปิดด้วย Chrome หรือ Safari เวอร์ชันล่าสุด"
    );
    return;
  }
  const btn = el("#pushCardBtn");
  btn.disabled = true;
  try {
    const reg = await pushRegistration();
    const existing = await reg.pushManager.getSubscription();
    if (existing && Notification.permission === "granted") {
      if (!confirm("ปิดแจ้งเตือนตอนใหม่บนเครื่องนี้?")) return;
      await postJSON("/api/push/unsubscribe", { endpoint: existing.endpoint }).catch(() => {});
      await existing.unsubscribe();
      setPushButton(false);
      return;
    }
    // ต้องขออนุญาตจากการกดของผู้ใช้โดยตรงเท่านั้น (iOS/Chrome บล็อกถ้าขอเองตอนโหลดหน้า)
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alert(
        permission === "denied"
          ? "เครื่องนี้ถูกตั้งไม่ให้เว็บนี้แจ้งเตือน ต้องไปเปิดในตั้งค่าของเบราว์เซอร์/ตั้งค่าแจ้งเตือนของเครื่องก่อน"
          : "ยังไม่ได้อนุญาตการแจ้งเตือน"
      );
      return;
    }
    const sub =
      existing ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(BOOT.push_key) }));
    const res = await postJSON("/api/push/subscribe", sub.toJSON());
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "บันทึกไม่สำเร็จ");
    setPushButton(true);
    // ส่งแจ้งเตือนทดสอบทันที ผู้ใช้จะได้เห็นว่าใช้ได้จริง
    const test = await postJSON("/api/push/test", {}).then((r) => r.json()).catch(() => ({}));
    if (!test.sent) alert("เปิดแจ้งเตือนแล้ว แต่ส่งแจ้งเตือนทดสอบไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง");
  } catch (e) {
    alert("เปิดแจ้งเตือนไม่สำเร็จ: " + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

// เปิดเรื่องจากลิงก์ในแจ้งเตือน (/?manga=<id>) ตรงไปหน้าเลือกตอนของเรื่องนั้นเลย
// ลิงก์จากแจ้งเตือนคอมเมนต์: /?comments=video&id=… หรือ /?comments=chapter&manga_id=…&url=…
async function openCommentsFromUrl(params) {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  if (params.get("comments") === "video") {
    if (!state.videos.length) await loadVideos();
    const video = state.videos.find((v) => v.id === params.get("id"));
    if (!video) return;
    openVideo(video);
    el("#videoCommentsBtn").click();
    return;
  }
  const mangaId = params.get("manga_id");
  const chapterUrl = params.get("url");
  if (!mangaId || !chapterUrl) return;
  let manga = mangaById(mangaId);
  if (!manga) { await loadCatalog(); manga = (state.catalog || []).find((m) => m.id === mangaId); }
  if (!manga) return;
  resumeReading({ id: manga.id, name: manga.name, latest_chapter_url: manga.latest_chapter_url, chapter_url: chapterUrl });
  // รอตอนโหลดเสร็จก่อน ปุ่ม 💬 ถึงจะรู้ว่าเป็นตอนไหน
  for (let i = 0; i < 40 && currentChapterData?.url !== chapterUrl; i++) await w(250);
  el("#readerComments").click();
}

function openFromUrl(url) {
  if (url.searchParams.get("comments")) {
    history.replaceState(null, "", "/");
    openCommentsFromUrl(url.searchParams);
    return;
  }
  const id = url.searchParams.get("manga");
  if (!id) return;
  history.replaceState(null, "", "/");
  el("#reader").hidden = true;
  const manga = mangaById(id);
  if (manga) openChapterList(manga);
  else loadManga().then(() => mangaById(id) && openChapterList(mangaById(id)));
}

// ---------- คอมเมนต์ (หน้าต่างเดียวใช้ทั้งตอนมังงะและคลิป) ----------
let commentTarget = null; // {kind:"chapter", manga_id, url} | {kind:"video", id}
let commentCountEl = null;
let commentReplyTo = null; // id คอมเมนต์ที่กด "ตอบ" — เจ้าของจะได้แจ้งเตือน

function commentQuery(target) {
  return new URLSearchParams(target).toString();
}

function commentItemHtml(c, withLabel = false) {
  return `<li class="comment-item" data-comment-id="${escapeHtml(c.id)}">
    <div class="comment-meta"><b>${escapeHtml(c.user)}</b> · ${timeAgo(c.created_at, "เมื่อสักครู่")}${withLabel ? "" : ` · <button class="link-btn" data-reply-comment data-user="${escapeHtml(c.user)}">ตอบ</button>`}${c.can_delete ? ' · <button class="link-btn" data-delete-comment>ลบ</button>' : ""}</div>
    ${withLabel ? `<div class="comment-label">${escapeHtml(c.label || "")}</div>` : ""}
    <div class="comment-text">${escapeHtml(c.text)}</div>
  </li>`;
}

function setCommentCount(countEl, n) {
  if (countEl) countEl.textContent = n ? String(n) : "";
}

// ตัวเลขบนปุ่ม 💬 — โหลดเงียบ ๆ ตอนเปิดตอน/คลิป ไม่ขวางการอ่าน
async function refreshCommentCount(target, countEl) {
  setCommentCount(countEl, 0);
  try {
    const data = await getJSON(`/api/comments?${commentQuery(target)}`);
    setCommentCount(countEl, data.items.length);
  } catch (e) { /* ไม่มีตัวเลขก็ได้ */ }
}

async function openComments(target, title, countEl) {
  commentTarget = target;
  commentCountEl = countEl;
  el("#commentSheetTitle").textContent = title;
  el("#commentList").innerHTML = '<li class="comment-empty">กำลังโหลด...</li>';
  el("#commentSheet").hidden = false;
  try {
    const data = await getJSON(`/api/comments?${commentQuery(target)}`);
    renderCommentList(data.items);
  } catch (e) {
    el("#commentList").innerHTML = `<li class="comment-empty">${escapeHtml(e.body?.error || "โหลดคอมเมนต์ไม่สำเร็จ")}</li>`;
  }
}

function renderCommentList(items) {
  el("#commentList").innerHTML = items.length
    ? items.map((c) => commentItemHtml(c)).join("")
    : '<li class="comment-empty">ยังไม่มีความคิดเห็น เริ่มคุยคนแรกเลย</li>';
  setCommentCount(commentCountEl, items.length);
  const list = el("#commentList");
  list.scrollTop = list.scrollHeight;
}

function closeComments() {
  el("#commentSheet").hidden = true;
  commentTarget = null;
  commentReplyTo = null;
}

async function deleteCommentById(id) {
  if (!confirm("ลบความคิดเห็นนี้?")) return false;
  try { await sendJSON("DELETE", `/api/comments/${encodeURIComponent(id)}`); return true; }
  catch (e) { alert(e.message || "ลบไม่สำเร็จ"); return false; }
}

function initComments() {
  els("[data-close-comments]").forEach((b) => b.addEventListener("click", closeComments));
  el("#commentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = el("#commentInput");
    const text = input.value.trim();
    if (!text || !commentTarget) return;
    const btn = event.currentTarget.querySelector("button");
    btn.disabled = true;
    try {
      await sendJSON("POST", "/api/comments", { ...commentTarget, text, reply_to: commentReplyTo });
      input.value = "";
      commentReplyTo = null;
      const data = await getJSON(`/api/comments?${commentQuery(commentTarget)}`);
      renderCommentList(data.items);
    } catch (e) { alert(e.message || "ส่งไม่สำเร็จ"); }
    finally { btn.disabled = false; }
  });
  el("#commentList").addEventListener("click", async (event) => {
    const reply = event.target.closest("[data-reply-comment]");
    if (reply) {
      commentReplyTo = reply.closest("[data-comment-id]").dataset.commentId;
      const input = el("#commentInput");
      input.value = `@${reply.dataset.user} `;
      input.focus();
      return;
    }
    const btn = event.target.closest("[data-delete-comment]");
    if (!btn) return;
    const id = btn.closest("[data-comment-id]").dataset.commentId;
    if (!(await deleteCommentById(id)) || !commentTarget) return;
    const data = await getJSON(`/api/comments?${commentQuery(commentTarget)}`);
    renderCommentList(data.items);
  });
  el("#readerComments").addEventListener("click", () => {
    if (!readerMangaId || !currentChapterData?.url) return;
    openComments({ kind: "chapter", manga_id: readerMangaId, url: currentChapterData.url },
      `💬 ${el("#readerChapterName").textContent || "ตอนนี้"}`, el("#readerCommentCount"));
  });
  el("#videoCommentsBtn").addEventListener("click", () => {
    if (!activeVideo) return;
    openComments({ kind: "video", id: activeVideo.id }, `💬 ${activeVideo.title}`, el("#videoCommentCount"));
  });
}

// ---------- หน้าหลัก: แถว "ดูต่อ / อ่านต่อ" (มังงะที่อ่านล่าสุด + คลิปที่ดูค้าง เรียงตามเวลาล่าสุด) ----------
function continueItems() {
  const manga = withoutSpecial(state.history).filter((h) => h.chapter_url)
    .map((h) => ({ kind: "manga", at: h.last_read_at || "", item: h }));
  const videos = state.videos.filter((v) => !v.external && Number(v.position_seconds) > 0)
    .map((v) => ({ kind: "video", at: v.watched_at || "", item: v }));
  return manga.concat(videos).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
}

function continueTileHtml({ kind, item }) {
  if (kind === "manga") {
    const pct = item.fraction ? ` · ${Math.round(item.fraction * 100)}%` : "";
    return `<button class="continue-tile manga" data-kind="manga" data-id="${escapeHtml(item.id)}">
      <img src="${proxied(item.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
      <span class="continue-name">${escapeHtml(item.name)}</span>
      <span class="continue-meta">📚 ${escapeHtml(item.chapter_text || "")}${pct}</span></button>`;
  }
  const pos = Number(item.position_seconds) || 0;
  const dur = Number(item.duration_seconds) || 0;
  const pct = dur ? Math.min(100, Math.max(3, (pos / dur) * 100)) : 0;
  const at = `${Math.floor(pos / 60)}.${String(Math.floor(pos % 60)).padStart(2, "0")}`;
  const image = item.thumbnail_url ? `<img src="${escapeHtml(item.thumbnail_url)}" alt="" loading="lazy" />` : '<span class="video-placeholder">▶</span>';
  return `<button class="continue-tile video" data-kind="video" data-id="${escapeHtml(item.id)}">
    <span class="continue-media">${image}<span class="video-time">${at}${dur ? `/${Math.max(1, Math.round(dur / 60))}` : ""} นาที</span>${pct ? `<span class="video-progress"><span style="width:${pct.toFixed(1)}%"></span></span>` : ""}</span>
    <span class="continue-name">${escapeHtml(item.title)}</span>
    <span class="continue-meta">🎬 ดูค้างไว้${dur ? ` ${Math.round((pos / dur) * 100)}%` : ""}</span></button>`;
}

function renderContinue() {
  const items = continueItems();
  el("#continueSection").hidden = !items.length || state.homeMode !== "grid";
  el("#continueRow").innerHTML = items.map(continueTileHtml).join("");
}

function initContinue() {
  el("#continueRow").addEventListener("click", (event) => {
    const tile = event.target.closest(".continue-tile");
    if (!tile) return;
    if (tile.dataset.kind === "manga") {
      const item = state.history.find((h) => h.id === tile.dataset.id);
      if (item) resumeReading(item);
    } else {
      const video = state.videos.find((v) => v.id === tile.dataset.id);
      if (video) openVideo(video);
    }
  });
  loadHistory();
  loadVideos();
}

// ---------- หมวดคลิป (แอดมินตั้ง) — ชิปกรองในแท็บหน้าหลักของ MeeMovie ----------
let videoCategoryFilter = null;

function renderVideoCategoryChips() {
  const cats = state.videoCategories || [];
  const box = el("#videoCategoryChips");
  box.hidden = videoTab === "history";
  if (videoCategoryFilter && videoCategoryFilter !== CLIPS_FILTER && !cats.some((c) => c.id === videoCategoryFilter)) videoCategoryFilter = null;
  box.innerHTML = [{ id: "", name: "ทั้งหมด" }, ...cats, { id: CLIPS_FILTER, name: "คลิปเดี่ยว" }].map((c) =>
    `<button class="video-chip${(videoCategoryFilter || "") === c.id ? " active" : ""}" data-video-category="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`).join("");
}

// ---------- หน้าแอดมิน: คลิป / คอมเมนต์ / ระบบ ----------
function fmtBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} วัน ${h} ชม.` : h ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}

function statTile(label, value) {
  return `<div class="stat-tile"><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
}

async function loadSystemStatus() {
  el("#systemStats").innerHTML = el("#systemHealth").innerHTML = '<div class="hint">กำลังโหลด...</div>';
  try {
    const [st, stats] = await Promise.all([getJSON("/api/admin/status"), getJSON("/api/admin/stats")]);
    el("#systemStats").innerHTML = [
      statTile("ผู้ใช้วันนี้", stats.today_users), statTile("อ่านวันนี้ (ตอน)", stats.today_reads), statTile("ดูคลิปวันนี้", stats.today_plays),
      statTile("ผู้ใช้ 7 วัน", stats.week_users), statTile("อ่าน 7 วัน", stats.week_reads), statTile("ดูคลิป 7 วัน", stats.week_plays),
    ].join("") + `<div class="daily-bars">${stats.daily.map((d) => {
      const max = Math.max(1, ...stats.daily.map((x) => x.users));
      return `<div class="daily-bar" title="${d.day}: ผู้ใช้ ${d.users} · อ่าน ${d.reads} · ดูคลิป ${d.plays}"><span style="height:${(d.users / max) * 100}%"></span><em>${d.day.slice(8)}</em></div>`;
    }).join("")}</div>`;
    el("#systemHealth").innerHTML = [
      statTile("เปิดมาแล้ว", fmtUptime(st.uptime_seconds)),
      statTile("ดิสก์ว่าง", `${fmtBytes(st.disk.free)} / ${fmtBytes(st.disk.total)}`),
      statTile("แคชตอน", `${fmtBytes(st.caches.chapters.bytes)} (${st.caches.chapters.files})`),
      statTile("แคชปก", fmtBytes(st.caches.covers.bytes + st.caches.video_thumbs.bytes)),
      statTile("เรื่อง / คลิป", `${st.counts.manga} / ${st.counts.videos}`),
      statTile("สมาชิก / คอมเมนต์", `${st.counts.users} / ${st.counts.comments}`),
    ].join("");
    el("#systemHosts").innerHTML = st.hosts.map((h) => `<li class="host-row">
      <span class="host-dot ${h.down ? "down" : h.stalled ? "stalled" : "ok"}"></span>
      <span class="grow"><b>${escapeHtml(h.host)}</b><br><small>${h.manga} เรื่อง · เช็คล่าสุด ${h.last_checked_at ? timeAgo(h.last_checked_at) : "-"}</small></span>
      <small>${h.down ? "ล่ม (พัก 10 นาที)" : h.stalled ? "ตอบช้า" : "ปกติ"}</small></li>`).join("");
    const top = (title, rows) => `<div class="top-list"><b>${title}</b><ol>${rows.length ? rows.map((r) => `<li>${escapeHtml(r.name)} <small>(${r.count})</small></li>`).join("") : "<li><small>ยังไม่มีข้อมูล</small></li>"}</ol></div>`;
    el("#systemTop").innerHTML = top("📚 มังงะ (ครั้งที่อ่าน)", stats.top_manga) + top("🎬 คลิป (ครั้งที่เปิด)", stats.top_videos);
    el("#systemErrors").textContent = st.has_logs ? (st.errors.join("\n") || "ไม่มีข้อผิดพลาด 🎉") : "ไม่มีไฟล์ log (ไม่ได้รันผ่าน run_windows.py)";
    el("#systemSupervisor").textContent = st.supervisor.join("\n") || "-";
  } catch (e) {
    el("#systemStats").innerHTML = `<div class="hint">${escapeHtml(e.body?.error || "โหลดสถานะไม่สำเร็จ")}</div>`;
  }
}

async function loadCommentManage() {
  try {
    const data = await getJSON("/api/admin/comments");
    el("#commentManageList").innerHTML = data.items.length ? data.items.map((c) => commentItemHtml(c, true)).join("") : '<li class="comment-empty">ยังไม่มีคอมเมนต์</li>';
  } catch (e) { el("#commentManageList").innerHTML = '<li class="comment-empty">โหลดไม่สำเร็จ</li>'; }
}

function renderVideoManage() {
  const cats = state.videoCategories || [];
  el("#videoCategoryList").innerHTML = cats.length
    ? cats.map((c) => `<span class="chip">${escapeHtml(c.name)} <button class="link-btn" data-delete-video-category="${escapeHtml(c.id)}">✕</button></span>`).join("")
    : '<span class="hint">ยังไม่มีหมวดคลิป</span>';
  const options = (selected) => [`<option value="">— ไม่มีหมวด —</option>`, ...cats.map((c) =>
    `<option value="${escapeHtml(c.id)}"${c.id === selected ? " selected" : ""}>${escapeHtml(c.name)}</option>`)].join("");
  el("#playlistManageList").innerHTML = (state.videoPlaylists || []).map((p) => `<li class="video-manage-row" data-playlist-id="${escapeHtml(p.id)}">
    ${p.thumbnail_url ? `<img src="${escapeHtml(p.thumbnail_url)}" alt="" loading="lazy" />` : '<span class="video-placeholder">▶</span>'}
    <div class="grow">
      <input class="playlist-name-input" value="${escapeHtml(p.name)}" maxlength="80" />
      <div class="video-manage-meta"><select class="playlist-category-select">${options(p.category_id)}</select><small>Playlist · ${p.count} ตอน</small>
      <button class="link-btn danger-text" data-delete-playlist>ลบทั้งเรื่อง</button></div>
    </div></li>`).join("");
  // ตอนของ playlist จัดการผ่านแถว playlist ด้านบน (หลายร้อยแถวจะทำหน้านี้หน่วง)
  el("#videoManageList").innerHTML = state.videos.filter((v) => !v.playlist_id).map((v) => `<li class="video-manage-row" data-video-id="${escapeHtml(v.id)}">
    ${v.thumbnail_url ? `<img src="${escapeHtml(v.thumbnail_url)}" alt="" loading="lazy" />` : '<span class="video-placeholder">▶</span>'}
    <div class="grow">
      <input class="video-title-input" value="${escapeHtml(v.title)}" maxlength="160" />
      <div class="video-manage-meta"><select class="video-category-select">${options(v.category_id)}</select>
      <small>${v.external ? "เปิดใน Facebook · " : ""}เพิ่มโดย ${escapeHtml(v.added_by)}</small>
      <button class="link-btn danger-text" data-admin-delete-video>ลบ</button></div>
    </div></li>`).join("");
}

// ---------- ติดตามเพจ / เพิ่มตอนจากลิงก์ ----------
let playlistWatch = { sources: [] };
let watchPollTimer = null;

async function loadPlaylistWatch() {
  try { playlistWatch = await getJSON("/api/video-playlists/watch"); } catch (e) { return; }
  renderPlaylistWatch();
  clearTimeout(watchPollTimer);
  // กำลังเช็คอยู่: ถามสถานะซ้ำจนเสร็จ แล้วโหลดคลังใหม่ (ตอนที่เพิ่งเพิ่มจะได้ขึ้น)
  if (playlistWatch.running) watchPollTimer = setTimeout(async () => {
    await loadPlaylistWatch();
    if (!playlistWatch.running) { await loadVideos(); renderVideoManage(); }
  }, 3000);
}

function renderPlaylistWatch() {
  const cats = state.videoCategories || [];
  el("#watchSourceCategory").innerHTML = ['<option value="">— ไม่มีหมวด —</option>', ...cats.map((c) =>
    `<option value="${escapeHtml(c.name)}"${c.name === "ซีรีส์จีน" ? " selected" : ""}>${escapeHtml(c.name)}</option>`)].join("");
  el("#addLinksPlaylist").innerHTML = ['<option value="">แยกเรื่องจากชื่อคลิปอัตโนมัติ</option>', ...(state.videoPlaylists || []).map((p) =>
    `<option value="${escapeHtml(p.id)}">เข้า: ${escapeHtml(p.name)}</option>`)].join("");
  const sources = playlistWatch.sources || [];
  el("#watchSourceList").innerHTML = sources.map((s, i) => `<li class="video-manage-row"><div class="grow"><div class="watch-url">${escapeHtml(s.url)}</div>
    <div class="video-manage-meta"><small>หมวด: ${escapeHtml(s.category || "—")}</small><button class="link-btn danger-text" data-remove-watch="${i}">เลิกติดตาม</button></div></div></li>`).join("");
  el("#watchRunBtn").disabled = !sources.length || playlistWatch.running;
  const lines = (playlistWatch.last_result || []).map((r) => r.error
    ? `⚠️ ${r.error}`
    : `พบ ${r.found} คลิปล่าสุด · เพิ่ม ${r.added.length} ตอน${r.added.length ? `: ${r.added.join(", ")}` : ""}`);
  el("#watchStatus").textContent = playlistWatch.running ? "กำลังเช็ค..."
    : playlistWatch.last_run ? `เช็คล่าสุด ${timeAgo(playlistWatch.last_run, "เมื่อสักครู่")} — ${lines.join(" / ")}`
    : sources.length ? "ยังไม่เคยเช็ค (จะเช็คเองภายใน 2 ชม. หรือกด เช็คตอนนี้)" : "";
}

async function saveWatchSources(sources) {
  try { await sendJSON("PUT", "/api/video-playlists/watch", { sources }); }
  catch (e) { alert(e.message || "บันทึกไม่สำเร็จ"); }
  await loadPlaylistWatch();
}

function initPlaylistWatch() {
  el("#watchSourceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = el("#watchSourceUrl").value.trim();
    await saveWatchSources([...(playlistWatch.sources || []), { url, category: el("#watchSourceCategory").value }]);
    el("#watchSourceUrl").value = "";
  });
  el("#watchSourceList").addEventListener("click", (event) => {
    const i = event.target.closest("[data-remove-watch]")?.dataset.removeWatch;
    if (i === undefined || !confirm("เลิกติดตามเพจนี้? (ตอนที่เพิ่มไปแล้วยังอยู่)")) return;
    saveWatchSources(playlistWatch.sources.filter((_, idx) => idx !== Number(i)));
  });
  el("#watchRunBtn").addEventListener("click", async () => {
    try { await sendJSON("POST", "/api/video-playlists/watch/run"); } catch (e) { alert(e.message); }
    loadPlaylistWatch();
  });
  el("#addLinksBtn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const msg = el("#addLinksMsg");
    btn.disabled = true;
    msg.classList.remove("error");
    msg.textContent = "กำลังอ่านลิงก์...";
    try {
      const data = await sendJSON("POST", "/api/video-playlists/add-links", {
        links: el("#addLinksText").value, playlist_id: el("#addLinksPlaylist").value || null, category: "ซีรีส์จีน" });
      const label = { exists: "มีอยู่แล้ว", skipped: "ข้าม", error: "ผิดพลาด" };
      msg.textContent = data.results.map((r) => r.status === "added"
        ? `✓ ${r.playlist} ตอนที่ ${r.episode}${r.new_playlist ? " (เรื่องใหม่)" : ""}`
        : `${label[r.status]}: ${r.title || r.url}${r.error ? ` — ${r.error}` : ""}`).join("\n");
      if (data.results.some((r) => r.status === "added")) {
        el("#addLinksText").value = "";
        await loadVideos();
        renderVideoManage();
        renderPlaylistWatch();
      }
    } catch (e) {
      msg.classList.add("error");
      msg.textContent = e.message || "เพิ่มไม่สำเร็จ";
    } finally { btn.disabled = false; }
  });
}

async function patchVideo(id, body) {
  try {
    const updated = await sendJSON("PATCH", `/api/videos/${encodeURIComponent(id)}`, body);
    const v = state.videos.find((x) => x.id === id);
    if (v) Object.assign(v, { title: updated.title, category_id: updated.category_id });
    renderVideos();
  } catch (e) { alert(e.message || "บันทึกไม่สำเร็จ"); renderVideoManage(); }
}

function initAdminPanels() {
  els(".sub-tab-btn").forEach((btn) => btn.addEventListener("click", () => {
    if (btn.dataset.subtab === "systemManage") loadSystemStatus();
    if (btn.dataset.subtab === "commentManage") loadCommentManage();
    if (btn.dataset.subtab === "videoManage") loadVideos().then(() => { renderVideoManage(); loadPlaylistWatch(); });
  }));
  el("#systemRefreshBtn").addEventListener("click", loadSystemStatus);
  el("#commentManageList").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-delete-comment]");
    if (btn && (await deleteCommentById(btn.closest("[data-comment-id]").dataset.commentId))) loadCommentManage();
  });
  el("#playlistImportFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const msg = el("#playlistImportMsg");
    msg.classList.remove("error");
    msg.textContent = "กำลังนำเข้า...";
    try {
      const data = await sendJSON("POST", "/api/video-playlists/import", JSON.parse(await file.text()));
      msg.textContent = `นำเข้าแล้ว: ตอนใหม่ ${data.added} · ย้ายเข้า playlist ${data.moved} · กำลังโหลดปก ${data.thumbs_queued} รูปเบื้องหลัง`;
      await loadVideos();
      renderVideoManage();
    } catch (e) {
      msg.classList.add("error");
      msg.textContent = e instanceof SyntaxError ? "ไฟล์ไม่ใช่ JSON" : e.message || "นำเข้าไม่สำเร็จ";
    }
  });
  el("#playlistManageList").addEventListener("change", async (event) => {
    const input = event.target.closest(".playlist-name-input, .playlist-category-select");
    if (!input) return;
    const body = input.matches("select") ? { category_id: input.value || null } : { name: input.value };
    try { await sendJSON("PATCH", `/api/video-playlists/${encodeURIComponent(input.closest("[data-playlist-id]").dataset.playlistId)}`, body); }
    catch (e) { alert(e.message || "บันทึกไม่สำเร็จ"); }
    await loadVideos();
    renderVideoManage();
  });
  el("#playlistManageList").addEventListener("click", async (event) => {
    if (!event.target.closest("[data-delete-playlist]")) return;
    const row = event.target.closest("[data-playlist-id]");
    const p = (state.videoPlaylists || []).find((x) => x.id === row.dataset.playlistId);
    if (!p || !confirm(`ลบ playlist "${p.name}" พร้อมทั้ง ${p.count} ตอน?\n(ทุกคนจะไม่เห็นอีก)`)) return;
    try { await sendJSON("DELETE", `/api/video-playlists/${encodeURIComponent(p.id)}`); }
    catch (e) { alert(e.message || "ลบไม่สำเร็จ"); return; }
    await loadVideos();
    renderVideoManage();
  });
  el("#addVideoCategoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = el("#newVideoCategoryName").value.trim();
    try {
      await sendJSON("POST", "/api/video-categories", { name });
      el("#newVideoCategoryName").value = "";
      el("#videoCategoryMsg").textContent = "";
      await loadVideos();
      renderVideoManage();
    } catch (e) { el("#videoCategoryMsg").textContent = e.message; }
  });
  el("#videoCategoryList").addEventListener("click", async (event) => {
    const id = event.target.closest("[data-delete-video-category]")?.dataset.deleteVideoCategory;
    if (!id || !confirm("ลบหมวดนี้? (คลิปในหมวดจะกลายเป็นไม่มีหมวด)")) return;
    try { await sendJSON("DELETE", `/api/video-categories/${encodeURIComponent(id)}`); } catch (e) { alert(e.message); }
    await loadVideos();
    renderVideoManage();
  });
  el("#videoManageList").addEventListener("change", (event) => {
    const row = event.target.closest("[data-video-id]");
    if (!row) return;
    if (event.target.matches(".video-category-select")) patchVideo(row.dataset.videoId, { category_id: event.target.value || null });
    if (event.target.matches(".video-title-input")) patchVideo(row.dataset.videoId, { title: event.target.value });
  });
  el("#videoManageList").addEventListener("click", async (event) => {
    if (!event.target.closest("[data-admin-delete-video]")) return;
    const row = event.target.closest("[data-video-id]");
    const v = state.videos.find((x) => x.id === row.dataset.videoId);
    if (!v || !confirm(`ลบคลิป "${v.title}"?`)) return;
    try { await sendJSON("DELETE", `/api/videos/${encodeURIComponent(v.id)}`); } catch (e) { alert(e.message); return; }
    await loadVideos();
    renderVideoManage();
  });
  el("#checkVideosBtn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    el("#checkVideosMsg").textContent = "กำลังตรวจ… (คลิปละประมาณ 1-2 วิ)";
    try {
      const res = await sendJSON("POST", "/api/admin/videos/check", {});
      el("#checkVideosMsg").textContent = res.failed.length
        ? `ตรวจ ${res.checked} คลิป · หาไฟล์ตรงไม่ได้ ${res.failed.length} คลิป (จะใช้ตัวเล่น Facebook แทน): ${res.failed.map((f) => f.title).join(", ")}`
        : `ตรวจ ${res.checked} คลิป · หาไฟล์ตรงได้ทุกคลิป ✓`;
    } catch (e) { el("#checkVideosMsg").textContent = e.message || "ตรวจไม่สำเร็จ"; }
    finally { btn.disabled = false; }
  });
}

// ---------- ทำงานแบบแอป: แคชไฟล์ผ่าน service worker + แถบแจ้งออฟไลน์ ----------
function initAppShell() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  const update = () => { el("#offlineBanner").hidden = navigator.onLine; };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ---------- ปัดจากขอบซ้ายเพื่อย้อนกลับ ----------
// เว็บแอปจากหน้าจอโฮมของ iPhone ไม่มีปุ่ม/ท่าย้อนกลับของ Safari — ทำเองเฉพาะกรณีนั้น
// (Safari ปกติมีท่าปัดย้อนของตัวเอง, Android ใช้ขอบจอเป็นปุ่มย้อนของระบบ ทำซ้อนจะชนกัน)
// ย้อนทีละชั้น: แผงแจ้งเตือน → คอมเมนต์ → ฟอร์ม → ตัวอ่าน → ตัวเล่น → รายชื่อตอน → แท็บก่อนหน้า
function goBack() {
  if (!el("#notifPanel").hidden) return toggleNotifPanel(false), true;
  if (!el("#commentSheet").hidden) return closeComments(), true;
  if (!el("#videoFormModal").hidden) return showVideoForm(false), true;
  if (!el("#mangaFormModal").hidden) return closeMangaModal(), true;
  if (!el("#reader").hidden) return closeReader(), true;
  if (!el("#videoPlayer").hidden && !isVideoMini()) return closeVideo(), true;
  if (!el("#playlistView").hidden) return closePlaylist(), true;
  if (!el("#chapterListView").hidden) return closeChapterList(), true;
  if (state.tab === "list" && state.homeMode === "history") return setHomeMode("grid"), true;
  const prev = tabHistory.pop();
  if (prev) return showTab(prev, true), true;
  return false;
}

// แตะในแถวที่เลื่อนแนวนอนอยู่แล้ว (เลื่อนไปทางขวาแล้ว) = ผู้ใช้จะเลื่อนแถวกลับ ไม่ใช่ย้อนหน้า
function inScrolledRow(target) {
  for (let n = target; n && n !== document.body; n = n.parentElement) {
    if (n.scrollLeft > 0 && n.scrollWidth > n.clientWidth) return true;
  }
  return false;
}

function initEdgeSwipe(force = false) {
  if (!force && !(isIOS && isStandalone)) return;
  const EDGE = 24;     // ต้องเริ่มแตะห่างขอบซ้ายไม่เกินนี้ (px)
  const TRIGGER = 70;  // ลากไปทางขวาเกินนี้แล้วปล่อย = ย้อนกลับ
  const arrow = document.createElement("div");
  arrow.className = "edge-back";
  arrow.textContent = "‹";
  document.body.appendChild(arrow);
  let startX = null, startY = 0, dx = 0, dragging = false;
  const reset = () => {
    startX = null;
    dragging = false;
    arrow.classList.remove("show", "ready");
    arrow.style.transform = "";
  };
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (e.touches.length !== 1 || t.clientX > EDGE || inScrolledRow(e.target)) return reset();
    startX = t.clientX;
    startY = t.clientY;
    dx = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startX === null) return;
    const t = e.touches[0];
    dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    if (!dragging) {
      if (dy > 24 && dy > dx) return reset(); // เลื่อนขึ้นลง ไม่ใช่ปัดย้อน
      if (dx < 12) return;
      dragging = true;
    }
    arrow.style.top = `${startY}px`;
    arrow.style.transform = `translate(${Math.min(dx, TRIGGER + 16) * 0.6}px, -50%)`;
    arrow.classList.add("show");
    arrow.classList.toggle("ready", dx >= TRIGGER);
  }, { passive: true });
  const finish = () => {
    if (dragging && dx >= TRIGGER) goBack();
    reset();
  };
  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
}

// Android: ปุ่ม/ท่าปัดย้อนของระบบ = history.back() ของเบราว์เซอร์ — ปกติจะพาออกจากเว็บทันที
// วางหน้า "กันชน" ไว้ 1 หน้าใน history: กดย้อนแล้วเบราว์เซอร์ถอยมาหน้าเดิม (popstate) → ปิดชั้นบนสุดด้วย
// goBack แล้ววางกันชนใหม่ ถ้าไม่มีอะไรให้ปิดแล้ว (หน้าหลักเปล่า ๆ) ถอยต่ออีกหน้าให้เอง = ออกจากเว็บในการกดครั้งเดียว
function initAndroidBack(force = false) {
  if (!force && !isAndroid) return;
  const guard = () => history.pushState({ meemangaGuard: true }, "", location.href);
  guard();
  window.addEventListener("popstate", () => {
    if (goBack()) guard();
    else history.back();
  });
}

function init() {
  applyAdminGating();
  renderGrid();
  initInstallButton();
  initPush();
  openFromUrl(new URL(location.href));

  initTabs();
  initSubTabs();
  initGridClicks();
  initSettingsClicks();
  initChapterListClicks();
  initMangaForm();
  initChapterSearch();
  initCatalogSearch();
  initCatalogModes();
  initSearch();
  initCategoryAdmin();
  initPrefs();
  initHomeTabs();
  initUserAdmin();
  initPasswordForm();
  initTheme();
  initAddUserForm();
  initVideos();
  initComments();
  initContinue();
  initAdminPanels();
  initPlaylistWatch();
  initLibrary();
  initAdminSearch();
  initAppShell();
  initEdgeSwipe();
  initAndroidBack();
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
