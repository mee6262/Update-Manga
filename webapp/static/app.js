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

// ---------- ข้อความลอย / แผ่นยืนยัน (แทน alert/confirm ของระบบ ที่บน iPhone เป็นกล่องเทา ๆ ไม่เข้ากับแอป) ----------
let toastTimer = null;
function toast(message, { error = false } = {}) {
  const box = el("#toast");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = false;
  clearTimeout(toastTimer);
  // ข้อความยาวอยู่นานขึ้น พออ่านทัน
  toastTimer = setTimeout(() => { box.hidden = true; }, Math.min(9000, 2500 + message.length * 45));
}

let confirmResolve = null;
function askConfirm(message) {
  // ปุ่มยืนยันใช้คำกริยาแรกของคำถาม ("ลบ", "ย้าย", ...) — คำสั่งที่ย้อนไม่ได้เป็นปุ่มแดง
  const verb = (message.match(/^(ลบ|ย้าย|รีเซ็ต|ปิด|เลิกติดตาม)/) || [])[1] || "ยืนยัน";
  el("#confirmText").textContent = message;
  el("#confirmOk").textContent = verb;
  el("#confirmOk").classList.toggle("danger", /^(ลบ|รีเซ็ต|เลิกติดตาม)/.test(message));
  el("#confirmSheet").hidden = false;
  if (confirmResolve) confirmResolve(false);
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
  el("#confirmSheet").hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

function initConfirmSheet() {
  el("#confirmOk").addEventListener("click", () => closeConfirm(true));
  el("#confirmCancel").addEventListener("click", () => closeConfirm(false));
  el("#confirmSheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeConfirm(false); });
  el("#toast").addEventListener("click", () => { el("#toast").hidden = true; });
}

// หลุดจากระบบ (session หมดอายุ/รหัสถูกเปลี่ยน) → พาไปหน้า login แทนที่จะเห็นหน้าว่างเหมือนข้อมูลหาย
let goingToLogin = false;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : input.url;
  if (res.status === 401 && !goingToLogin && new URL(url, location.href).pathname.startsWith("/api/")) {
    goingToLogin = true;
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
  }
  return res;
};

// เน็ตมือถือค้าง fetch จะรอไม่มีกำหนด → ตัดเองตามเวลา ให้หน้าขึ้น "ลองใหม่" แทน "กำลังโหลด..." ค้าง
function fetchWithTimeout(url, init = {}, ms = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal })
    .catch((e) => {
      if (e.name === "AbortError") throw Object.assign(new Error("timeout"), { body: { error: "เน็ตช้าหรือเซิร์ฟเวอร์ไม่ตอบ ลองใหม่อีกครั้ง" } });
      throw Object.assign(e, { body: { error: "เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่" } });
    })
    .finally(() => clearTimeout(timer));
}

async function getJSON(url, { timeout = 25000 } = {}) {
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, timeout);
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
    refreshHomeIfStale(30 * 1000);
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
    return videoItemHtml(video, `<a class="video-card" data-video-id="${escapeHtml(video.id)}" href="${escapeHtml(video.facebook_url)}" target="_blank" rel="noopener"><span class="video-media">${image}<span class="video-resume-badge video-external-badge">เปิดใน ${video.provider === "youtube" ? "YouTube" : "Facebook"}</span>${video.can_delete ? '<span class="video-card-delete" data-delete-video role="button">ลบ</span>' : ""}</span>${info}</a>`);
  }
  // คลิปเดี่ยวที่เพิ่มภายใน 3 วันและยังไม่ได้ดู (ตอนของ playlist ใช้ป้ายบนการ์ดเรื่องแทน)
  const fresh = !video.playlist_id && !video.watched_at && isRecent(video.created_at) ? '<span class="new-badge">NEW</span>' : "";
  return videoItemHtml(video, `<button class="video-card" data-video-id="${escapeHtml(video.id)}"><span class="video-media">${image}${ytBadge(video)}${fresh}${resume}${timeLabel}</span>${info}</button>`);
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
  el("#videoToolbar").hidden = videoTab !== "home";
  el("#videoHome").hidden = !rows;
  if (rows) renderVideoHome();
  el("#libraryView").hidden = !library;
  if (library) renderLibrary();
  renderPlaylistRow();
  // สลับหมวดแล้วท้ายหน้ายังอยู่ในจอ (จอใหญ่/การ์ดน้อย) ตัวดูการเลื่อนไม่ยิงซ้ำ เพราะท้ายหน้าไม่ได้ "เพิ่งเข้ามา" ในจอ
  if (fillVideoCards) setTimeout(fillVideoCards, 0);
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
  if (video.bulk) return false; // เพิ่มมาพร้อมทั้ง playlist ทีเดียว
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
  const started = eps.some((v) => episodeProgress(v).watched_at);
  const fresh = newEpisodes(p, eps);
  const meta = fresh.length ? `${episodeLabel(fresh[fresh.length - 1])} มาแล้ว · ${eps.length} ตอน` : `${eps.length} ตอน`;
  const cover = (fresh.length ? fresh[fresh.length - 1] : resume).thumbnail_url || p.thumbnail_url;
  return `<div class="mm-hero" data-playlist-id="${escapeHtml(p.id)}">${thumbHtml(cover)}
    <div class="mm-hero-info">${playlistBadge(p, eps).replace("new-badge", "new-badge mm-hero-badge")}
      <div class="mm-hero-name">${escapeHtml(p.name)}</div><div class="mm-hero-meta">${meta}</div>
      <button class="btn primary" data-hero-play="${escapeHtml(resume.id)}">▶ ${started ? "ดูต่อ" : "เริ่มดู"} ${episodeLabel(resume)}</button>
    </div></div>`;
}

function homeRowHtml(title, tiles, more = "", rowClass = "mm-row") {
  return `<section class="mm-section"><div class="mm-row-head"><h2 class="section-title">${title}</h2>${more}</div><div class="${rowClass}">${tiles}</div></section>`;
}

// การ์ดเล็กของคลิป/ตอน ในแถวหน้าหลัก
function videoTileHtml(v, { name, meta, badge = "" }) {
  const pos = Number(v.position_seconds) || 0;
  const dur = Number(v.duration_seconds) || 0;
  return `<button class="mm-tile" data-video-id="${escapeHtml(v.id)}"><span class="mm-thumb">${thumbHtml(v.thumbnail_url)}${ytBadge(v)}${badge}${progressBarHtml(pos, dur)}</span><span class="mm-name">${escapeHtml(name)}</span><span class="mm-meta">${escapeHtml(meta)}</span></button>`;
}

function videoNameAndEp(v) {
  const p = v.playlist_id && playlistById(v.playlist_id);
  return p ? { name: p.name, ep: `${episodeLabel(v)}${v.lang && seriesLangs(p).length > 1 ? ` ${LANG_LABEL[v.lang].replace("ไทย", "")}` : ""}` } : { name: v.title, ep: "" };
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
      return videoTileHtml(v, { name: playlistById(v.playlist_id).name, meta: `${episodeLabel(v)}${v.lang ? ` ${LANG_LABEL[v.lang].replace("ไทย", "")}` : ""} · ${timeAgo(v.created_at, "เมื่อสักครู่")}`, badge: fresh ? '<span class="new-badge">NEW</span>' : "" });
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
  } catch (e) { toast(e.message || "บันทึกไม่สำเร็จ", { error: true }); btn.disabled = false; }
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

let fillVideoCards = null; // เติมการ์ดจนล้นจอ — ตั้งค่าใน initVideoInfiniteScroll

function initVideoInfiniteScroll() {
  const sentinel = el("#videoSentinel");
  const near = () => {
    const rect = sentinel.getBoundingClientRect();
    return rect.height >= 0 && rect.top < window.innerHeight + 800 && sentinel.offsetParent;
  };
  // เติมแล้วท้ายหน้ายังอยู่ในจอ (จอสูง/การ์ดน้อย) เติมต่อจนล้นจอ
  const fill = () => { for (let i = 0; i < 20 && near() && loadMoreVideoCards(); i++); };
  fillVideoCards = fill;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) fill(); }, { rootMargin: "0px 0px 800px 0px" }).observe(sentinel);
  }
  window.addEventListener("scroll", () => { if (near()) fill(); }, { passive: true });
}

// ตอนทั้งหมดของเรื่อง (ทุกภาษา) จัดกลุ่มตามเรื่องครั้งเดียวต่อชุดข้อมูล — เรื่องหนึ่งมีได้หลายร้อยตอน
let episodeIndex = { source: null, size: 0, map: new Map(), seasons: new Map() };
function allPlaylistEpisodes(playlistId) {
  if (episodeIndex.source !== state.videos || episodeIndex.size !== state.videos.length) {
    const map = new Map();
    for (const v of state.videos) if (v.playlist_id) (map.get(v.playlist_id) || map.set(v.playlist_id, []).get(v.playlist_id)).push(v);
    // เรียงซีซั่นก่อน — บางเรื่องเริ่มตอนที่ 1 ใหม่ทุกซีซั่น เรียงแค่เลขตอนแล้วตอนคนละซีซั่นปนกัน (14, 14, 15, 15)
    const seasons = new Map();
    for (const [id, list] of map) {
      list.sort((a, b) => (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0));
      seasons.set(id, new Set(list.map((v) => v.season || 1)).size);
    }
    episodeIndex = { source: state.videos, size: state.videos.length, map, seasons };
  }
  return episodeIndex.map.get(playlistId) || [];
}

// ---------- พากย์ไทย / ซับไทย ในเรื่องเดียวกัน ----------
const LANG_LABEL = { dub: "พากย์ไทย", sub: "ซับไทย" };
function seriesLangs(p) {
  return (p && p.langs) || [];
}

// ภาษาที่ดูเรื่องนี้อยู่: ที่เลือกไว้ (ตามบัญชี) → ภาษาของตอนที่ดูล่าสุด → พากย์ไทย
function seriesLang(p) {
  const langs = seriesLangs(p);
  if (langs.length < 2) return null;
  const pref = (state.prefs.video_lang || {})[p.id];
  if (langs.includes(pref)) return pref;
  const last = allPlaylistEpisodes(p.id).filter((v) => v.watched_at && v.lang)
    .sort((a, b) => b.watched_at.localeCompare(a.watched_at))[0];
  if (last) return last.lang;
  return langs.includes("dub") ? "dub" : langs[0];
}

function setSeriesLang(p, lang) {
  savePref("video_lang", { ...(state.prefs.video_lang || {}), [p.id]: lang });
}

// ตอนของเรื่องในภาษาที่เลือก (เรื่องภาษาเดียว = ทุกตอน) — ตอนที่ไม่รู้ภาษาอยู่ทุกภาษา
function playlistEpisodes(playlistId) {
  const all = allPlaylistEpisodes(playlistId);
  const lang = seriesLang(playlistById(playlistId));
  return lang ? all.filter((v) => !v.lang || v.lang === lang) : all;
}

// ตอนเดียวกันในภาษาอื่น (เลขตอน + ซีซั่นตรงกัน) — ดูพากย์ถึงไหน สลับเป็นซับก็ต่อได้
function siblingEpisodes(v) {
  if (!v.playlist_id || !v.lang) return [];
  return allPlaylistEpisodes(v.playlist_id).filter((x) => x.lang && x.lang !== v.lang
    && Number(x.episode) === Number(v.episode) && (x.season || 1) === (v.season || 1));
}

// สถานะการดูของ "ตอน" รวมทุกภาษา: ยึดภาษาที่ดูล่าสุด
function episodeProgress(v) {
  const latest = [v, ...siblingEpisodes(v)].filter((x) => x.watched_at)
    .sort((a, b) => b.watched_at.localeCompare(a.watched_at))[0];
  if (!latest) return { watched_at: null, pos: 0, dur: Number(v.duration_seconds) || 0 };
  return { watched_at: latest.watched_at, pos: Number(latest.position_seconds) || 0,
    dur: Number(latest.duration_seconds) || Number(v.duration_seconds) || 0 };
}

// ตอนในภาษาเดียวกับคลิปที่เล่นอยู่ (เล่นต่อ/แถบเลขตอนใต้คลิป ไม่สลับภาษาเอง)
function episodesLike(video) {
  const all = allPlaylistEpisodes(video.playlist_id);
  return video.lang ? all.filter((v) => !v.lang || v.lang === video.lang) : all;
}

function seasonLabel(p, season) {
  return (p.season_names || {})[String(season)] || `ซีซั่น ${season}`;
}

// เรื่องที่มีหลายซีซั่น บอกซีซั่นด้วย ("ซีซั่น 3 ตอนที่ 14") — เลขตอนอย่างเดียวซ้ำกันได้ข้ามซีซั่น
function episodeLabel(video) {
  if (video.playlist_id && (allPlaylistEpisodes(video.playlist_id), episodeIndex.seasons.get(video.playlist_id) > 1)) {
    const p = playlistById(video.playlist_id);
    return `${p ? seasonLabel(p, video.season || 1) : `ซีซั่น ${video.season || 1}`} ตอนที่ ${Number(video.episode)}`;
  }
  return `ตอนที่ ${Number(video.episode)}`;
}

// ตอนในซีซั่นเดียวกับคลิป (แถบเลขตอนใต้คลิป / ตัวนับ "ตอนที่ x / y")
function seasonEpisodesLike(video) {
  return episodesLike(video).filter((v) => (v.season || 1) === (video.season || 1));
}

// ชื่อตอน (ถ้ามี) = ชื่อคลิปที่ตัดชื่อเรื่อง/เลขตอนออก เช่น "THE4 โดนซองขาว" → "โดนซองขาว"
function episodeSubtitle(video, playlistName) {
  let rest = video.title.startsWith(playlistName) ? video.title.slice(playlistName.length) : video.title;
  rest = rest.replace(/^[\s,.:|-]*(ep\.?|ตอนที่|ตอน|part)?\s*\d+(\.\d+)?\.?\s*(จบ)?/i, "").trim();
  return rest && rest !== video.title ? rest : "";
}

// ตอนที่ควรเล่นเมื่อกด "ดูต่อ": ตอนล่าสุดที่เปิด — ดูค้างอยู่ = ตอนนั้น, ดูจบแล้ว = ตอนถัดไป, ยังไม่เคยดู = ตอนแรก
function playlistResume(episodes) {
  let last = null, lastProg = null;
  for (const v of episodes) {
    const prog = episodeProgress(v);
    if (prog.watched_at && (!lastProg || prog.watched_at > lastProg.watched_at)) { last = v; lastProg = prog; }
  }
  if (!last) return episodes[0];
  if (lastProg.pos > 0) return last;
  return episodes[episodes.indexOf(last) + 1] || last;
}

function renderPlaylistRow() {
  const lists = visiblePlaylists();
  el("#playlistSection").hidden = !lists.length;
  el("#playlistRow").innerHTML = lists.slice(0, playlistShown).map(playlistCardHtml).join("");
}

function ytBadge(item) {
  return item && item.provider === "youtube" ? '<span class="yt-badge">YouTube</span>' : "";
}

function playlistCardHtml(p) {
  const eps = playlistEpisodes(p.id);
  const resume = eps.some((v) => episodeProgress(v).watched_at) ? playlistResume(eps) : null;
  return `<div class="video-item playlist-item"><button class="video-card playlist-card" data-playlist-id="${escapeHtml(p.id)}"><span class="video-media">${thumbHtml(p.thumbnail_url).replace("<img ", '<img class="video-thumb" ')}${ytBadge(p)}${playlistBadge(p, eps)}<span class="video-time">${eps.length} ตอน</span></span><span class="video-card-info"><span class="video-card-title">${escapeHtml(p.name)}</span>${playlistMetaHtml(p, resume ? `ดูต่อ ${episodeLabel(resume)}` : "ยังไม่เคยดู")}</span></button>${playlistSaveButton(p)}</div>`;
}

// ใต้ชื่อเรื่อง: YouTube (อนิเมะ) = บรรทัด "ซีซั่น 1–4 · พากย์ ซับ" แยก แล้วบรรทัดสถานะการดู
// Facebook = ซีซั่นอยู่บรรทัดเดียวกับสถานะ ("ซีซั่น 1–2 · ยังไม่เคยดู")
function playlistMetaHtml(p, status) {
  const info = seriesInfoHtml(p);
  if (p.provider === "youtube") {
    return `${info ? `<span class="video-card-meta series-info">${info}</span>` : ""}<span class="video-card-meta">${status}</span>`;
  }
  return `<span class="video-card-meta series-info">${info ? `${info}<span aria-hidden="true">·</span>` : ""}<span>${status}</span></span>`;
}

// "ซีซั่น 1–4 · พากย์ ซับ" — เฉพาะเรื่องที่มีหลายซีซั่น หรือรู้ภาษา (เรื่องธรรมดาไม่มีบรรทัดนี้)
function seriesInfoHtml(p) {
  const seasons = [...new Set(allPlaylistEpisodes(p.id).map((v) => v.season || 1))].sort((a, b) => a - b);
  const langs = seriesLangs(p);
  if (seasons.length < 2 && !langs.length) return "";
  const season = seasons.length > 1 ? `<span class="series-seasons">ซีซั่น ${seasons[0]}–${seasons[seasons.length - 1]}</span>` : "";
  const tags = langs.length ? langs.map((l) => `<span class="series-lang">${LANG_LABEL[l].replace("ไทย", "")}</span>`).join("") : "";
  return `${season}${season && tags ? " · " : ""}${tags}`;
}

// ---------- หน้าเรื่อง: หัวเรื่อง + ปุ่มดูต่อ + ตารางเลขตอน ----------
const EP_RANGE = 20;
let playlistRange = 0;
let playlistDesc = false;

// ลำดับตอนในหน้าเรื่อง (ตอนแรกก่อน / ล่าสุดก่อน) จำตามบัญชี ใช้กับทุกเรื่อง — แบบเดียวกับลำดับตอนมังงะ
const EPISODE_SORT_KEY = "episodeSort";
function episodeSortDesc() {
  if (state.prefs.episode_sort === "desc" || state.prefs.episode_sort === "asc") return state.prefs.episode_sort === "desc";
  try { return localStorage.getItem(EPISODE_SORT_KEY) === "desc"; } catch (e) { return false; }
}

function setEpisodeSortDesc(desc) {
  try { localStorage.setItem(EPISODE_SORT_KEY, desc ? "desc" : "asc"); } catch (e) { /* ไม่จำก็ได้ */ }
  savePref("episode_sort", desc ? "desc" : "asc");
}

let playlistSeason = null; // ซีซั่นที่เปิดดูในหน้าเรื่อง (null = ซีซั่นของตอนที่จะดูต่อ)

function openPlaylist(playlistId) {
  openPlaylistId = playlistId;
  playlistDesc = episodeSortDesc();
  playlistSeason = null;
  // เปิดมาที่ช่วงตอนที่จะดูต่อ (เรียงล่าสุดก่อน = นับตำแหน่งจากท้าย)
  const eps = playlistEpisodes(playlistId);
  const at = eps.indexOf(playlistResume(eps));
  playlistRange = eps.length ? Math.floor((playlistDesc ? eps.length - 1 - at : at) / EP_RANGE) : 0;
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
// na = ตอนนี้ยังไม่มีในภาษาที่เลือก (กดแล้วถามว่าจะดูภาษาอื่นไปก่อนไหม)
function episodeTileHtml(v, playlist, { fresh = false, playing = false, na = false } = {}) {
  const { watched_at, pos, dur } = episodeProgress(v);
  const done = watched_at && !pos;
  const sub = v.provider === "youtube" ? "" : episodeSubtitle(v, playlist.name);
  const cls = ["ep-tile", done ? "done" : "", pos > 0 ? "cur" : "", playing ? "playing" : "", sub ? "has-sub" : "", na ? "na" : ""].filter(Boolean).join(" ");
  return `<button class="${cls}" data-episode-id="${escapeHtml(v.id)}"${na ? ` data-na-lang="${escapeHtml(v.lang || "")}"` : ""} title="${escapeHtml(na ? `ยังไม่มีในภาษาที่เลือก (มี${LANG_LABEL[v.lang] || "ภาษาอื่น"})` : sub || episodeLabel(v))}"><span class="ep-num">${Number(v.episode)}</span>${sub ? `<span class="ep-sub">${escapeHtml(sub)}</span>` : ""}${done ? '<span class="ep-check" aria-label="ดูแล้ว">✓</span>' : ""}${fresh ? '<span class="ep-new">NEW</span>' : ""}${pos > 0 && dur > 0 ? `<span class="ep-pg" style="width:${Math.min(100, (pos / dur) * 100).toFixed(1)}%"></span>` : ""}</button>`;
}

function renderPlaylistView() {
  const playlist = playlistById(openPlaylistId);
  const episodes = playlistEpisodes(openPlaylistId);
  if (!playlist || !episodes.length) return closePlaylist();
  el("#playlistTitle").textContent = playlist.name;
  const lang = seriesLang(playlist);
  const resume = playlistResume(episodes);
  const started = episodes.some((v) => episodeProgress(v).watched_at);
  const watched = episodes.filter((v) => { const p = episodeProgress(v); return p.watched_at && !p.pos; }).length;
  const fresh = new Set(newEpisodes(playlist, episodes).map((v) => v.id));
  // ช่องตอน = ทุกเลขตอนที่มีในภาษาใดก็ได้ — ภาษาที่เลือกยังไม่มี (พากย์มักออกช้ากว่าซับ) เป็นกรอบประ
  const mine = new Map(episodes.map((v) => [`${v.season || 1}|${Number(v.episode)}`, v]));
  const slots = [];
  const seen = new Set();
  for (const v of allPlaylistEpisodes(openPlaylistId)) {
    const key = `${v.season || 1}|${Number(v.episode)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push(mine.has(key) ? { v: mine.get(key) } : { v, na: true });
  }
  slots.sort((a, b) => (a.v.season || 1) - (b.v.season || 1) || a.v.episode - b.v.episode);
  const seasons = [...new Set(slots.map((x) => x.v.season || 1))];
  let chips = "";
  let shown;
  if (seasons.length > 1) {
    if (!seasons.includes(playlistSeason)) playlistSeason = resume.season || 1;
    chips = seasons.map((n) => `<button class="video-chip${n === playlistSeason ? " active" : ""}" data-pl-season="${n}">${escapeHtml(seasonLabel(playlist, n))}</button>`).join("");
    shown = slots.filter((x) => (x.v.season || 1) === playlistSeason);
    if (playlistDesc) shown.reverse();
  } else {
    const ordered = playlistDesc ? [...slots].reverse() : slots;
    const ranges = Math.ceil(ordered.length / EP_RANGE);
    playlistRange = Math.min(playlistRange, ranges - 1);
    chips = ranges > 1 ? Array.from({ length: ranges }, (_, i) => {
      const part = ordered.slice(i * EP_RANGE, (i + 1) * EP_RANGE);
      return `<button class="video-chip${i === playlistRange ? " active" : ""}" data-ep-range="${i}">${Number(part[0].v.episode)}${part.length > 1 ? `–${Number(part[part.length - 1].v.episode)}` : ""}</button>`;
    }).join("") : "";
    shown = ordered.slice(playlistRange * EP_RANGE, (playlistRange + 1) * EP_RANGE);
  }
  const tiles = shown.map((x) => episodeTileHtml(x.v, playlist, { fresh: fresh.has(x.v.id), na: x.na })).join("");
  const langSeg = !lang && seriesLangs(playlist).length === 1
    ? `<div class="pl-lang-one">${seriesLangs(playlist).map((l) => `<span class="series-lang">${LANG_LABEL[l]}</span>`).join("")}<span>มีภาษาเดียว</span></div>`
    : lang ? `<div class="pl-lang" role="tablist">${seriesLangs(playlist).map((l) =>
    `<button class="${l === lang ? "active" : ""}" data-pl-lang="${l}" role="tab" aria-selected="${l === lang}">${LANG_LABEL[l] || l}</button>`).join("")}</div>` : "";
  const resumeWhere = `${episodeLabel(resume)}${lang ? ` · ${LANG_LABEL[lang]}` : ""}`;
  el("#playlistBody").innerHTML = `<div class="pl-cover">${thumbHtml(resume.thumbnail_url || playlist.thumbnail_url)}${ytBadge(playlist)}${playlistBadge(playlist, episodes)}</div>
    <h2 class="pl-name">${escapeHtml(playlist.name)}</h2>
    <div class="pl-meta">${seasons.length > 1 ? `${seasons.length} ซีซั่น · ` : ""}${episodes.length} ตอน · อัปเดต ${timeAgo(playlist.updated_at, "เมื่อสักครู่")} · ดูไป ${watched}/${episodes.length}</div>
    <div class="lib-bar pl-bar"><span style="width:${((watched / episodes.length) * 100).toFixed(1)}%"></span></div>
    ${langSeg}
    <div class="pl-actions"><button class="btn primary" data-episode-id="${escapeHtml(resume.id)}">▶ ${started ? "ดูต่อ" : "เริ่มดู"} ${resumeWhere}</button>${playlistSaveButton(playlist)}</div>
    <div class="pl-controls">${chips}<button class="video-chip" data-ep-sort>${playlistDesc ? "ล่าสุดก่อน" : "ตอนแรกก่อน"} ⇅</button></div>
    <div class="ep-grid">${tiles}</div>
    ${seriesLangs(playlist).length > 1 ? '<div class="hint pl-hint">กรอบประ = ตอนนี้ยังไม่มีในภาษาที่เลือก · ดูถึงไหนนับรวมทั้งพากย์และซับ</div>' : ""}`;
}

function neighborEpisode(video, step) {
  if (!video?.playlist_id) return null;
  const episodes = episodesLike(video);
  return episodes[episodes.findIndex((v) => v.id === video.id) + step] || null;
}

function renderEpisodeNav(video) {
  const nav = el("#episodeNav");
  nav.hidden = !video.playlist_id;
  renderPlayerEpisodes(video);
  if (nav.hidden) return;
  const episodes = seasonEpisodesLike(video);
  el("#episodeLabel").textContent = `${episodeLabel(video)} / ${episodes.length}${video.lang ? ` · ${LANG_LABEL[video.lang].replace("ไทย", "")}` : ""}`;
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
  const episodes = seasonEpisodesLike(video);
  const fresh = new Set(newEpisodes(playlist, episodes).map((v) => v.id));
  const scroll = box.scrollLeft;
  box.innerHTML = episodes.map((v) => episodeTileHtml(v, playlist, { fresh: fresh.has(v.id), playing: v.id === video.id })).join("");
  const playing = box.querySelector(".playing");
  if (box.dataset.for === video.id) box.scrollLeft = scroll;
  // วัดจากตำแหน่งบนจอ (offsetLeft นับจากกล่องแม่ตัวอื่น ทำให้เลื่อนไม่ถึงตอนที่เล่นอยู่)
  else if (playing) box.scrollLeft += playing.getBoundingClientRect().left - box.getBoundingClientRect().left - box.clientWidth / 2 + playing.offsetWidth / 2;
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
  if (ytPlayer && video.provider !== "youtube") unmountYouTube();
  openVideo(video, { autoplay: true });
}

// เล่นตอนถัดไปเองเมื่อจบตอน — เปิด/ปิดได้ จำต่อเครื่อง (ค่าเริ่มต้น: เปิด)
const AUTO_NEXT_KEY = "videoAutoNext";
function autoNextOn() {
  if (typeof state.prefs.auto_next === "boolean") return state.prefs.auto_next; // ตามบัญชี
  try { return localStorage.getItem(AUTO_NEXT_KEY) !== "off"; } catch (e) { return true; }
}

function setAutoNextPref(on) {
  try { localStorage.setItem(AUTO_NEXT_KEY, on ? "on" : "off"); } catch (e) { /* ไม่จำก็ได้ */ }
  savePref("auto_next", on);
  el("#setAutoNext").checked = on;
  renderAutoNext();
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
  const paused = nativeVideo ? nativeVideo.paused : ytPlayer ? ytPaused() : false;
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

// ---------- ตัวเล่น YouTube (IFrame API) ----------
// ใช้ตัวเล่นตัวเดิมเปลี่ยนคลิป (loadVideoById) ตอนเล่นตอนถัดไป — แบบเดียวกับ <video> ของ Facebook: iPhone ยอมให้
// กรอบที่ผู้ใช้เคยแตะเล่นแล้วเล่นต่อเองได้ ส่วนกรอบใหม่ต้องแตะเล่นเองทุกครั้ง
let youTubeApiPromise = null;
let ytPlayer = null;
let ytReady = false;

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (youTubeApiPromise) return youTubeApiPromise;
  youTubeApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (previous) previous(); resolve(window.YT); };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => { youTubeApiPromise = null; reject(new Error("โหลดตัวเล่น YouTube ไม่สำเร็จ")); };
    document.head.appendChild(script);
  });
  return youTubeApiPromise;
}

function unmountYouTube() {
  if (ytPlayer) { try { ytPlayer.destroy(); } catch (e) { /* ลบกรอบไปแล้ว */ } }
  ytPlayer = null;
  ytReady = false;
}

function ytPaused() {
  try { return ytPlayer.getPlayerState() !== 1; } catch (e) { return true; }
}

function onYouTubeState(event) {
  const YT = window.YT;
  if (event.data === YT.PlayerState.PLAYING) { rememberVideoDuration(); renderMiniPlay(); }
  if (event.data === YT.PlayerState.PAUSED) { saveActiveVideoProgress(true); renderMiniPlay(); }
  if (event.data === YT.PlayerState.ENDED) { clearActiveVideoProgress(); renderMiniPlay(); playNextEpisode(); }
}

// 101/150 = เจ้าของคลิปไม่ให้เล่นในเว็บอื่น, 100 = คลิปถูกลบ/ส่วนตัว
function onYouTubeError(event) {
  const video = activeVideo;
  if (!video) return;
  const why = event.data === 100 ? "คลิปนี้ถูกลบหรือเป็นส่วนตัว" : event.data === 101 || event.data === 150
    ? "เจ้าของคลิปไม่ให้เล่นนอก YouTube" : "เล่นคลิปนี้ไม่ได้";
  el("#ytError").hidden = false;
  el("#ytError").innerHTML = `${why} <a class="btn small" href="${escapeHtml(video.facebook_url)}" target="_blank" rel="noopener">เปิดใน YouTube ↗</a>`;
}

async function mountYouTubeVideo(video, position, autoplay) {
  const YT = await loadYouTubeApi();
  if (activeVideo?.id !== video.id) return;
  const start = Math.floor(position);
  if (ytPlayer && ytReady && el("#ytMount")) {
    el("#ytError").hidden = true;
    el("#ytOpen").href = video.facebook_url;
    if (autoplay) ytPlayer.loadVideoById({ videoId: video.youtube_id, startSeconds: start });
    else ytPlayer.cueVideoById({ videoId: video.youtube_id, startSeconds: start });
  } else {
    unmountYouTube();
    el("#videoPlayerBody").innerHTML = `<div class="yt-wrap"><div id="ytMount"></div></div>
      <div id="ytError" class="yt-error" hidden></div>
      <a id="ytOpen" class="yt-open" href="${escapeHtml(video.facebook_url)}" target="_blank" rel="noopener">เปิดใน YouTube ↗</a>`;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ตัวเล่น YouTube ไม่ตอบ ลองใหม่อีกครั้ง")), 15000);
      ytPlayer = new YT.Player("ytMount", {
        videoId: video.youtube_id,
        playerVars: { start, autoplay: autoplay ? 1 : 0, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => { clearTimeout(timer); ytReady = true; resolve(); },
          onStateChange: onYouTubeState,
          onError: onYouTubeError,
        },
      });
    });
  }
  activeFbPlayer = { getCurrentPosition: () => ytPlayer.getCurrentTime(), getDuration: () => ytPlayer.getDuration() };
  videoApiWorks = true;
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
      el("#setVideoQuality").value = q;
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
  [100, 500, 1000].forEach((ms) => setTimeout(fixFixedLayout, ms));
}

// เลื่อน 1px (ถอยขึ้นถ้าอยู่ท้ายหน้า — เลื่อนลงเกินท้ายหน้าไม่มีผล) + ซ่อน/โชว์เมนูล่างให้ Safari จัดตำแหน่งใหม่
function fixFixedLayout() {
  const y = window.scrollY;
  window.scrollTo(0, y > 0 ? y - 1 : y + 1);
  window.scrollTo(0, y);
  const nav = el(".bottom-nav");
  nav.style.display = "none";
  void nav.offsetHeight;
  nav.style.display = "";
}

// ตรวจว่าเมนูล่างไม่ชิดขอบจอ (ลอยกลางจอ) — เกิดได้หลังคีย์บอร์ดหุบ/ออกจากเต็มจอ ตอนที่หน้ายังล็อกเลื่อนอยู่
function checkBottomNav() {
  if (document.hidden) return;
  const nav = el(".bottom-nav");
  if (!nav || getComputedStyle(nav).display === "none") return;
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return; // คีย์บอร์ดยังเปิด
  const vv = window.visualViewport;
  const screenBottom = Math.max(window.innerHeight, vv ? vv.height + vv.offsetTop : 0);
  if (screenBottom - nav.getBoundingClientRect().bottom > 4) fixFixedLayout();
}

function initFixedLayoutGuard() {
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(checkBottomNav, 150); };
  window.addEventListener("resize", later);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", later);
  window.addEventListener("scroll", later, { passive: true });
  document.addEventListener("focusout", later);
  document.addEventListener("visibilitychange", later);
  window.addEventListener("pageshow", later);
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
      toast(`เปิดจอลอยไม่ได้: ${e.name || ""} ${e.message || e}`, { error: true });
    }
    // สั่งแล้วไม่เข้าจอลอย (ระบบเงียบ ๆ ไม่ยอม) → บอกผู้ใช้ แทนที่ปุ่มจะดูเหมือนไม่ทำงาน
    setTimeout(() => {
      if (!active && !pipState(v).active) toast("เครื่องนี้ไม่ยอมเปิดจอลอยจากเว็บนี้ — บน iPhone ลองเปิดเว็บผ่าน Safari (ไม่ใช่ไอคอนหน้าจอโฮม) แล้วกดอีกครั้ง", { error: true });
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
  el("#videoPlayer").hidden = false; // ก่อนวาดแถบเลขตอน — ซ่อนอยู่วัดตำแหน่งไม่ได้ เลื่อนไปตอนที่เล่นไม่ถึง
  renderEpisodeNav(video);
  refreshCommentCount({ kind: "video", id: video.id }, el("#videoCommentCount"));
  el("#videoDeleteBtn").hidden = !video.can_delete;
  document.body.style.overflow = "hidden";
  try {
    const [progress, sources] = await Promise.all([
      getJSON(`/api/videos/${encodeURIComponent(video.id)}/progress`),
      getJSON(`/api/videos/${encodeURIComponent(video.id)}/sources`, { timeout: 45000 }).catch(() => ({})),
    ]);
    if (!activeVideo || activeVideo.id !== video.id) return;
    // ตอนนี้ยังไม่เคยดูในภาษานี้ แต่ดูค้างในอีกภาษา (สลับพากย์ ↔ ซับ) → ต่อจากจุดเดิม
    const sibling = episodeProgress(video);
    const position = Number(progress.position_seconds) || (sibling.watched_at && sibling.pos) || 0;
    if (video.provider === "youtube") {
      unmountNativeVideo();
      await mountYouTubeVideo(video, position, autoplay);
      clearInterval(videoSaveTimer);
      videoSaveTimer = setInterval(saveActiveVideoProgress, 10000);
      return;
    }
    unmountYouTube();
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
  unmountYouTube();
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
      } catch (e) { toast(e.message || "บันทึกไม่สำเร็จ", { error: true }); saveBtn.disabled = false; }
      return;
    }
    const card = event.target.closest(".video-card");
    // คลิปแบบเปิดใน Facebook ไม่มีหน้าตัวเล่น (ที่มีปุ่มลบ) จึงลบจากปุ่มบนการ์ดแทน
    if (event.target.closest("[data-delete-video]")) {
      event.preventDefault();
      const target = state.videos.find((item) => item.id === card?.dataset.videoId);
      if (!target || !(await askConfirm(`ลบคลิป "${target.title}"?\n(ทุกคนจะไม่เห็นคลิปนี้อีก)`))) return;
      try { await sendJSON("DELETE", `/api/videos/${encodeURIComponent(target.id)}`); }
      catch (e) { toast(e.message || "ลบคลิปไม่สำเร็จ", { error: true }); return; }
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
  el("#playlistBody").addEventListener("click", async (event) => {
    const range = event.target.closest("[data-ep-range]")?.dataset.epRange;
    if (range !== undefined) { playlistRange = Number(range); return renderPlaylistView(); }
    const season = event.target.closest("[data-pl-season]")?.dataset.plSeason;
    if (season !== undefined) { playlistSeason = Number(season); return renderPlaylistView(); }
    const lang = event.target.closest("[data-pl-lang]")?.dataset.plLang;
    if (lang) { setSeriesLang(playlistById(openPlaylistId), lang); return renderVideos(); }
    const na = event.target.closest("[data-na-lang]");
    if (na) {
      const v = state.videos.find((x) => x.id === na.dataset.episodeId);
      const want = LANG_LABEL[seriesLang(playlistById(openPlaylistId))] || "ภาษาที่เลือก";
      if (v && await askConfirm(`${episodeLabel(v)} ยังไม่มี${want}\nดูแบบ${LANG_LABEL[v.lang] || "ภาษาอื่น"}ไปก่อนไหม?`)) openVideo(v);
      return;
    }
    if (event.target.closest("[data-ep-sort]")) { playlistDesc = !playlistDesc; setEpisodeSortDesc(playlistDesc); playlistRange = 0; return renderPlaylistView(); }
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
      else if (ytPlayer) { if (ytPaused()) ytPlayer.playVideo(); else ytPlayer.pauseVideo(); }
      else if (activeFbPlayer) activeFbPlayer.pause();
    } catch (e) { /* ตัวเล่น Facebook บางรุ่นไม่รับคำสั่ง */ }
    setTimeout(renderMiniPlay, 100);
  });
  el("#episodePrev").addEventListener("click", () => playEpisode(neighborEpisode(activeVideo, -1)));
  el("#episodeNext").addEventListener("click", () => playEpisode(neighborEpisode(activeVideo, 1)));
  el("#autoNextBtn").addEventListener("click", () => setAutoNextPref(!autoNextOn()));
  window.addEventListener("pagehide", () => { stopVideoClock(); saveActiveVideoProgress(true); });
  window.addEventListener("orientationchange", nudgeViewport);
  initFixedLayoutGuard();
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
  if (!video || !(await askConfirm(`ลบคลิป "${video.title}"?\n(ทุกคนจะไม่เห็นคลิปนี้อีก)`))) return;
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    await sendJSON("DELETE", `/api/videos/${encodeURIComponent(video.id)}`);
  } catch (e) {
    toast(e.message || "ลบคลิปไม่สำเร็จ", { error: true });
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
  el("#followHead").hidden = mode !== "grid" || !state.manga.length;
  renderMangaHome();
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
    const act = e.target.closest("[data-action]")?.dataset.action;
    if (act) runHistoryAction(item, act);
    else openChapterList(mangaById(item.id) || item);
  });
  el("#readHistorySearch").addEventListener("input", debounce(renderHistory, 150));
  try { el("#followSort").value = localStorage.getItem("followSort") || "updated"; } catch (e) { /* ค่าเริ่มต้น */ }
  el("#followSort").addEventListener("change", () => {
    try { localStorage.setItem("followSort", el("#followSort").value); } catch (e) { /* ไม่จำก็ได้ */ }
    renderGrid();
  });
  el("#mangaHome").addEventListener("click", (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const id = card.dataset.id;
    const h = state.history.find((x) => x.id === id);
    const heroAct = e.target.closest("[data-hero-action]")?.dataset.heroAction;
    if (heroAct && heroAct !== "open" && h) return runHistoryAction(h, heroAct);
    if (card.classList.contains("reading") && h) return resumeReading(h);
    openChapterList(mangaById(id) || h);
  });
}

async function loadHistory() {
  try {
    state.history = (await getJSON("/api/history")).items;
    renderHistory();
    renderMangaHome();
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

// ประวัติการอ่าน: แถวละเรื่อง แบ่งตามวัน — ปุ่มขวา อ่านต่อ / ต.ถัดไป › / ✓ (ทันตอนล่าสุด)
function renderHistory() {
  const q = el("#readHistorySearch").value.trim().toLowerCase();
  const all = withoutSpecial(state.history);
  const items = q ? all.filter((h) => h.name.toLowerCase().includes(q)) : all;
  el("#historyEmpty").hidden = items.length > 0;
  el("#historyEmpty").textContent = q ? "ไม่พบในประวัติการอ่าน" : "ยังไม่มีประวัติการอ่าน เปิดอ่านเรื่องไหนก็ตามจะขึ้นที่นี่";
  let label = "";
  el("#historyList").innerHTML = items.map((h) => {
    const day = h.last_read_at ? historyDayLabel(h.last_read_at) : "เก่ากว่านั้น";
    const head = day !== label ? `<li class="hist-day">${day}</li>` : "";
    label = day;
    const action = historyAction(h);
    const reading = action && action.kind === "resume";
    const meta = reading ? `${h.chapter_text || ""} · ค้าง ${Math.round(h.fraction * 100)}%`
      : action ? `จบ ${h.chapter_text || ""}` : `${h.chapter_text || ""}${h.chapter_url ? " · ล่าสุดแล้ว" : ""}`;
    const button = reading ? '<button class="btn hist-action" data-action="resume">อ่านต่อ</button>'
      : action ? `<button class="btn hist-action" data-action="next">${escapeHtml(shortChapter(h.next_chapter_text) || "ถัดไป")} ›</button>`
      : h.chapter_url ? '<span class="hist-done" aria-label="ทันตอนล่าสุดแล้ว">✓</span>' : "";
    return `${head}<li class="history-row" data-id="${escapeHtml(h.id)}">
        <img class="history-cover" src="${proxied(h.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
        <div class="history-info">
          <div class="history-name">${h.is_new ? `<span class="badge-up" title="มีตอนใหม่ที่ยังไม่อ่าน">${h.unread_count > 0 ? `+${h.unread_count}` : "ใหม่"}</span>` : ""}<span>${escapeHtml(h.name)}</span></div>
          <div class="history-chapter">${escapeHtml(meta)}</div>
          ${reading ? `<span class="lib-bar"><span style="width:${(h.fraction * 100).toFixed(1)}%"></span></span>` : ""}
        </div>${button}
      </li>`;
  }).join("");
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
// activeCategory: null = "ทั้งหมด" (แถวตามหัวข้อ + ตารางทุกเรื่อง), "__none" = อื่น ๆ (ไม่มีหมวด), อื่น ๆ = id หมวด
const NO_CATEGORY = "__none";
state.activeCategory = null;
state.catalogFollow = "all"; // ตัวกรองตาราง: all / yes (ติดตามอยู่) / no (ยังไม่ติดตาม)

function updateCategoryBar() {
  const show = state.tab === "catalog";
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
  // หน้าอ่านมังงะเป็นโทนมืดเสมอ — แถบสถานะของเครื่องต้องมืดตามด้วยตอนเปิดหน้าอ่าน
  const reader = el("#reader");
  const source = reader && !reader.hidden ? reader : document.documentElement;
  const color = getComputedStyle(source).getPropertyValue("--bg-elevated").trim();
  els('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
}

function renderThemeMenu() {
  const theme = currentTheme();
  el("#themeSeg").innerHTML = THEMES.map((t) =>
    `<button role="radio" aria-checked="${t.id === theme}" class="${t.id === theme ? "on" : ""}" data-theme="${t.id}">${t.id === "system" ? "อัตโนมัติ" : t.label.replace("โหมด", "")}</button>`).join("");
}

function initTheme() {
  renderThemeMenu();
  syncThemeColor();
  // โหมด "ตามอุปกรณ์": เครื่องสลับสว่าง/มืดเอง (เช่นตามเวลา) ต้องเปลี่ยนสีแถบสถานะตามด้วย
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", syncThemeColor);
  // บางเครื่อง/บางเบราว์เซอร์ไม่ยิง event ข้างบนตอนแอปอยู่เบื้องหลัง — เช็คซ้ำทุกครั้งที่กลับมาเปิด
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncThemeColor(); });
  el("#themeSeg").addEventListener("click", (e) => {
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
    savePref("theme", theme);
  });
}

// ค่าตั้งส่วนตัวที่ตามบัญชี (เก็บบนเซิร์ฟเวอร์) — ไม่ได้ login ใช้ค่าในเครื่องแทน
function savePref(key, value) {
  state.prefs[key] = value;
  fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) }).catch(() => {});
}

function renderPrefs() {
  el("#prefCard").hidden = !state.categories.some((c) => c.special);
  el("#showSpecialToggle").checked = showSpecial();
  el("#setChapterSort").value = chapterSortDesc() ? "desc" : "asc";
  el("#setAutoNext").checked = autoNextOn();
  el("#setVideoQuality").value = readVideoQualityPref();
  el("#setInstallRow").hidden = el("#installBtn").hidden;
}

function initPrefs() {
  renderPrefs();
  el("#setChapterSort").addEventListener("change", (e) => setChapterSortPref(e.target.value === "desc"));
  el("#setAutoNext").addEventListener("change", (e) => setAutoNextPref(e.target.checked));
  el("#setVideoQuality").addEventListener("change", (e) => {
    try { localStorage.setItem(VIDEO_QUALITY_KEY, e.target.value); } catch (err) { /* ไม่จำก็ได้ */ }
  });
  el("#setPushToggle").addEventListener("click", (e) => { e.preventDefault(); togglePush(); });
  el("#setInstallRow").addEventListener("click", () => el("#installBtn").click());
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

// เรื่องที่ไม่มีหมวด — มีชิป/แถว "อื่น ๆ" เฉพาะเมื่อบางเรื่องมีหมวดแล้ว (ไม่มีหมวดเลยทั้งระบบ = ซ้ำกับ "ทุกเรื่อง")
function uncategorized() {
  const visible = catalogVisible();
  const none = visible.filter((m) => !(m.categories || []).length);
  return none.length && none.length < visible.length ? none : [];
}

function renderCategoryChips() {
  const cats = visibleCategories();
  if (state.activeCategory && state.activeCategory !== NO_CATEGORY && !cats.some((c) => c.id === state.activeCategory)) state.activeCategory = null;
  const chips = [{ id: "", name: "ทั้งหมด" }, ...cats, ...(uncategorized().length ? [{ id: NO_CATEGORY, name: "อื่น ๆ" }] : [])];
  const html = chips
    .map((c) => `<button class="chip${c.id === (state.activeCategory || "") ? " active" : ""}" data-cat="${escapeHtml(c.id)}" role="tab">${escapeHtml(c.name)}</button>`)
    .join("");
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
  const pick = (e) => {
    const chip = e.target.closest(".chip[data-cat]");
    if (!chip) return;
    state.activeCategory = chip.dataset.cat || null;
    state.catalogFollow = "all";
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

// ประวัติคำค้นหา (8 คำล่าสุด) เก็บในค่าตั้งของบัญชี — ซิงค์ทุกเครื่องของคนเดียวกัน
const SEARCH_HISTORY_MAX = 8;
function searchHistory() {
  return Array.isArray(state.prefs.search_history) ? state.prefs.search_history : [];
}

function recordSearch(q) {
  q = q.trim().slice(0, 60);
  if (q.length < 2) return;
  const list = [q, ...searchHistory().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, SEARCH_HISTORY_MAX);
  savePref("search_history", list);
  renderSearchHistory();
}

function renderSearchHistory() {
  const list = searchHistory();
  el("#searchHistory").hidden = !list.length;
  el("#searchHistoryChips").innerHTML = list.map((q) =>
    `<span class="search-chip"><button type="button" class="search-chip-text" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button><button type="button" class="search-chip-x" data-remove="${escapeHtml(q)}" aria-label="ลบ ${escapeHtml(q)}">×</button></span>`).join("");
}

function initSearch() {
  el("#searchInput").addEventListener("input", debounce(renderSearch, 120));
  // กด "ค้นหา" บนแป้นมือถือ = ปิดแป้น ให้เห็นผลเต็มจอ (และจำคำค้นไว้)
  el("#searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { recordSearch(e.target.value); e.target.blur(); }
  });
  // แตะผลลัพธ์ = คำนี้ใช้ได้จริง จำไว้ด้วย (ส่วนใหญ่พิมพ์แล้วแตะผลเลย ไม่ได้กด Enter)
  el("#searchResults").addEventListener("click", (e) => {
    if (e.target.closest("[data-id], .video-card, .playlist-card")) recordSearch(el("#searchInput").value);
  }, true);
  el("#searchHistoryChips").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove]");
    if (remove) {
      savePref("search_history", searchHistory().filter((x) => x !== remove.dataset.remove));
      renderSearchHistory();
      return;
    }
    const chip = e.target.closest("[data-q]");
    if (!chip) return;
    el("#searchInput").value = chip.dataset.q;
    recordSearch(chip.dataset.q);
    renderSearch();
  });
  el("#searchHistoryClear").addEventListener("click", () => { savePref("search_history", []); renderSearchHistory(); });
  renderSearchHistory();
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
  el("#adminPage").classList.toggle("searching", words.length > 0); // ซ่อนฟอร์ม/ปุ่ม ให้ผลอยู่บนสุด
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
  }).observe(el("#adminPage"), { childList: true, subtree: true });
}

// ---------- หน้าตั้งค่า: ตั้งค่าของฉัน → ศูนย์จัดการ (แอดมิน) → หน้าจัดการย่อย ----------
function showSettingsPane(pane) {
  el("#settingsMain").hidden = pane !== "main";
  el("#adminHub").hidden = pane !== "hub";
  el("#adminPage").hidden = pane !== "page";
  window.scrollTo(0, 0);
  if (pane === "hub") renderAdminHub();
}

function settingsPane() {
  return !el("#adminPage").hidden ? "page" : !el("#adminHub").hidden ? "hub" : "main";
}

function openAdminPage(subtab, vm) {
  showSettingsPane("page");
  if (vm) setVmTab(vm);
  const btn = el(`.sub-tab-btn[data-subtab="${subtab}"]`);
  if (btn) btn.click(); // ใช้ตัวโหลดข้อมูลของแท็บย่อยเดิม
}

// การ์ดสรุป + ตัวเลขในศูนย์จัดการ + จุดเตือนที่แถว "จัดการระบบ"
async function renderAdminHub() {
  if (!state.catalog.length) await loadCatalog();
  const problems = state.catalog.filter((m) => m.refresh_error);
  const nocat = state.catalog.filter((m) => !(m.categories || []).length).length;
  const clips = state.videos.filter((v) => !v.playlist_id).length;
  const watch = playlistWatch && playlistWatch.last_result ? playlistWatch : await getJSON("/api/video-playlists/watch").catch(() => ({}));
  if (watch.sources) playlistWatch = watch;
  const watchErr = (watch.last_result || []).some((r) => r.error);
  let users = null;
  try { users = (await getJSON("/api/users")).length; } catch (e) { /* ไม่โชว์ตัวเลข */ }
  const card = (label, value, status, tone) => `<div class="admin-card"><div class="mm-meta">${label}</div><div class="admin-card-num">${value}</div>${status ? `<div class="admin-card-status"><span class="status-dot ${tone}"></span>${escapeHtml(status)}</div>` : ""}</div>`;
  el("#adminCards").innerHTML = [
    card("มังงะ", state.catalog.length, problems.length ? `มีปัญหา ${problems.length} เรื่อง` : "ปกติทุกเรื่อง", problems.length ? "bad" : "ok"),
    card("คลิป / Playlist", `${clips} / ${(state.videoPlaylists || []).length}`,
      watch.last_run ? `เช็คเพจ ${timeAgo(watch.last_run, "เมื่อสักครู่")}${watchErr ? " ⚠️" : ""}` : (watch.sources || []).length ? "ยังไม่เคยเช็คเพจ" : "", watchErr ? "warn" : "ok"),
    card("สมาชิก", users ?? "–", "", ""),
    card("หมวดหมู่มังงะ", state.categories.length, nocat ? `ไม่มีหมวด ${nocat} เรื่อง` : "", nocat ? "warn" : "ok"),
  ].join("");
  const counts = { manga: problems.length ? `${state.catalog.length} · ⚠️ ${problems.length}` : String(state.catalog.length), nocat: nocat ? `ไม่มีหมวด ${nocat}` : "", watch: watchErr ? "⚠️" : "", users: users ?? "",
    checked: state.catalog.length ? `ล่าสุด ${timeAgo(state.catalog.map((m) => m.last_checked_at || "").sort().pop(), "เมื่อสักครู่")}` : "" };
  els("[data-admin-count]").forEach((x) => { x.textContent = counts[x.dataset.adminCount] ?? ""; });
  el("#adminDot").hidden = !(problems.length || watchErr);
}

function initSettingsPanes() {
  el("#openAdminHub").addEventListener("click", () => showSettingsPane("hub"));
  els("[data-admin-back]").forEach((b) => b.addEventListener("click", () => showSettingsPane(b.dataset.adminBack)));
  el("#adminHub").addEventListener("click", (e) => {
    const row = e.target.closest("[data-admin-open]");
    if (row) openAdminPage(row.dataset.adminOpen, row.dataset.adminVm);
  });
  el("#adminHubSearch").addEventListener("click", () => {
    openAdminPage("mangaManage");
    el("#adminSearch").focus();
  });
  el("#adminRefreshAll").addEventListener("click", async () => {
    await refreshAll();
    await loadCatalog();
    renderAdminHub();
  });
  // จุดเตือนที่แถว "จัดการระบบ" — เช็คเงียบ ๆ ครั้งแรกที่เปิดหน้าตั้งค่า
  if (state.currentUser.is_admin) setTimeout(() => renderAdminHub().catch(() => {}), 1500);
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
let lastMangaLoadAt = Date.now(); // ข้อมูลชุดแรกฝังมากับหน้าเว็บ (BOOT)

async function loadManga() {
  try {
    state.manga = await getJSON("/api/manga");
    lastMangaLoadAt = Date.now();
    renderGrid();
  } catch (e) {
    // ใช้ข้อมูลเดิมที่วาดไว้แล้วต่อไป
  }
}

// หน้าหลักโหลดของใหม่เอง: กลับมาที่แอป (สลับแอป/ปลดล็อกจอ), กดแท็บหน้าหลัก, และทุก 5 นาทีที่เปิดค้าง
// — เซิร์ฟเวอร์เช็คตอนใหม่ทุก 30 นาทีอยู่แล้ว ฝั่งนี้แค่ดึงผลล่าสุด (เบา ไม่ยิงเว็บมังงะ)
function refreshHomeIfStale(maxAgeMs) {
  if (Date.now() - lastMangaLoadAt < maxAgeMs) return;
  lastMangaLoadAt = Date.now(); // กันยิงซ้อนระหว่างรอ
  loadManga();
  loadHistory();
}

function initHomeAutoRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.tab === "list") refreshHomeIfStale(30 * 1000);
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) refreshHomeIfStale(0); });
  setInterval(() => {
    if (!document.hidden && state.tab === "list" && el("#reader").hidden) refreshHomeIfStale(5 * 60 * 1000);
  }, 60 * 1000);
}

// ดึงหน้าลงที่บนสุดของหน้าหลัก/วิดีโอ = โหลดของใหม่ (เว็บแอปหน้าจอโฮมไม่มีปุ่มรีโหลด)
// ไม่เริ่มจากขอบซ้าย (ท่าปัดย้อนกลับ) และยกเลิกเมื่อลากไปทางข้างมากกว่าลงล่าง (แถวการ์ดเลื่อนข้าง)
const PULL_TRIGGER = 70;
function initPullToRefresh() {
  const ind = document.createElement("div");
  ind.className = "pull-refresh";
  ind.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M21 3v6h-6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.body.appendChild(ind);
  let startX = 0, startY = 0, pulling = false, dist = 0, busy = false;
  const reset = () => { ind.style.transform = ""; ind.style.opacity = ""; ind.classList.remove("ready"); };
  const canPull = () => (state.tab === "list" || state.tab === "videos") && window.scrollY <= 0 && document.body.style.overflow !== "hidden";
  window.addEventListener("touchstart", (e) => {
    pulling = false;
    if (busy || e.touches.length !== 1 || !canPull()) return;
    const t = e.touches[0];
    if (t.clientX < 30) return;
    startX = t.clientX; startY = t.clientY; dist = 0; pulling = true;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const t = e.touches[0];
    const dy = t.clientY - startY, dx = Math.abs(t.clientX - startX);
    if (dy <= 0 || dx > dy || window.scrollY > 0) { pulling = false; reset(); return; }
    dist = Math.min(dy * 0.5, 110);
    ind.style.opacity = String(Math.min(1, dist / PULL_TRIGGER));
    ind.style.transform = `translate(-50%, ${dist}px) rotate(${dist * 4}deg)`;
    ind.classList.toggle("ready", dist >= PULL_TRIGGER);
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    if (dist < PULL_TRIGGER) { reset(); return; }
    busy = true;
    ind.classList.add("spinning");
    ind.style.transform = `translate(-50%, ${PULL_TRIGGER}px)`;
    try {
      if (state.tab === "videos") await loadVideos();
      else await Promise.all([loadManga(), loadHistory()]);
    } finally {
      busy = false;
      ind.classList.remove("spinning");
      reset();
    }
  });
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

  el("#followHead").hidden = state.homeMode !== "grid" || !state.manga.length;
  el("#followTitle").textContent = `ติดตาม · ${state.manga.length}`;
  renderMangaHome();
  const sort = el("#followSort").value;
  const signature = JSON.stringify([
    sort,
    Math.floor(Date.now() / 600000), // "x ชั่วโมงที่แล้ว" ต้องขยับเองแม้ข้อมูลไม่เปลี่ยน
    ...state.manga.map((m) => [m.id, m.is_new, m.latest_chapter, m.cover_url, mangaDate(m)])]
  );
  if (signature === lastGridSignature) return;
  lastGridSignature = signature;

  const items = [...state.manga];
  if (sort === "name") items.sort((a, b) => a.name.localeCompare(b.name, "th"));
  else items.sort((a, b) => String(mangaDate(b) || "").localeCompare(String(mangaDate(a) || "")));
  grid.innerHTML = items
    // เวลาที่ตอนล่าสุดออก — เวลาเช็คดูได้ในหน้าแอดมิน
    .map((m) => cardHtml(m, `<div class="manga-chapter">${mangaDate(m) ? timeAgo(mangaDate(m), "เมื่อสักครู่") : "&nbsp;"}</div>`))
    .join("");
}

// เวลาที่ตอนล่าสุดออก: วันที่จากเว็บต้นทางก่อน ไม่มีค่อยใช้เวลาที่ระบบเจอตอนใหม่
// latest_chapter_date ของเว็บต้นทางมีแค่วันที่ (ไม่มีเวลา) และถ้าตอนล่าสุดยังไม่มีวันที่กำกับ จะได้วันที่ของ
// ตอนก่อนหน้าแทน (ตอนใหม่เมื่อเช้าเลยขึ้นว่า "2-3 วันที่แล้ว") → ใช้ค่าที่ใหม่กว่าระหว่างวันที่เว็บต้นทาง
// กับเวลาที่ระบบเจอตอนใหม่จริง (last_updated_at)
function mangaDate(m) {
  const source = m.latest_chapter_date, found = m.last_updated_at;
  if (!source || !found) return source || found || null;
  return new Date(found) >= new Date(source) ? found : source;
}

// "ตอนที่ 175" → "ต.175" (ไม่มีเลข = ข้อความเดิม)
function shortChapter(text) {
  const n = String(text || "").match(/(\d+(?:\.\d+)?)/);
  return n ? `ต.${n[1]}` : String(text || "");
}

// การ์ดปกแนวตั้งในแถวเลื่อนข้าง (หน้าหลัก/ทั้งหมด)
function coverRowTileHtml(m, { meta = "", badge = "", bar = 0, follow = false } = {}) {
  return `<div class="cover-tile mm-ctile" data-id="${escapeHtml(m.id)}"><span class="mm-cthumb"><img src="${proxied(m.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />${badge}${follow ? followDotHtml(m) : ""}${bar ? `<span class="video-progress"><span style="width:${Math.min(100, Math.max(3, bar * 100)).toFixed(1)}%"></span></span>` : ""}</span>
    <div class="cover-tile-name">${escapeHtml(m.name)}</div>${meta ? `<div class="mm-meta">${escapeHtml(meta)}</div>` : ""}</div>`;
}

function followDotHtml(m) {
  return `<button class="follow-dot${m.is_subscribed ? " on" : ""}" data-action="toggle-follow" aria-label="${m.is_subscribed ? "เลิกติดตาม" : "ติดตาม"}">${m.is_subscribed ? "✓" : "+"}</button>`;
}

// ปุ่มหลักของเรื่องจากประวัติ: ค้างกลางตอน = อ่านต่อ, อ่านจบตอน = ตอนถัดไป, ทันตอนล่าสุด = ไม่มี
function historyAction(h) {
  if (!h || !h.chapter_url) return null;
  if (h.fraction > 0 && h.fraction < 0.95) return { kind: "resume", label: `อ่านต่อ ${h.chapter_text || ""}`.trim() };
  if (h.next_chapter_url) return { kind: "next", label: `อ่าน ${h.next_chapter_text || "ตอนถัดไป"}` };
  return null;
}

function runHistoryAction(h, kind) {
  if (kind === "resume") return resumeReading(h);
  if (kind === "next" && h.next_chapter_url) return resumeReading({ ...h, chapter_url: h.next_chapter_url, chapter_text: h.next_chapter_text, fraction: null });
}

// ---------- หน้าหลักมังงะ: การ์ดอ่านต่อ + มีตอนใหม่ + อ่านค้างไว้ ----------
function renderMangaHome() {
  const box = el("#mangaHome");
  box.hidden = state.homeMode !== "grid";
  if (box.hidden) return;
  const byDate = (a, b) => String(mangaDate(b) || "").localeCompare(String(mangaDate(a) || ""));
  const fresh = state.manga.filter((m) => m.is_new).sort(byDate);
  const history = withoutSpecial(state.history);
  const reading = history.filter((h) => h.chapter_url && h.fraction > 0 && h.fraction < 0.95).slice(0, 12);
  const parts = [];
  // การ์ดอ่านต่อ: เรื่องที่กำลังตามอ่านและมีตอนใหม่ → เรื่องที่อ่านค้างกลางตอน → เรื่องที่มีตอนใหม่ → อ่านล่าสุด
  const pick = fresh.find((m) => history.some((h) => h.id === m.id)) || reading[0] || fresh[0] || history[0];
  const heroManga = pick && (mangaById(pick.id) || pick);
  if (heroManga) {
    const h = history.find((x) => x.id === heroManga.id);
    const action = historyAction(h);
    const date = mangaDate(heroManga);
    const meta = heroManga.is_new
      ? `${heroManga.latest_chapter || "ตอนใหม่"} มาแล้ว${date ? ` · ${timeAgo(date, "เมื่อสักครู่")}` : ""}`
      : h ? `${h.chapter_text || ""} · ${readAgo(h.last_read_at)}` : "";
    parts.push(`<div class="mh-hero" data-id="${escapeHtml(heroManga.id)}">
      <span class="mh-cover"><img src="${proxied(heroManga.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />${heroManga.is_new ? '<span class="new-badge">NEW EP</span>' : ""}</span>
      <span class="mh-info"><span class="mh-name">${escapeHtml(heroManga.name)}</span><span class="mm-meta">${escapeHtml(meta)}</span>
        ${h && h.fraction ? `<span class="lib-bar"><span style="width:${(h.fraction * 100).toFixed(1)}%"></span></span>` : ""}
        <button class="btn primary" data-hero-action="${action ? action.kind : "open"}">${escapeHtml(action ? action.label : "เปิดเรื่อง")}</button></span></div>`);
  }
  if (fresh.length) {
    parts.push(homeRowHtml(`มีตอนใหม่ · ${fresh.length}`, fresh.map((m) => coverRowTileHtml(m, {
      badge: `<span class="new-badge">${m.unread_count > 0 ? `+${m.unread_count}` : "NEW EP"}</span>`,
      meta: `${shortChapter(m.latest_chapter)}${mangaDate(m) ? ` · ${timeAgo(mangaDate(m), "เมื่อสักครู่")}` : ""}`,
    })).join(""), "", "mm-row covers"));
  }
  if (reading.length) {
    parts.push(homeRowHtml("อ่านค้างไว้", reading.map((h) => coverRowTileHtml(h, {
      bar: h.fraction, meta: `${shortChapter(h.chapter_text)} · ${Math.round(h.fraction * 100)}%`,
    }).replace("mm-ctile", "mm-ctile reading")).join(""), "", "mm-row covers"));
  }
  box.innerHTML = parts.join("");
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
  ["#catalogGrid", "#catalogHome", "#searchGrid", "#popularRow", "#recentRow"].forEach((sel) => el(sel).addEventListener("click", onCatalogClick));
  // "ทั้งหมด ›" ของแถว: หมวด = เปิดหมวดนั้น, อื่น ๆ = เลื่อนลงตาราง "ทุกเรื่อง" พร้อมตั้งเรียง/ตัวกรอง
  el("#catalogHome").addEventListener("click", (e) => {
    const cat = e.target.closest("[data-cat-jump]")?.dataset.catJump;
    const jump = e.target.closest("[data-grid-jump]")?.dataset.gridJump;
    if (!cat && !jump) return;
    e.stopPropagation();
    if (cat) {
      state.activeCategory = cat;
      state.catalogFollow = "all";
      renderCategoryChips();
      renderCatalog(filterCatalog());
      return window.scrollTo(0, 0);
    }
    if (jump === "no") state.catalogFollow = "no";
    else { state.catalogFollow = "all"; el("#catalogSort").value = jump; }
    renderCatalog(filterCatalog());
    el("#catalogGridTitle").scrollIntoView({ block: "start", behavior: "smooth" });
  }, true);
  el("#catalogFilters").addEventListener("click", (e) => {
    const f = e.target.closest("[data-follow-filter]")?.dataset.followFilter;
    if (!f) return;
    state.catalogFollow = f;
    renderCatalog(filterCatalog());
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
    if (data.busy) {
      status.textContent = "รอบดึงอัตโนมัติกำลังทำงานอยู่ ลองใหม่อีกสักครู่";
      return;
    }
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
let mangaAdminFilter = "all"; // all / problem (ดึงไม่สำเร็จทุกแหล่ง) / nocat (ไม่มีหมวด)

function renderSettings() {
  const list = el("#settingsList");
  const problems = state.catalog.filter((m) => m.refresh_error).length;
  const nocat = state.catalog.filter((m) => !(m.categories || []).length).length;
  els("[data-manga-filter]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mangaFilter === mangaAdminFilter);
    const n = { all: state.catalog.length, problem: problems, nocat }[b.dataset.mangaFilter];
    b.textContent = `${{ all: "ทั้งหมด", problem: "มีปัญหา", nocat: "ไม่มีหมวด" }[b.dataset.mangaFilter]} ${n}`;
  });
  const items = state.catalog.filter((m) => mangaAdminFilter === "problem" ? m.refresh_error
    : mangaAdminFilter === "nocat" ? !(m.categories || []).length : true);
  const signature = JSON.stringify([mangaAdminFilter, Math.floor(Date.now() / 600000), items.map((m) => [m.id, m.name, m.source, m.latest_chapter, m.cover_url, (m.sources || []).length, m.refresh_error, m.last_checked_at])]);
  if (signature === lastSettingsSignature) return;
  lastSettingsSignature = signature;

  list.innerHTML = items
    .map((m) => {
      const sourceCount = (m.sources || []).length;
      const sourceLabel =
        sourceCount > 1 ? `${escapeHtml(m.source)} +${sourceCount - 1} แหล่ง` : escapeHtml(m.source);
      const status = m.refresh_error
        ? `<span class="status-dot bad"></span><span class="status-bad">ดึงไม่สำเร็จทุกแหล่ง ตั้งแต่ ${timeAgo(m.refresh_error.since || m.refresh_error.at, "เมื่อสักครู่")}</span>`
        : `<span class="status-dot ok"></span>${m.last_checked_at ? `เช็ค ${timeAgo(m.last_checked_at, "เมื่อสักครู่")}` : "ยังไม่เคยเช็ค"}`;
      return `
        <li class="settings-row" data-id="${escapeHtml(m.id)}">
          <img src="${proxied(m.cover_url, THUMB_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />
          <div class="grow">
            <div class="name">${escapeHtml(m.name)}</div>
            <div class="meta">${sourceLabel} — ${m.latest_chapter ? escapeHtml(m.latest_chapter) : "-"}</div>
            <div class="meta row-status">${status}</div>
          </div>
          <button class="icon-btn" data-action="menu" title="ตัวเลือก" aria-label="ตัวเลือก">⋯</button>
          <div class="row-menu" hidden>
            <button class="btn" data-action="edit">${ICON_EDIT} แก้ไข</button>
            <button class="btn" data-action="refresh">${ICON_REFRESH} รีเฟรช</button>
            <button class="btn danger" data-action="delete">${ICON_DELETE} ลบเรื่อง</button>
          </div>
        </li>`;
    })
    .join("") || '<li class="hint">ไม่มีเรื่องตามตัวกรองนี้</li>';
}

function initSettingsClicks() {
  el("#mangaAdminFilters").addEventListener("click", (e) => {
    const f = e.target.closest("[data-manga-filter]")?.dataset.mangaFilter;
    if (!f) return;
    mangaAdminFilter = f;
    renderSettings();
  });
  el("#settingsList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const row = e.target.closest(".settings-row");
    const id = row.dataset.id;
    const manga = state.catalog.find((m) => m.id === id);
    if (!manga) return;
    if (btn.dataset.action === "menu") {
      const menu = row.querySelector(".row-menu");
      const open = menu.hidden;
      els("#settingsList .row-menu").forEach((m) => { m.hidden = true; });
      menu.hidden = !open;
      return;
    }
    row.querySelector(".row-menu").hidden = true;
    if (btn.dataset.action === "refresh") row.querySelector(".row-status").textContent = "กำลังรีเฟรช...";
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
  if (!(await askConfirm(`ลบ "${name}" ออกจากระบบ? (ทุกคนจะติดตามไม่ได้อีก)`))) return;
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
  const date = mangaDate(m);
  return cardHtml(m, `${followDotHtml(m)}<div class="manga-chapter">${date ? timeAgo(date, "เมื่อสักครู่") : "&nbsp;"}</div>`);
}

// หน้า "ทั้งหมด" แบบแถว: อัปเดตล่าสุด / ยอดนิยม / แต่ละหมวด / อื่น ๆ / ยังไม่ได้ติดตาม
const CATALOG_ROW_LIMIT = 10;
function renderCatalogHome() {
  const box = el("#catalogHome");
  box.hidden = !!state.activeCategory;
  if (box.hidden) return;
  const all = catalogVisible();
  const byDate = [...all].sort((a, b) => String(mangaDate(b) || "").localeCompare(String(mangaDate(a) || "")));
  const tile = (m, opts = {}) => coverRowTileHtml(m, { follow: true, ...opts });
  const dated = (m) => `${shortChapter(m.latest_chapter)}${mangaDate(m) ? ` · ${timeAgo(mangaDate(m), "เมื่อสักครู่")}` : ""}`;
  const more = (label, attrs) => `<button class="link-btn mm-more" ${attrs}>${label} ›</button>`;
  const parts = [];
  if (byDate.length) parts.push(homeRowHtml("อัปเดตล่าสุด", byDate.slice(0, CATALOG_ROW_LIMIT).map((m) => tile(m, { meta: dated(m) })).join(""), more("ทั้งหมด", 'data-grid-jump="updated"'), "mm-row covers"));
  const popular = all.filter((m) => m.followers > 0).sort((a, b) => b.followers - a.followers).slice(0, CATALOG_ROW_LIMIT);
  if (popular.length) parts.push(homeRowHtml("ยอดนิยม", popular.map((m, i) => tile(m, { meta: `👥 ${m.followers} คน`, badge: `<span class="rank-badge">#${i + 1}</span>` })).join(""), more("ทั้งหมด", 'data-grid-jump="popular"'), "mm-row covers"));
  for (const c of visibleCategories()) {
    const inCat = all.filter((m) => (m.categories || []).includes(c.id));
    if (inCat.length) parts.push(homeRowHtml(escapeHtml(c.name), inCat.slice(0, CATALOG_ROW_LIMIT).map((m) => tile(m, { meta: dated(m) })).join(""), more(`ทั้งหมด ${inCat.length}`, `data-cat-jump="${escapeHtml(c.id)}"`), "mm-row covers"));
  }
  const none = uncategorized();
  if (none.length) parts.push(homeRowHtml("อื่น ๆ", none.slice(0, CATALOG_ROW_LIMIT).map((m) => tile(m, { meta: dated(m) })).join(""), more(`ทั้งหมด ${none.length}`, `data-cat-jump="${NO_CATEGORY}"`), "mm-row covers"));
  const unfollowed = byDate.filter((m) => !m.is_subscribed);
  if (unfollowed.length) parts.push(homeRowHtml(`ยังไม่ได้ติดตาม · ${unfollowed.length}`, unfollowed.slice(0, CATALOG_ROW_LIMIT).map((m) => tile(m, { meta: dated(m) })).join(""), more("ทั้งหมด", 'data-grid-jump="no"'), "mm-row covers"));
  box.innerHTML = parts.join("");
}

function renderCatalog(items = state.catalog) {
  const grid = el("#catalogGrid");
  const empty = el("#catalogEmpty");
  empty.hidden = items.length > 0;
  empty.textContent = state.catalogFollow !== "all" ? "ไม่มีเรื่องตามตัวกรองนี้"
    : state.activeCategory ? "หมวดนี้ยังไม่มีเรื่อง" : "ยังไม่มีเรื่องในระบบเลย";
  renderCatalogHome();
  const cat = state.activeCategory;
  const catName = cat === NO_CATEGORY ? "อื่น ๆ" : (state.categories.find((c) => c.id === cat) || {}).name;
  el("#catalogGridTitle").textContent = cat ? `${catName || "หมวด"} · ${items.length} เรื่อง` : `ทุกเรื่อง · ${items.length}`;
  els("[data-follow-filter]").forEach((b) => b.classList.toggle("active", b.dataset.followFilter === state.catalogFollow));

  const signature = JSON.stringify([Math.floor(Date.now() / 600000), items.map((m) => [m.id, m.is_subscribed, m.latest_chapter, m.cover_url])]);
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
  const cat = state.activeCategory;
  let items = catalogVisible();
  if (cat === NO_CATEGORY) items = items.filter((m) => !(m.categories || []).length);
  else if (cat) items = items.filter((m) => (m.categories || []).includes(cat));
  if (state.catalogFollow !== "all") items = items.filter((m) => m.is_subscribed === (state.catalogFollow === "yes"));
  return sortCatalog(items);
}

function sortCatalog(items) {
  const mode = el("#catalogSort").value;
  const sorted = [...items];
  if (mode === "name-asc") {
    sorted.sort((a, b) => a.name.localeCompare(b.name, "th"));
  } else if (mode === "name-desc") {
    sorted.sort((a, b) => b.name.localeCompare(a.name, "th"));
  } else if (mode === "popular") {
    sorted.sort((a, b) => (b.followers || 0) - (a.followers || 0) || a.name.localeCompare(b.name, "th"));
  } else if (mode === "updated") {
    // ใช้วันที่ตอนล่าสุดจริงจากเว็บต้นทางก่อน (latest_chapter_date) ไม่ใช่เวลาที่ระบบเรามาเช็คเจอ
    // (last_updated_at) เพราะเรื่องที่พึ่งเพิ่มเข้าระบบจะโดนตราว่า "อัพเดตตอนนี้เลย" ทั้งที่ตอน
    // ล่าสุดของเรื่องนั้นอาจลงมานานแล้วก็ได้ ใช้ last_updated_at เป็น fallback เผื่อเว็บนั้นไม่มี
    // วันที่ให้แปลงได้
    const key = (m) => { const d = mangaDate(m); return d ? new Date(d).toISOString() : ""; };
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
  let res;
  try {
    res = await fetchWithTimeout(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }, 60000);
  } catch (e) {
    throw new Error(e.body?.error || "บันทึกไม่สำเร็จ");
  }
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
        if (!(await askConfirm(`ลบหมวด "${cat.name}"? (เรื่องในหมวดนี้ไม่ถูกลบ แค่ไม่อยู่ในหมวดนี้แล้ว)`))) return;
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
    if (!(await askConfirm(`รีเซ็ตรหัสผ่านของ "${username}"?\n\nระบบจะสุ่มรหัสชั่วคราวให้ ส่งรหัสนั้นให้สมาชิก แล้วสมาชิกต้องเปลี่ยนรหัสเองที่หน้าตั้งค่า (ทุกเครื่องของสมาชิกคนนี้จะต้อง login ใหม่)`))) return;
    const msg = el("#addUserMsg");
    try {
      const data = await sendJSON("POST", `/api/users/${encodeURIComponent(username)}/reset_password`);
      msg.className = "form-msg success";
      msg.textContent = `รหัสชั่วคราวของ "${username}": ${data.temp_password} (จดไว้ส่งให้สมาชิก — จะไม่แสดงอีก)`;
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

function openChapterList(manga) {
  if (!manga) return;
  readerFromHistory = false;
  currentManga = { id: manga.id, name: manga.name, latest_chapter_url: manga.latest_chapter_url };
  const view = el("#chapterListView");
  view.hidden = false;
  document.body.style.overflow = "hidden";
  el("#chapterListMangaName").textContent = manga.name;
  el("#chapterSearch").value = "";
  chapterRange = null;
  chapterDesc = chapterSortDesc();

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
    if (!currentManga || currentManga.id !== mangaId) return; // เปลี่ยนเรื่องไปแล้ว ห้ามเอา error มาทับ
    if (currentChapters.length > 0) return; // มีของเดิมโชว์อยู่แล้ว ไม่ต้องล้างทิ้งเพราะเน็ตสะดุด
    currentChapters = [];
    body.innerHTML = `<div class="reader-msg">${escapeHtml(e.body?.error || "โหลดไม่สำเร็จ")}<br><br><button class="btn primary" id="chapterListRetry">ลองใหม่</button></div>`;
    el("#chapterListRetry").addEventListener("click", () => {
      body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
      renderChapterList();
    });
  }
}

// ---------- หน้าเรื่อง: หัวเรื่อง + ปุ่มอ่านต่อ/ติดตาม + ตารางเลขตอน ----------
const CHAPTER_RANGE = 100;
let chapterRange = null; // null = ช่วงที่มีตอนอ่านต่อ (คำนวณตอนวาด)
// เรียงตอน: ค่าเริ่มต้น "ล่าสุดก่อน" จำต่อเครื่องและใช้กับทุกเรื่อง
const CHAPTER_SORT_KEY = "chapterSort";
function chapterSortDesc() {
  if (state.prefs.chapter_sort) return state.prefs.chapter_sort !== "asc"; // ตามบัญชี
  try { return localStorage.getItem(CHAPTER_SORT_KEY) !== "asc"; } catch (e) { return true; }
}

function setChapterSortPref(desc) {
  try { localStorage.setItem(CHAPTER_SORT_KEY, desc ? "desc" : "asc"); } catch (err) { /* ไม่จำก็ได้ */ }
  savePref("chapter_sort", desc ? "desc" : "asc");
  el("#setChapterSort").value = desc ? "desc" : "asc";
}
let chapterDesc = chapterSortDesc();
let lastChapterRowsSignature = null;

// ตอนที่จะเปิดเมื่อกด "อ่านต่อ": ค้างกลางตอน = ตอนนั้น, อ่านจบ = ตอนถัดไป, ไม่เคยอ่าน = ตอนแรก
function chapterResume(all) {
  const idx = lastReadUrl ? all.findIndex((c) => c.url === lastReadUrl) : -1;
  if (idx < 0) return { chapter: all[all.length - 1], label: "เริ่มอ่าน" };
  const inProgress = lastScrollInfo && lastScrollInfo.url === lastReadUrl && lastScrollInfo.fraction > 0;
  if (inProgress || idx === 0) return { chapter: all[idx], label: inProgress ? "อ่านต่อ" : "อ่านอีกครั้ง" };
  return { chapter: all[idx - 1], label: "อ่านต่อ" };
}

function chapterTileHtml(c, { fresh = false } = {}) {
  // ป้าย "อ่านถึง" ติดตอนล่าสุดที่อ่านเสมอ (อ่านจบแล้วก็ยังติด) — แถบความคืบหน้าเฉพาะตอนที่อ่านค้าง
  const last = !!lastReadUrl && c.url === lastReadUrl;
  const cur = last && lastScrollInfo && lastScrollInfo.url === c.url && lastScrollInfo.fraction > 0;
  const done = c.is_read && !last;
  const label = c.num !== null && c.num !== undefined ? String(c.num) : c.text;
  const cls = ["ep-tile", done ? "done" : "", last ? "cur" : "", c.num === null || c.num === undefined ? "has-sub" : ""].filter(Boolean).join(" ");
  return `<button class="${cls}" data-url="${escapeHtml(c.url)}" title="${escapeHtml(c.text)}${c.date ? ` · ${escapeHtml(c.date)}` : ""}">${last ? '<span class="ep-here">อ่านถึง</span>' : ""}<span class="ep-num">${escapeHtml(label)}</span>${done ? '<span class="ep-check" aria-label="อ่านแล้ว">✓</span>' : ""}${fresh && !last ? '<span class="ep-new">NEW</span>' : ""}${cur ? `<span class="ep-pg" style="width:${(lastScrollInfo.fraction * 100).toFixed(1)}%"></span>` : ""}</button>`;
}

function mangaSubscribed(id) {
  const fromCatalog = state.catalog.find((m) => m.id === id);
  return fromCatalog ? fromCatalog.is_subscribed : state.manga.some((m) => m.id === id);
}

// chapters = ตอนที่จะแสดง (ทั้งหมด หรือที่ตรงกับช่องค้นหา) — คืน true ถ้าวาดใหม่
function renderChapterRows(chapters) {
  const body = el("#chapterListBody");
  const all = currentChapters;
  const searching = chapters !== all;
  if (chapters.length === 0) {
    lastChapterRowsSignature = null;
    body.innerHTML = '<div class="reader-msg">ไม่พบตอนที่ค้นหา</div>';
    return true;
  }
  const m = mangaById(currentManga.id) || currentManga;
  const subscribed = mangaSubscribed(currentManga.id);
  const signature = JSON.stringify([lastReadUrl, lastScrollInfo, chapterRange, chapterDesc, searching, subscribed, chapters.map((c) => [c.url, c.is_read])]);
  if (signature === lastChapterRowsSignature) return false;
  lastChapterRowsSignature = signature;

  const readCount = all.filter((c) => c.is_read).length;
  const newestRead = all.findIndex((c) => c.is_read);
  const freshUrls = new Set(newestRead > 0 ? all.slice(0, newestRead).map((c) => c.url) : []);
  const resume = chapterResume(all);
  // ตารางเรียงเก่า→ใหม่ (ค่าเริ่มต้น) แบ่งช่วงละ 100 ตอน เปิดมาที่ช่วงของตอนอ่านต่อ
  const ordered = chapterDesc ? chapters : [...chapters].reverse();
  const ranges = Math.ceil(ordered.length / CHAPTER_RANGE);
  if (searching) chapterRange = 0;
  else if (chapterRange === null) chapterRange = Math.max(0, Math.floor(ordered.indexOf(resume.chapter) / CHAPTER_RANGE));
  chapterRange = Math.min(chapterRange, ranges - 1);
  const label = (c) => (c.num !== null && c.num !== undefined ? c.num : c.text);
  const chips = ranges > 1 ? Array.from({ length: ranges }, (_, i) => {
    const part = ordered.slice(i * CHAPTER_RANGE, (i + 1) * CHAPTER_RANGE);
    return `<button class="video-chip${i === chapterRange ? " active" : ""}" data-ch-range="${i}">${escapeHtml(String(label(part[0])))}${part.length > 1 ? `–${escapeHtml(String(label(part[part.length - 1])))}` : ""}</button>`;
  }).join("") : "";
  const tiles = ordered.slice(chapterRange * CHAPTER_RANGE, (chapterRange + 1) * CHAPTER_RANGE)
    .map((c) => chapterTileHtml(c, { fresh: freshUrls.has(c.url) })).join("");
  const sources = (m.sources || []).length;
  const date = mangaDate(m);
  const head = searching ? "" : `<div class="ch-head">
      ${m.cover_url ? `<img class="ch-cover" src="${proxied(m.cover_url, COVER_WIDTH)}" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0" />` : ""}
      <div class="ch-info">
        <div class="pl-name">${escapeHtml(m.name || "")}</div>
        ${m.source ? `<div class="pl-meta">${escapeHtml(m.source)}${sources > 1 ? ` +${sources - 1} แหล่ง` : ""}</div>` : ""}
        <div class="pl-meta">${all.length} ตอน${date ? ` · ตอนใหม่ ${timeAgo(date, "เมื่อสักครู่")}` : ""}</div>
        <div class="pl-meta">อ่านไป ${readCount}/${all.length}</div>
        <div class="lib-bar"><span style="width:${((readCount / all.length) * 100).toFixed(1)}%"></span></div>
      </div></div>
    <div class="pl-actions"><button class="btn primary" data-url="${escapeHtml(resume.chapter.url)}">▶ ${resume.label} ${escapeHtml(resume.chapter.text)}</button>
      <button class="btn video-save-btn${subscribed ? " saved" : ""}" data-ch-follow>${subscribed ? "✓ ติดตาม" : "+ ติดตาม"}</button></div>`;
  body.innerHTML = `${head}<div class="pl-controls">${chips}${searching ? "" : `<button class="video-chip" data-ch-sort>${chapterDesc ? "ล่าสุดก่อน" : "ตอนแรกก่อน"} ⇅</button>`}</div>
    <div class="ep-grid ch-grid">${tiles}</div>`;
  return true;
}

// เปิดหน้าเรื่องแล้วอยู่บนสุด (มีปุ่มอ่านต่อ + เปิดช่วงตอนที่อ่านค้างให้แล้ว)
function scrollToLastRead() {
  el("#chapterListBody").scrollTop = 0;
}

function initChapterListClicks() {
  el("#chapterListBody").addEventListener("click", async (e) => {
    const range = e.target.closest("[data-ch-range]")?.dataset.chRange;
    if (range !== undefined) { chapterRange = Number(range); return renderChapterRows(currentChapters); }
    if (e.target.closest("[data-ch-sort]")) {
      chapterDesc = !chapterDesc;
      setChapterSortPref(chapterDesc);
      chapterRange = null;
      return renderChapterRows(currentChapters);
    }
    if (e.target.closest("[data-ch-follow]")) {
      if (!state.catalog.length) await loadCatalog();
      const item = state.catalog.find((m) => m.id === currentManga?.id);
      if (item) { await toggleSubscribe(item); renderChapterRows(currentChapters); }
      return;
    }
    const row = e.target.closest("[data-url]");
    if (row) openReader(row.dataset.url);
  });
}

function initChapterSearch() {
  el("#chapterSearch").addEventListener(
    "input",
    debounce((e) => {
      const q = e.target.value.trim();
      if (!q) chapterRange = null; // ล้างช่องค้นหา = กลับไปช่วงของตอนอ่านต่อ
      renderChapterRows(q ? currentChapters.filter((c) => c.text.includes(q)) : currentChapters);
    }, 120)
  );
}

function closeChapterList() {
  const view = el("#chapterListView");
  view.hidden = true;
  // เปิดซ้อนมาจากหน้าอ่าน: ปิดแล้วกลับไปหน้าอ่านเดิม ไม่ล้างสถานะของเรื่องที่อ่านอยู่
  if (view.classList.contains("over-reader")) {
    view.classList.remove("over-reader");
    if (!el("#reader").hidden) return;
  }
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
  el("#chapterListView").classList.remove("over-reader");
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
    const data = await getJSON(`/api/manga/${mangaId}/chapter?url=${encodeURIComponent(url)}&peek=1`, { timeout: 60000 });
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
    const data = await getJSON(`/api/manga/${readerMangaId}/chapter?url=${encodeURIComponent(url)}&peek=1`, { timeout: 60000 });
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
  // การ์ดจบตอน (id nextHint เดิม: รูปแทรกก่อนการ์ดเสมอ, checkAutoAdvance ใส่ .show ตอนถึงล่างสุด)
  // การเลื่อนต่อเพื่อเปลี่ยนตอนยังทำงานแบบเดิม การ์ดแค่เพิ่มปุ่มให้กด
  if (data.images && data.images.length) {
    const card = document.createElement("div");
    card.className = "end-card";
    card.id = "nextHint";
    const curText = el("#readerChapterName").textContent;
    const next = data.next_url && currentChapters.find((c) => c.url === data.next_url);
    const nextText = data.next_url ? (next ? next.text : "ตอนถัดไป") : "";
    card.innerHTML = `<div class="end-title">จบ ${escapeHtml(curText || "ตอนนี้")}</div>
      ${data.next_url
        ? `<div class="end-meta">${escapeHtml(nextText)}${next && next.date ? ` · ${escapeHtml(next.date)}` : ""}</div><button class="btn primary end-next">อ่าน ${escapeHtml(nextText)} ›</button>`
        : '<div class="end-meta">อ่านทันตอนล่าสุดแล้ว</div>'}
      <div class="end-actions"><button class="btn end-list">☰ รายการตอน</button><button class="btn end-comments">💬 คอมเมนต์</button></div>
      ${data.next_url ? '<div class="end-hint">หรือเลื่อนต่ออีกทีเพื่อไปตอนถัดไป ›</div>' : ""}`;
    body.appendChild(card);
  }
  updateReaderProgress();
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

let chapterLoadSeq = 0;

async function loadChapter(mangaId, chapterUrl, restoreFraction = null) {
  const reader = el("#reader");
  const body = el("#readerBody");
  const topbar = el("#readerTopbar");
  const bottombar = el("#readerBottombar");
  reader.hidden = false;
  syncThemeColor();
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
    chapterLoadSeq++;
    renderChapter(prefetched, chapterUrl, restoreFraction);
    autoAdvancing = false;
    fetch(`/api/manga/${mangaId}/chapter?url=${encodeURIComponent(chapterUrl)}`).catch(() => {});
    prefetchNextChapter();
    return;
  }

  body.innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  const qs = chapterUrl ? `?url=${encodeURIComponent(chapterUrl)}` : "";
  // กดเปลี่ยนตอนรัว ๆ / ปิดหน้าอ่านระหว่างรอ: คำตอบของคำขอเก่าห้ามมาวาดทับตอนใหม่ (ตำแหน่งอ่านจะบันทึกผิดตอน)
  const seq = ++chapterLoadSeq;
  try {
    // เซิร์ฟเวอร์อาจไล่ลองหลายแหล่งก่อนตอบ ให้เวลามากกว่าคำขอทั่วไป
    const data = await getJSON(`/api/manga/${mangaId}/chapter${qs}`, { timeout: 60000 });
    if (seq !== chapterLoadSeq || reader.hidden) return;
    renderChapter(data, chapterUrl, restoreFraction);
  } catch (e) {
    if (seq !== chapterLoadSeq || reader.hidden) return;
    showChapterError(e.body?.error || String(e), mangaId, chapterUrl, restoreFraction);
  } finally {
    if (seq === chapterLoadSeq) autoAdvancing = false;
  }
}

// เช็คทุกครั้งที่เลื่อน ว่าถึงล่างสุดของตอนที่กำลังอ่านจริง ๆ หรือยัง ถ้าถึงแล้วโชว์ข้อความ
// "เลื่อนต่ออีกทีเพื่อไปตอนถัดไป" ไว้ก่อน ยังไม่เปลี่ยนตอนทันที ต้องรอ confirm อีกจังหวะ
// (กันเปลี่ยนตอนเร็วเกินไปทั้งที่ยังอ่านหน้าสุดท้ายไม่จบ)
// เปิดตอนไม่สำเร็จ: บอกสั้น ๆ ว่าเกิดอะไร + ลองใหม่/รายการตอน (รายละเอียดเทคนิคพับไว้)
// แถบล่างเปลี่ยนเป็นชื่อตอนที่กำลังเปิด ไม่ค้างชื่อตอนก่อนหน้า
function showChapterError(raw, mangaId, chapterUrl, restoreFraction) {
  el("#readerChapterName").textContent = findChapterText(chapterUrl) || "";
  const parts = String(raw).split(" | ");
  const codes = [...new Set((String(raw).match(/\b(5\d\d)\b/g) || []))];
  const down = codes.length > 0 && parts.every((p) => /\b5\d\d\b|timed? ?out|timeout|ล่ม|connection/i.test(p));
  const title = down
    ? `เว็บต้นทางล่มอยู่${parts.length > 1 ? `ทั้ง ${parts.length} แหล่ง` : ""} (${codes.join(", ")})`
    : "เปิดตอนนี้ไม่สำเร็จ";
  const hint = down ? "ปัญหาอยู่ที่เว็บมังงะ ไม่ใช่ที่แอป ลองใหม่อีกครั้งภายหลัง" : "ลองใหม่อีกครั้ง ถ้ายังไม่ได้ลองเปิดตอนอื่นก่อน";
  el("#readerBody").innerHTML = `<div class="reader-error">
    <div class="end-title">${escapeHtml(title)}</div><div class="end-meta">${escapeHtml(hint)}</div>
    <div class="end-actions"><button class="btn primary" data-retry-chapter>ลองใหม่</button><button class="btn end-list">☰ รายการตอน</button></div>
    <details><summary>รายละเอียด</summary><div class="reader-error-raw">${escapeHtml(raw)}</div></details></div>`;
  el("#readerBody").querySelector("[data-retry-chapter]").addEventListener("click", () => loadChapter(mangaId, chapterUrl, restoreFraction));
}

// หลอดในแถบล่าง = สัดส่วนที่เลื่อนอ่านมาแล้วของตอนนี้
function updateReaderProgress() {
  el("#readerProgressBar").style.width = `${(Math.max(0, Math.min(1, currentScrollFraction)) * 100).toFixed(1)}%`;
}

// เปิดหน้าเรื่องซ้อนบนหน้าอ่าน (หน้าอ่านยังอยู่ข้างล่าง) — กดปิดหน้าเรื่องแล้วกลับมาอ่านต่อจุดเดิม
function openChapterListFromReader() {
  if (!currentManga) return;
  rememberScroll(); // สถานะตอนที่อ่านอยู่ (กรอบ/หลอด) ในตารางให้ตรงกับตอนนี้
  const view = el("#chapterListView");
  el("#chapterListMangaName").textContent = currentManga.name || "";
  el("#chapterSearch").value = "";
  chapterRange = null;
  lastChapterRowsSignature = null;
  view.classList.add("over-reader");
  view.hidden = false;
  if (currentChapters.length) renderChapterRows(currentChapters);
  else el("#chapterListBody").innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  scrollToLastRead();
  renderChapterList({ keepScroll: true });
}

function checkAutoAdvance() {
  updateReaderProgress();
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
  chapterLoadSeq++;
  // saveScrollPosition จำตำแหน่งไว้ในหน้าเว็บทันที (ก่อนส่งเซิร์ฟเวอร์) หน้าเลือกตอนด้านล่างจึงวาดจากค่าที่
  // ถูกต้องได้เลย ไม่ต้องรอ — ส่วนการโหลดรายชื่อตอนใหม่จากเซิร์ฟเวอร์ต้องรอให้บันทึกเสร็จก่อนเสมอ ไม่งั้น
  // สองคำขอวิ่งชนกันและได้ค่าเก่ากลับมา
  const saved = saveScrollPosition();
  cancelRestore();
  closeComments();
  el("#reader").hidden = true;
  syncThemeColor();
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
  // แถวแจ้งเตือนในหน้าตั้งค่าใช้สถานะเดียวกับแผงกระดิ่ง
  el("#setPushToggle").checked = !!pushOn;
  el("#setPushDesc").textContent = !BOOT.push_key ? "เซิร์ฟเวอร์ยังไม่เปิดระบบนี้"
    : !pushSupported && isIOS && !isStandalone ? "iPhone ต้องเปิดจากไอคอนหน้าจอโฮมก่อน"
    : !pushSupported ? "เบราว์เซอร์นี้ไม่รองรับ" : pushOn ? "เครื่องนี้เปิดอยู่" : "เครื่องนี้ปิดอยู่";
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
const NOTIF_ICON = { chapter: "📚", reply: "💬", mention: "📣", thread: "🗨️", system: "⚠️", video: "🎬" };

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
  el("#setInstallRow").hidden = el("#installBtn").hidden;
  renderInstallBanner();
}

// ---------- แถบแนะนำเพิ่มไปหน้าจอโฮม (หน้าแรก) ----------
// ✕ = ซ่อน 14 วัน, "ไม่ต้องเตือนอีก" = ซ่อนถาวร — จำต่อเครื่อง (การติดตั้งเป็นเรื่องของเครื่อง ไม่ใช่บัญชี)
const INSTALL_BANNER_KEY = "installBannerUntil";
const isInAppBrowser = /FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent);

function installBannerDismissed() {
  try {
    const v = localStorage.getItem(INSTALL_BANNER_KEY);
    return v === "never" || (v && Number(v) > Date.now());
  } catch (e) { return false; }
}

function dismissInstallBanner(forever) {
  try { localStorage.setItem(INSTALL_BANNER_KEY, forever ? "never" : String(Date.now() + 14 * 86400000)); } catch (e) { /* ไม่จำก็ได้ */ }
  el("#installBanner").hidden = true;
}

function renderInstallBanner() {
  const banner = el("#installBanner");
  banner.hidden = el("#installBtn").hidden || installBannerDismissed();
  if (banner.hidden) return;
  const direct = !!installPromptEvent; // Android/Chrome ติดตั้งได้ทันที
  el("#installBannerTitle").textContent = direct ? "ติดตั้ง MeeManga" : "เพิ่มไปหน้าจอโฮม";
  el("#installBannerDesc").textContent = direct ? "ไม่ต้องเปิดเบราว์เซอร์ทุกครั้ง" : "เปิดเร็วเหมือนแอป + แจ้งเตือนตอนใหม่";
  el("#installBannerBtn").textContent = direct ? "ติดตั้ง" : "วิธีเพิ่ม";
}

// forPush = เปิดจากปุ่มเปิดแจ้งเตือน (iPhone ต้องเปิดจากไอคอนหน้าจอโฮมก่อนถึงจะรับแจ้งเตือนได้) — เพิ่มขั้นที่ 4
function showInstallSheet({ forPush = false } = {}) {
  el("#installSheetTitle").textContent = forPush ? "เปิดแจ้งเตือนบน iPhone (4 ขั้น)"
    : isIOS ? "เพิ่มไปหน้าจอโฮม (3 ขั้น)" : "เพิ่มไปหน้าจอหลัก (3 ขั้น)";
  // ไอคอนหน้าตาเดียวกับปุ่มจริงในเบราว์เซอร์ — คนไม่ถนัดหาปุ่มจากรูปง่ายกว่าคำบรรยาย
  const svg = (d) => `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    share: svg('<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>'),
    addHome: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>'),
    add: '<span class="install-step-word">เพิ่ม</span>',
    menu: svg('<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>'),
    install: svg('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M12 8v7M8.5 11.5L12 15l3.5-3.5"/>'),
    bell: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  };
  const steps = isIOS
    ? [[ICON.share, "แตะปุ่ม <b>แชร์</b> ที่แถบล่างของ Safari"], [ICON.addHome, "เลื่อนลง เลือก <b>เพิ่มไปยังหน้าจอโฮม</b>"], [ICON.add, "แตะ <b>เพิ่ม</b> มุมขวาบน แล้วเปิดจากไอคอนใหม่"]]
    : [[ICON.menu, "แตะเมนู <b>⋮</b> มุมขวาบนของ Chrome"], [ICON.install, "เลือก <b>เพิ่มลงในหน้าจอหลัก</b> หรือ <b>ติดตั้งแอป</b>"], [ICON.add, "แตะ <b>เพิ่ม</b> แล้วเปิดจากไอคอนใหม่"]];
  if (forPush) steps[2] = [ICON.add, "แตะ <b>เพิ่ม</b> มุมขวาบน"], steps.push([ICON.bell, "เปิดเว็บจาก<b>ไอคอนใหม่</b> แล้วแตะกระดิ่ง → <b>เปิด</b>"]);
  el("#installSheetNever").hidden = forPush; // "ไม่ต้องเตือนอีก" ใช้กับแถบแนะนำเท่านั้น
  el("#installSheetSteps").innerHTML = steps.map(([icon, text], i) =>
    `<li><span class="install-step-num">${i + 1}</span><span class="install-step-ic">${icon}</span><span>${text}</span></li>`).join("");
  const notes = [];
  if (isInAppBrowser) notes.push(isIOS ? 'เปิดจาก LINE/Facebook อยู่? แตะ ⋯ แล้วเลือก "เปิดใน Safari" ก่อน' : 'เปิดจาก LINE/Facebook อยู่? แตะ ⋮ แล้วเลือก "เปิดในเบราว์เซอร์" ก่อน');
  if (forPush) notes.push("ต้องเป็น iOS 16.4 ขึ้นไป");
  el("#installSheetNote").hidden = !notes.length;
  el("#installSheetNote").textContent = notes.join(" · ");
  el("#installSheet").hidden = false;
}

function closeInstallSheet() {
  el("#installSheet").hidden = true;
}

// ปุ่มเพิ่มไปหน้าจอโฮม (หัวเว็บ / ตั้งค่า / แถบแนะนำ): Android มีหน้าต่างติดตั้งของระบบ, ที่เหลือเปิดแผ่นวิธีทำ
async function runInstall() {
  if (installPromptEvent) {
    const event = installPromptEvent;
    installPromptEvent = null; // ใช้ได้ครั้งเดียว
    event.prompt();
    const choice = await event.userChoice.catch(() => null);
    if (choice?.outcome === "accepted") el("#installBtn").hidden = true;
    updateInstallButton();
    return;
  }
  showInstallSheet();
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
  el("#installBtn").addEventListener("click", runInstall);
  el("#installBannerBtn").addEventListener("click", runInstall);
  el("#installBannerClose").addEventListener("click", () => dismissInstallBanner(false));
  el("#installSheetOk").addEventListener("click", closeInstallSheet);
  el("#installSheetNever").addEventListener("click", () => { dismissInstallBanner(true); closeInstallSheet(); });
  el("#installSheet").addEventListener("click", (e) => { if (e.target === el("#installSheet")) closeInstallSheet(); });
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
    if (isIOS && !isStandalone) {
      toggleNotifPanel(false);
      showInstallSheet({ forPush: true });
    } else toast("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองเปิดด้วย Chrome หรือ Safari เวอร์ชันล่าสุด", { error: true });
    return;
  }
  const btn = el("#pushCardBtn");
  btn.disabled = true;
  try {
    const reg = await pushRegistration();
    const existing = await reg.pushManager.getSubscription();
    if (existing && Notification.permission === "granted") {
      if (!(await askConfirm("ปิดแจ้งเตือนตอนใหม่บนเครื่องนี้?"))) return;
      await postJSON("/api/push/unsubscribe", { endpoint: existing.endpoint }).catch(() => {});
      await existing.unsubscribe();
      setPushButton(false);
      return;
    }
    // ต้องขออนุญาตจากการกดของผู้ใช้โดยตรงเท่านั้น (iOS/Chrome บล็อกถ้าขอเองตอนโหลดหน้า)
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast(
        permission === "denied"
          ? "เครื่องนี้ถูกตั้งไม่ให้เว็บนี้แจ้งเตือน ต้องไปเปิดในตั้งค่าของเบราว์เซอร์/ตั้งค่าแจ้งเตือนของเครื่องก่อน"
          : "ยังไม่ได้อนุญาตการแจ้งเตือน"
      , { error: true });
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
    if (!test.sent) toast("เปิดแจ้งเตือนแล้ว แต่ส่งแจ้งเตือนทดสอบไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง", { error: true });
  } catch (e) {
    toast("เปิดแจ้งเตือนไม่สำเร็จ: " + (e.message || e), { error: true });
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
  if (url.searchParams.get("admin") === "manga-problem" && state.currentUser.is_admin) {
    // แจ้งเตือน "เว็บต้นทางมีปัญหา" → หน้าจัดการเรื่อง กรองเฉพาะที่ดึงไม่สำเร็จ
    history.replaceState(null, "", "/");
    el("#reader").hidden = true;
    mangaAdminFilter = "problem";
    // ตอนเปิดแอปจากแจ้งเตือน ฟังก์ชันนี้ถูกเรียกก่อน init ตั้งแท็บ/หน้าตั้งค่าเสร็จ — รอให้ init จบก่อนค่อยสลับ
    setTimeout(() => { showTab("settings"); openAdminPage("mangaManage"); }, 0);
    return;
  }
  const playlistId = url.searchParams.get("playlist");
  if (playlistId) {
    // แจ้งเตือนตอนใหม่ของเรื่องใน MeeMovie → หน้าเรื่องนั้น
    history.replaceState(null, "", "/");
    el("#reader").hidden = true;
    setTimeout(async () => {
      showTab("videos");
      if (!playlistById(playlistId)) await loadVideos();
      if (playlistById(playlistId)) openPlaylist(playlistId);
    }, 0);
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
    if (commentTarget !== target) return; // ปิด/เปิดของอื่นไปแล้วระหว่างรอ
    renderCommentList(data.items);
  } catch (e) {
    if (commentTarget !== target) return;
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
  if (!(await askConfirm("ลบความคิดเห็นนี้?"))) return false;
  try { await sendJSON("DELETE", `/api/comments/${encodeURIComponent(id)}`); return true; }
  catch (e) { toast(e.message || "ลบไม่สำเร็จ", { error: true }); return false; }
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
    } catch (e) { toast(e.message || "ส่งไม่สำเร็จ", { error: true }); }
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

// ---------- จัดการคลิป (แอดมิน): แท็บ คลิป / Playlist / หมวด / เพิ่ม + แผ่นแก้ไข ----------
let vmTab = "playlists";
let vmPlFilter = "updated"; // updated / nocat / similar
let vmClipFilter = "all"; // all / nocat / external

function setVmTab(tab) {
  vmTab = tab;
  els("#vmSeg [data-vm-tab]").forEach((b) => b.classList.toggle("active", b.dataset.vmTab === tab));
  [["clips", "#vmClips"], ["playlists", "#vmPlaylists"], ["cats", "#vmCats"], ["add", "#vmAdd"]]
    .forEach(([t, sel]) => { el(sel).hidden = t !== tab; });
}

function categoryName(id) {
  return (state.videoCategories || []).find((c) => c.id === id)?.name || "";
}

// ชื่อคล้ายกัน: ตัดวรรณยุกต์/การันต์/ช่องว่างแล้วเท่ากัน หรือห่างกันไม่เกิน 2 ตัวอักษร (ตัวเลขต้องตรงกัน
// — "ภาค1" กับ "ภาค2" เป็นคนละภาคจริง) ระบบแค่เสนอ ไม่รวมให้เอง
function normName(name) {
  return name.toLowerCase().replace(/[\s\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, "").replace(/ย$/, "");
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function similarPlaylists() {
  const lists = state.videoPlaylists || [];
  const out = new Map();
  const digits = (s) => (s.match(/\d+/g) || []).join(",");
  for (let i = 0; i < lists.length; i++) {
    for (let k = i + 1; k < lists.length; k++) {
      const a = normName(lists[i].name), b = normName(lists[k].name);
      if (digits(lists[i].name) !== digits(lists[k].name)) continue;
      if (a === b || (Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= 2)) {
        out.set(lists[i].id, [...(out.get(lists[i].id) || []), lists[k].id]);
        out.set(lists[k].id, [...(out.get(lists[k].id) || []), lists[i].id]);
      }
    }
  }
  return out;
}

function vmThumb(url) {
  return url ? `<img class="vm-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" />` : '<span class="vm-thumb video-placeholder">▶</span>';
}

function renderVideoManage() {
  const cats = state.videoCategories || [];
  const lists = state.videoPlaylists || [];
  const clips = state.videos.filter((v) => !v.playlist_id);
  const similar = similarPlaylists();
  const seg = { clips: `คลิป ${clips.length}`, playlists: `Playlist ${lists.length}`, cats: "หมวด", add: "เพิ่ม" };
  els("#vmSeg [data-vm-tab]").forEach((b) => { b.textContent = seg[b.dataset.vmTab]; });
  setVmTab(vmTab);

  // Playlist
  const nocatPl = lists.filter((p) => !p.category_id);
  el("#vmPlFilters").innerHTML = [["updated", "อัปเดตล่าสุด"], ["nocat", `ไม่มีหมวด ${nocatPl.length}`], ["similar", `ชื่อคล้ายกัน ${similar.size}`]]
    .map(([k, label]) => `<button class="video-chip${vmPlFilter === k ? " active" : ""}" data-vm-pl-filter="${k}">${label}</button>`).join("");
  const q = el("#vmPlSearch").value.trim().toLowerCase();
  const pls = (vmPlFilter === "nocat" ? nocatPl : vmPlFilter === "similar" ? lists.filter((p) => similar.has(p.id)) : lists)
    .filter((p) => !q || p.name.toLowerCase().includes(q));
  if (vmPlFilter === "similar") pls.sort((a, b) => normName(a.name).localeCompare(normName(b.name), "th"));
  el("#playlistManageList").innerHTML = pls.map((p) => {
    const twin = similar.get(p.id);
    const meta = twin ? `<span class="status-bad">คล้าย "${escapeHtml(lists.find((x) => x.id === twin[0])?.name || "")}"</span>`
      : `${escapeHtml(categoryName(p.category_id) || "ไม่มีหมวด")} · ตอนใหม่ ${timeAgo(p.updated_at, "เมื่อสักครู่")}`;
    return `<li class="vm-row" data-vm-open="pl:${escapeHtml(p.id)}">${vmThumb(p.thumbnail_url)}${playlistBadge(p, playlistEpisodes(p.id)) ? '<span class="vm-ep">EP</span>' : ""}
      <div class="grow"><div class="name">${escapeHtml(p.name)}</div><div class="meta">${p.count} ตอน · ${meta}</div></div><span class="vm-more" aria-hidden="true">⋯</span></li>`;
  }).join("") || '<li class="hint">ไม่มีเรื่องตามตัวกรองนี้</li>';

  // คลิปเดี่ยว
  el("#vmClipFilters").innerHTML = [["all", `ทั้งหมด ${clips.length}`], ["nocat", `ไม่มีหมวด ${clips.filter((v) => !v.category_id).length}`], ["external", `เปิดใน Facebook ${clips.filter((v) => v.external).length}`]]
    .map(([k, label]) => `<button class="video-chip${vmClipFilter === k ? " active" : ""}" data-vm-clip-filter="${k}">${label}</button>`).join("");
  const cq = el("#vmClipSearch").value.trim().toLowerCase();
  el("#videoManageList").innerHTML = clips
    .filter((v) => vmClipFilter === "nocat" ? !v.category_id : vmClipFilter === "external" ? v.external : true)
    .filter((v) => !cq || v.title.toLowerCase().includes(cq))
    .map((v) => {
      const dur = Number(v.duration_seconds) || 0;
      return `<li class="vm-row" data-vm-open="v:${escapeHtml(v.id)}">${vmThumb(v.thumbnail_url)}
        <div class="grow"><div class="name">${escapeHtml(v.title)}</div><div class="meta">${escapeHtml(categoryName(v.category_id) || "ไม่มีหมวด")} · ${escapeHtml(v.added_by)}${dur ? ` · ${Math.max(1, Math.round(dur / 60))} นาที` : ""}${v.external ? " · เปิดใน Facebook" : ""}</div></div><span class="vm-more" aria-hidden="true">⋯</span></li>`;
    }).join("") || '<li class="hint">ไม่มีคลิปตามตัวกรองนี้</li>';

  // หมวด
  el("#videoCategoryList").innerHTML = cats.length ? cats.map((c, i) => {
    const nClips = clips.filter((v) => v.category_id === c.id).length;
    const nPl = lists.filter((p) => p.category_id === c.id).length;
    return `<li class="vm-row" data-cat-id="${escapeHtml(c.id)}"><div class="grow"><div class="name">${escapeHtml(c.name)}</div><div class="meta">คลิป ${nClips} · เรื่อง ${nPl}</div></div>
      <button class="icon-btn" data-move-video-category="up" title="เลื่อนขึ้น"${i === 0 ? " disabled" : ""}>${ICON_UP}</button><button class="icon-btn" data-move-video-category="down" title="เลื่อนลง"${i === cats.length - 1 ? " disabled" : ""}>${ICON_DOWN}</button>
      <button class="btn" data-rename-video-category="${escapeHtml(c.id)}">เปลี่ยนชื่อ</button><button class="btn danger" data-delete-video-category="${escapeHtml(c.id)}">ลบ</button></li>`;
  }).join("") : '<li class="hint">ยังไม่มีหมวดคลิป</li>';

  // ตัวเลือกในแท็บเพิ่ม
  const catOptions = (none) => [`<option value="">${none}</option>`, ...cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)].join("");
  const keepCat = el("#addLinksCategory").value;
  el("#addLinksCategory").innerHTML = catOptions("— ไม่มีหมวด —");
  el("#addLinksCategory").value = keepCat || (cats.some((c) => c.name === "ซีรีส์จีน") ? "ซีรีส์จีน" : "");
  const keepPl = el("#addLinksPlaylist").value;
  el("#addLinksPlaylist").innerHTML = ['<option value="">— เลือกเรื่อง —</option>', ...lists.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)].join("");
  el("#addLinksPlaylist").value = keepPl;
}

// ---------- แผ่นแก้ไข (กด ⋯ / แถว) ----------
let vmSheetKey = null;

// "ภาค 2" / "ภาค2" / "ซีซั่น 3" / "Season 2" ในชื่อเรื่อง → เลขซีซั่น (ไว้ใส่ค่าเริ่มต้นตอนรวมเรื่องเป็นซีซั่น)
function guessSeason(name) {
  const m = String(name).match(/(?:ภาค(?:ที่)?|ซีซั่น|ซีซัน|season|ss)\s*(\d+)/i);
  return m ? Number(m[1]) : "";
}

// ส่วน YouTube ในแผ่นแก้ไขเรื่อง: playlist ต้นทางแต่ละภาษา (ติดตามตอนใหม่ เปิด/ปิด) + ตั้งชื่อซีซั่น
function ytSheetHtml(p) {
  const tracks = p.tracks || [];
  const seasons = [...new Set(allPlaylistEpisodes(p.id).map((v) => v.season || 1))].sort((a, b) => a - b);
  const starts = (p.season_starts || []).map((n) => Number(n)).join(", ");
  const split = `<label class="vm-field">แบ่งซีซั่นเอง: ตอนที่เริ่มซีซั่นใหม่ (คั่นด้วย ,)<input id="sheetSeasonStarts" value="${escapeHtml(starts)}" placeholder="เช่น 13 หรือ 13, 25 (ว่าง = ดูจากชื่อคลิป)" inputmode="decimal" /></label>
    <div class="hint">ใช้เมื่อชื่อคลิปไม่บอกซีซั่น (เช่น ตอนที่ 1–24 ต่อกันแต่เป็น 2 ซีซั่น) — ตอนใหม่ที่ดึงมาทีหลังเข้าซีซั่นตามนี้ด้วย</div>`;
  const rows = tracks.map((t) => {
    const status = t.error ? `<span class="status-dot bad"></span><span class="status-bad">${escapeHtml(t.error)}</span>`
      : `<span class="status-dot ok"></span>เช็ค ${timeAgo(t.checked_at, "เมื่อสักครู่")}`;
    return `<li class="vm-row"><div class="grow"><div class="name">${t.lang ? `<span class="tag-lang">${LANG_LABEL[t.lang]}</span> ` : ""}${escapeHtml(t.title || t.list_id)}</div><div class="meta row-status">${status}</div></div>
      <label class="switch-label">ติดตาม <input type="checkbox" class="switch" data-track-follow="${escapeHtml(t.list_id)}"${t.follow ? " checked" : ""} /></label></li>`;
  }).join("");
  const names = seasons.length > 1 ? `<div class="vm-field">ชื่อซีซั่น (ว่าง = "ซีซั่น N")${seasons.map((n) =>
    `<label class="season-name">${n}<input data-season-name="${n}" value="${escapeHtml((p.season_names || {})[n] || "")}" placeholder="ซีซั่น ${n}" maxlength="30" /></label>`).join("")}</div>` : "";
  return `${tracks.length ? `<div class="vm-field">playlist YouTube (เช็คตอนใหม่ทุก 1 ชม.)<ul class="settings-list vm-list">${rows}</ul></div>` : ""}${split}${names}`;
}

function closeVmSheet() {
  vmSheetKey = null;
  el("#vmSheet").hidden = true;
}

function catChipsHtml(selected) {
  return [{ id: "", name: "ไม่มี" }, ...(state.videoCategories || [])].map((c) =>
    `<button type="button" class="video-chip${(selected || "") === c.id ? " active" : ""}" data-sheet-cat="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`).join("");
}

function openVmSheet(key, { episodes = false } = {}) {
  vmSheetKey = key;
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const body = el("#vmSheetBody");
  if (kind === "pl") {
    const p = playlistById(id);
    if (!p) return closeVmSheet();
    const eps = allPlaylistEpisodes(id);
    // เรื่องเดียวกันคนละภาค ("อุ้ยเสี่ยวป้อภาค1" ↔ "ภาค2") ขึ้นก่อน — ตัวหาชื่อคล้าย (similarPlaylists) ถือว่าเลขต่าง = คนละเรื่อง
    const base = (n) => String(n).replace(/(?:ภาค(?:ที่)?|ซีซั่น|ซีซัน|season|ss)\s*\d+/gi, "").replace(/\s+/g, "").toLowerCase();
    const seasonTwins = (state.videoPlaylists || []).filter((x) => x.id !== id && base(x.name) === base(p.name)).map((x) => x.id);
    const twins = [...new Set([...seasonTwins, ...(similarPlaylists().get(id) || [])])];
    const others = [...twins.map(playlistById), ...(state.videoPlaylists || []).filter((x) => x.id !== id && !twins.includes(x.id))].filter(Boolean);
    body.innerHTML = `<div class="sheet-head">${vmThumb(p.thumbnail_url)}<div><div class="name">${escapeHtml(p.name)}</div><div class="meta">${eps.length} ตอน${eps.length ? ` · ตอนที่ ${Number(eps[0].episode)}–${Number(eps[eps.length - 1].episode)}` : ""}</div></div></div>
      <label class="vm-field">ชื่อเรื่อง<input id="sheetName" value="${escapeHtml(p.name)}" maxlength="80" /></label>
      <div class="vm-field">หมวด<div class="pl-controls" id="sheetCats">${catChipsHtml(p.category_id)}</div></div>
      <button class="btn primary" data-sheet-save>บันทึก</button>
      <div class="vm-field">รวมเข้ากับเรื่องอื่น<select id="sheetMergeTarget" class="form-select">${others.map((o, i) => `<option value="${escapeHtml(o.id)}">${i < twins.length ? "★ " : ""}${escapeHtml(o.name)} (${o.count} ตอน)</option>`).join("")}</select>
        <div class="merge-opts"><label>เป็นซีซั่น <input id="sheetMergeSeason" type="number" min="1" max="99" inputmode="numeric" value="${guessSeason(p.name)}" placeholder="—" /></label>
          <label>ภาษา <select id="sheetMergeLang" class="form-select"><option value="">ไม่ระบุ</option><option value="dub">พากย์ไทย</option><option value="sub">ซับไทย</option></select></label></div>
        <label class="switch-label">ต่อเลขตอนจากเรื่องปลายทาง <input type="checkbox" class="switch" id="sheetMergeRenumber" /></label>
        <div class="hint">ซีซั่นว่าง = ย้ายตอนไปต่อเรื่องเดิมแบบเดิม · ใส่เลข = เรื่องนี้เป็นภาคนั้นของเรื่องปลายทาง · ต่อเลขตอน = เรียงตอนตามลำดับเดิมแล้วนับต่อจากตอนสุดท้ายของปลายทาง (ใช้กับภาคที่เริ่มตอน 1 ใหม่ หรือไม่มีเลขตอน)</div>
        <button class="btn" data-sheet-merge>รวมทุกตอนเข้าเรื่องที่เลือก</button></div>
      ${ytSheetHtml(p)}
      <button class="btn" data-sheet-episodes>${episodes ? "ซ่อนรายการตอน" : "ดูรายการตอน / แก้เลขตอน"}</button>
      ${episodes ? `<ul class="sheet-eps">${eps.map((v) => `<li><input type="number" step="any" value="${Number(v.episode)}" data-ep-id="${escapeHtml(v.id)}" aria-label="เลขตอน" /><span>${v.lang || v.season > 1 ? `<b>${v.season > 1 ? `S${v.season} ` : ""}${v.lang ? LANG_LABEL[v.lang].replace("ไทย", "") : ""}</b> ` : ""}${escapeHtml(v.title)}</span></li>`).join("")}</ul><div class="hint">แก้เลขแล้วกดออกจากช่อง = บันทึกทันที</div>` : ""}
      <button class="btn danger" data-sheet-delete>ลบทั้งเรื่อง</button>
      <div id="sheetMsg" class="form-msg"></div>`;
  } else {
    const v = state.videos.find((x) => x.id === id);
    if (!v) return closeVmSheet();
    body.innerHTML = `<div class="sheet-head">${vmThumb(v.thumbnail_url)}<div><div class="name">${escapeHtml(v.title)}</div><div class="meta">เพิ่มโดย ${escapeHtml(v.added_by)} · ${timeAgo(v.created_at, "เมื่อสักครู่")}</div></div></div>
      <label class="vm-field">ชื่อคลิป<input id="sheetName" value="${escapeHtml(v.title)}" maxlength="160" /></label>
      <div class="vm-field">หมวด<div class="pl-controls" id="sheetCats">${catChipsHtml(v.category_id)}</div></div>
      <button class="btn primary" data-sheet-save>บันทึก</button>
      <button class="btn" data-sheet-play>▶ เปิดดูคลิป</button>
      <button class="btn danger" data-sheet-delete>ลบคลิป</button>
      <div id="sheetMsg" class="form-msg"></div>`;
  }
  el("#vmSheet").hidden = false;
}

async function vmSheetChange(e) {
  const id = vmSheetKey && vmSheetKey.startsWith("pl:") ? vmSheetKey.slice(3) : null;
  if (!id) return;
  const follow = e.target.closest("[data-track-follow]");
  const season = e.target.closest("[data-season-name]");
  const starts = e.target.closest("#sheetSeasonStarts");
  try {
    if (starts) {
      const list = starts.value.split(/[,\s]+/).filter(Boolean).map(Number);
      if (list.some((n) => !(n > 0))) return toast("ใส่เลขตอน เช่น 13 หรือ 13, 25", { error: true });
      await sendJSON("PATCH", `/api/video-playlists/${encodeURIComponent(id)}`, { season_starts: list });
      await loadVideos();
      openVmSheet(vmSheetKey);
      return toast(list.length ? `แบ่งเป็น ${list.length + 1} ซีซั่นแล้ว` : "กลับไปใช้ซีซั่นตามชื่อคลิปแล้ว");
    }
    if (follow) await sendJSON("PATCH", `/api/video-playlists/${encodeURIComponent(id)}`, { track: { list_id: follow.dataset.trackFollow, follow: follow.checked } });
    else if (season) await sendJSON("PATCH", `/api/video-playlists/${encodeURIComponent(id)}`, { season_name: { season: Number(season.dataset.seasonName), name: season.value } });
    else return;
    await loadVideos();
    toast("บันทึกแล้ว");
  } catch (err) { toast(err.message || "บันทึกไม่สำเร็จ", { error: true }); }
}

async function vmSheetAction(e) {
  if (e.target === el("#vmSheet")) return closeVmSheet(); // แตะพื้นหลัง = ปิด
  const key = vmSheetKey;
  if (!key) return;
  const kind = key.slice(0, key.indexOf(":"));
  const id = key.slice(key.indexOf(":") + 1);
  const msg = el("#sheetMsg");
  const chip = e.target.closest("[data-sheet-cat]");
  if (chip) {
    els("#sheetCats [data-sheet-cat]").forEach((b) => b.classList.toggle("active", b === chip));
    return;
  }
  const refresh = async () => { await loadVideos(); renderVideoManage(); };
  try {
    if (e.target.closest("[data-sheet-save]")) {
      const name = el("#sheetName").value.trim();
      const category_id = el("#sheetCats .active")?.dataset.sheetCat || null;
      if (kind === "pl") await sendJSON("PATCH", `/api/video-playlists/${encodeURIComponent(id)}`, { name, category_id });
      else await sendJSON("PATCH", `/api/videos/${encodeURIComponent(id)}`, { title: name, category_id });
      await refresh();
      closeVmSheet();
    } else if (e.target.closest("[data-sheet-merge]")) {
      const target = playlistById(el("#sheetMergeTarget").value);
      const p = playlistById(id);
      const season = el("#sheetMergeSeason").value.trim();
      const lang = el("#sheetMergeLang").value;
      const renumber = el("#sheetMergeRenumber").checked;
      const last = Math.max(0, ...allPlaylistEpisodes(target.id).map((v) => Number(v.episode) || 0));
      const as = `${season ? ` เป็นซีซั่น ${season}` : ""}${lang ? ` (${LANG_LABEL[lang]})` : ""}${renumber ? `\nเลขตอนเริ่มที่ ${Math.floor(last) + 1}` : ""}`;
      if (!target || !(await askConfirm(`ย้ายทั้ง ${p.count} ตอนของ "${p.name}" เข้า "${target.name}"${as} แล้วลบ "${p.name}"?`))) return;
      const res = await sendJSON("POST", `/api/video-playlists/${encodeURIComponent(id)}/merge`, { into: target.id, season: season || null, lang: lang || null, renumber });
      await refresh();
      openVmSheet(`pl:${target.id}`, { episodes: true });
      el("#sheetMsg").textContent = `รวมแล้ว ${res.moved} ตอน — ตรวจเลขตอนซ้ำด้านบนได้เลย`;
    } else if (e.target.closest("[data-sheet-episodes]")) {
      openVmSheet(key, { episodes: !el("#vmSheetBody .sheet-eps") });
    } else if (e.target.closest("[data-sheet-play]")) {
      const v = state.videos.find((x) => x.id === id);
      closeVmSheet();
      if (v) openVideo(v);
    } else if (e.target.closest("[data-sheet-delete]")) {
      if (kind === "pl") {
        const p = playlistById(id);
        if (!(await askConfirm(`ลบ "${p.name}" พร้อมทั้ง ${p.count} ตอน?\n(ทุกคนจะไม่เห็นอีก)`))) return;
        await sendJSON("DELETE", `/api/video-playlists/${encodeURIComponent(id)}`);
      } else {
        const v = state.videos.find((x) => x.id === id);
        if (!(await askConfirm(`ลบคลิป "${v.title}"?`))) return;
        await sendJSON("DELETE", `/api/videos/${encodeURIComponent(id)}`);
      }
      closeVmSheet();
      await refresh();
    }
  } catch (err) {
    if (msg) { msg.classList.add("error"); msg.textContent = err.message || "ไม่สำเร็จ"; }
  }
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
  const sources = playlistWatch.sources || [];
  const results = playlistWatch.last_result || [];
  el("#watchSourceList").innerHTML = sources.map((s, i) => {
    const r = results.find((x) => x.url === s.url);
    const status = playlistWatch.running ? '<span class="status-dot warn"></span>กำลังเช็ค...'
      : !r ? '<span class="status-dot"></span>ยังไม่เคยเช็ค'
      : r.error ? `<span class="status-dot bad"></span><span class="status-bad">${escapeHtml(r.error)}</span>`
      : `<span class="status-dot ok"></span>เช็ค ${timeAgo(r.checked_at, "เมื่อสักครู่")} · พบ ${r.found} · เพิ่ม ${r.added.length} ตอน`;
    const id = (s.url.match(/id=(\d+)/) || s.url.match(/facebook\.com\/([^/?#]+)/) || [])[1] || s.url;
    return `<li class="vm-row"><div class="grow"><div class="name">เพจ ${escapeHtml(id)}</div><div class="meta">→ ${escapeHtml(s.category || "ไม่มีหมวด")}</div><div class="meta row-status">${status}</div>
      ${r && r.added.length ? `<div class="meta">${escapeHtml(r.added.join(", "))}</div>` : ""}</div>
      <button class="btn danger" data-remove-watch="${i}">เลิกติดตาม</button></li>`;
  }).join("") || '<li class="hint">ยังไม่ได้ติดตามเพจไหน — กด "+ เพจ"</li>';
  el("#watchRunBtn").disabled = !sources.length || playlistWatch.running;
  el("#watchStatus").textContent = playlistWatch.running ? "กำลังเช็ค..." : playlistWatch.last_run ? `เช็คอัตโนมัติทุก 2 ชม. · ล่าสุด ${timeAgo(playlistWatch.last_run, "เมื่อสักครู่")}` : "";
}

async function saveWatchSources(sources) {
  try { await sendJSON("PUT", "/api/video-playlists/watch", { sources }); }
  catch (e) { toast(e.message || "บันทึกไม่สำเร็จ", { error: true }); }
  await loadPlaylistWatch();
}

function initPlaylistWatch() {
  el("#watchSourceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = el("#watchSourceUrl").value.trim();
    await saveWatchSources([...(playlistWatch.sources || []), { url, category: el("#watchSourceCategory").value }]);
    el("#watchSourceUrl").value = "";
  });
  el("#watchSourceList").addEventListener("click", async (event) => {
    const i = event.target.closest("[data-remove-watch]")?.dataset.removeWatch;
    if (i === undefined || !(await askConfirm("เลิกติดตามเพจนี้? (ตอนที่เพิ่มไปแล้วยังอยู่)"))) return;
    saveWatchSources(playlistWatch.sources.filter((_, idx) => idx !== Number(i)));
  });
  el("#watchRunBtn").addEventListener("click", async () => {
    try { await sendJSON("POST", "/api/video-playlists/watch/run"); } catch (e) { toast(e.message, { error: true }); }
    loadPlaylistWatch();
  });
  el("#watchAddToggle").addEventListener("click", () => {
    el("#watchSourceForm").hidden = !el("#watchSourceForm").hidden;
    if (!el("#watchSourceForm").hidden) el("#watchSourceUrl").focus();
  });
  el("#addLinksMode").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-add-mode]");
    if (!chip) return;
    els("#addLinksMode [data-add-mode]").forEach((b) => b.classList.toggle("active", b === chip));
    el("#addLinksPlaylist").hidden = chip.dataset.addMode !== "pick";
  });
  el("#addLinksBtn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const msg = el("#addLinksMsg");
    const mode = el("#addLinksMode .active")?.dataset.addMode || "auto";
    if (mode === "pick" && !el("#addLinksPlaylist").value) {
      msg.classList.add("error");
      msg.textContent = "เลือกเรื่องปลายทางก่อน";
      return;
    }
    btn.disabled = true;
    msg.classList.remove("error");
    msg.textContent = "กำลังอ่านลิงก์... (ลิงก์ละไม่กี่วินาที)";
    try {
      const data = await sendJSON("POST", "/api/video-playlists/add-links", {
        links: el("#addLinksText").value, mode: mode === "pick" ? "auto" : mode,
        playlist_id: mode === "pick" ? el("#addLinksPlaylist").value : null, category: el("#addLinksCategory").value });
      const label = { exists: "มีอยู่แล้ว", skipped: "ข้าม", error: "ผิดพลาด" };
      msg.textContent = data.results.map((r) => r.status === "added"
        ? `✓ ${r.playlist} ตอนที่ ${r.episode}${r.new_playlist ? " (เรื่องใหม่)" : ""}`
        : r.status === "added_clip" ? `✓ คลิปเดี่ยว: ${r.title}`
        : `${label[r.status]}: ${r.title || r.url}${r.error ? ` — ${r.error}` : ""}`).join("\n");
      if (data.results.some((r) => r.status === "added" || r.status === "added_clip")) {
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

// ---------- เพิ่มจาก YouTube (แอดมิน): ดูข้อมูลก่อน → เลือกรวมเข้าเรื่องเดิม/เรื่องใหม่, ภาษา, หมวด → เพิ่ม ----------
let ytPreviewData = null;

function ytChoice(group, value, label, active) {
  return `<button type="button" class="video-chip${active ? " active" : ""}" data-yt-${group}="${escapeHtml(value)}">${label}</button>`;
}

function renderYtPreview() {
  const d = ytPreviewData;
  const box = el("#ytPreview");
  if (!d) { box.innerHTML = ""; return; }
  const cats = state.videoCategories || [];
  const catSelect = (selected) => `<label class="vm-field">หมวด <select id="ytCategory" class="form-select"><option value="">— ไม่มีหมวด —</option>${cats.map((c) =>
    `<option value="${escapeHtml(c.id)}"${c.id === selected ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label>`;
  if (d.kind === "video") {
    box.innerHTML = `<div class="yt-preview">${vmThumb(d.thumbnail_url)}<div><div class="name">${escapeHtml(d.title)}</div><div class="meta">${escapeHtml(d.channel)}${d.embeddable ? "" : " · ⚠️ ปิดการฝัง จะเปิดในแอป YouTube"}</div></div></div>
      ${catSelect("")}<button type="button" class="btn primary" data-yt-add>เพิ่มเป็นคลิปเดี่ยว</button>`;
    return;
  }
  const into = d.target === "new" ? null : d.match;
  const seasons = Object.entries(d.seasons || {}).map(([n, c]) => `ซีซั่น ${n}: ${c}`).join(" · ");
  box.innerHTML = `<div class="yt-preview">${vmThumb(d.thumbnail_url)}<div><div class="name">${escapeHtml(d.title)}</div>
      <div class="meta">${escapeHtml(d.channel)} · ${d.count} ตอน${d.first_episode != null ? ` (ตอนที่ ${d.first_episode}–${d.last_episode})` : ""}</div>
      ${seasons ? `<div class="meta">${seasons}</div>` : ""}</div></div>
    ${d.already_added ? `<div class="hint">playlist นี้อยู่ในเรื่อง "${escapeHtml(d.match.name)}" แล้ว — กดเพิ่มเพื่อดึงตอนที่ยังไม่มี</div>` : ""}
    ${d.match ? `<div class="vm-field">เพิ่มเข้า<div class="pl-controls">${ytChoice("target", "match", `เรื่องเดิม: ${escapeHtml(d.match.name)}`, d.target !== "new")}${d.already_added ? "" : ytChoice("target", "new", "แยกเป็นเรื่องใหม่", d.target === "new")}</div></div>` : ""}
    ${into ? "" : `<label class="vm-field">ชื่อเรื่อง<input id="ytName" value="${escapeHtml(d.name)}" maxlength="80" /></label>`}
    <div class="vm-field">ภาษา<div class="pl-controls">${ytChoice("lang", "dub", "พากย์ไทย", d.lang === "dub")}${ytChoice("lang", "sub", "ซับไทย", d.lang === "sub")}${ytChoice("lang", "", "ไม่ระบุ", !d.lang)}</div></div>
    ${into ? "" : catSelect(d.match?.category_id || "")}
    <label class="switch-label">ติดตามตอนใหม่อัตโนมัติ <input type="checkbox" class="switch" id="ytFollow" checked /></label>
    <button type="button" class="btn primary" data-yt-add>${into ? `เพิ่มเข้า "${escapeHtml(into.name)}"` : "เพิ่มเป็นเรื่องใหม่"} (${d.count} ตอน)</button>`;
}

function initYouTubeAdmin() {
  const msg = (text, error = false) => { el("#ytAddMsg").textContent = text; el("#ytAddMsg").classList.toggle("error", error); };
  el("#ytAddForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = event.submitter || el("#ytAddForm button");
    btn.disabled = true;
    msg("กำลังอ่านข้อมูลจาก YouTube...");
    try {
      ytPreviewData = await sendJSON("POST", "/api/youtube/preview", { url: el("#ytAddUrl").value.trim() });
      ytPreviewData.target = ytPreviewData.match ? "match" : "new";
      msg("");
    } catch (e) { ytPreviewData = null; msg(e.message, true); }
    finally { btn.disabled = false; }
    renderYtPreview();
  });
  el("#ytPreview").addEventListener("click", async (event) => {
    const d = ytPreviewData;
    if (!d) return;
    const target = event.target.closest("[data-yt-target]")?.dataset.ytTarget;
    if (target) { d.target = target; return renderYtPreview(); }
    const lang = event.target.closest("[data-yt-lang]");
    if (lang) { d.lang = lang.dataset.ytLang || null; return renderYtPreview(); }
    const add = event.target.closest("[data-yt-add]");
    if (!add) return;
    add.disabled = true;
    msg("กำลังเพิ่ม...");
    try {
      const into = d.kind === "playlist" && d.target !== "new" ? d.match : null;
      const res = await sendJSON("POST", "/api/youtube/add", {
        url: el("#ytAddUrl").value.trim(), playlist_id: into?.id || null, name: el("#ytName")?.value.trim() || "",
        lang: d.lang || null, category_id: el("#ytCategory")?.value || into?.category_id || null,
        follow: el("#ytFollow") ? el("#ytFollow").checked : false,
      });
      msg(d.kind === "video" ? `เพิ่มคลิป "${res.title}" แล้ว` : `เพิ่มเข้า "${res.name}" ${res.added} ตอน${res.exists ? ` (มีอยู่แล้ว ${res.exists})` : ""}`);
      ytPreviewData = null;
      el("#ytAddUrl").value = "";
      renderYtPreview();
      await loadVideos();
      renderVideoManage();
    } catch (e) { msg(e.message, true); add.disabled = false; }
  });
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
    const del = event.target.closest("[data-delete-video-category]")?.dataset.deleteVideoCategory;
    const ren = event.target.closest("[data-rename-video-category]")?.dataset.renameVideoCategory;
    const move = event.target.closest("[data-move-video-category]")?.dataset.moveVideoCategory;
    try {
      if (move) {
        // ลำดับหมวด = ลำดับแถว/ชิปในหน้า MeeMovie
        const ids = (state.videoCategories || []).map((c) => c.id);
        const i = ids.indexOf(event.target.closest("[data-cat-id]").dataset.catId);
        const j = move === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await sendJSON("PUT", "/api/video-categories/order", { ids });
      } else if (del) {
        if (!(await askConfirm("ลบหมวดนี้? (คลิปและเรื่องในหมวดจะกลายเป็นไม่มีหมวด)"))) return;
        await sendJSON("DELETE", `/api/video-categories/${encodeURIComponent(del)}`);
      } else if (ren) {
        const name = prompt("ชื่อหมวดใหม่", categoryName(ren));
        if (!name || !name.trim()) return;
        await sendJSON("PATCH", `/api/video-categories/${encodeURIComponent(ren)}`, { name: name.trim() });
      } else return;
    } catch (e) { toast(e.message, { error: true }); }
    await loadVideos();
    renderVideoManage();
  });
  el("#vmSeg").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-vm-tab]")?.dataset.vmTab;
    if (tab) setVmTab(tab);
  });
  el("#vmPlFilters").addEventListener("click", (event) => {
    const f = event.target.closest("[data-vm-pl-filter]")?.dataset.vmPlFilter;
    if (f) { vmPlFilter = f; renderVideoManage(); }
  });
  el("#vmClipFilters").addEventListener("click", (event) => {
    const f = event.target.closest("[data-vm-clip-filter]")?.dataset.vmClipFilter;
    if (f) { vmClipFilter = f; renderVideoManage(); }
  });
  el("#vmPlSearch").addEventListener("input", debounce(renderVideoManage, 150));
  el("#vmClipSearch").addEventListener("input", debounce(renderVideoManage, 150));
  ["#playlistManageList", "#videoManageList"].forEach((sel) => el(sel).addEventListener("click", (event) => {
    const row = event.target.closest("[data-vm-open]");
    if (row) openVmSheet(row.dataset.vmOpen);
  }));
  el("#vmSheet").addEventListener("click", vmSheetAction);
  el("#vmSheet").addEventListener("change", vmSheetChange);
  initYouTubeAdmin();
  el("#vmSheetBody").addEventListener("change", async (event) => {
    const input = event.target.closest("[data-ep-id]");
    if (!input) return;
    try {
      await sendJSON("PATCH", `/api/videos/${encodeURIComponent(input.dataset.epId)}`, { episode: input.value });
      const v = state.videos.find((x) => x.id === input.dataset.epId);
      if (v) v.episode = Number(input.value);
      input.classList.add("saved");
    } catch (e) { toast(e.message || "บันทึกไม่สำเร็จ", { error: true }); }
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
  if (!el("#confirmSheet").hidden) return closeConfirm(false), true;
  if (!el("#notifPanel").hidden) return toggleNotifPanel(false), true;
  if (!el("#commentSheet").hidden) return closeComments(), true;
  if (!el("#vmSheet").hidden) return closeVmSheet(), true;
  if (!el("#installSheet").hidden) return closeInstallSheet(), true;
  if (!el("#videoFormModal").hidden) return showVideoForm(false), true;
  if (!el("#mangaFormModal").hidden) return closeMangaModal(), true;
  if (!el("#chapterListView").hidden && el("#chapterListView").classList.contains("over-reader")) return closeChapterList(), true;
  if (!el("#reader").hidden) return closeReader(), true;
  if (!el("#videoPlayer").hidden && !isVideoMini()) return closeVideo(), true;
  if (!el("#playlistView").hidden) return closePlaylist(), true;
  if (!el("#chapterListView").hidden) return closeChapterList(), true;
  if (state.tab === "list" && state.homeMode === "history") return setHomeMode("grid"), true;
  if (state.tab === "settings" && settingsPane() !== "main") return showSettingsPane(settingsPane() === "page" ? "hub" : "main"), true;
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
  loadHistory();
  loadVideos();
  initAdminPanels();
  initPlaylistWatch();
  initLibrary();
  initSettingsPanes();
  initConfirmSheet();
  initHomeAutoRefresh();
  initPullToRefresh();
  initAdminSearch();
  initAppShell();
  initEdgeSwipe();
  initAndroidBack();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });

  el("#refreshAllBtn").addEventListener("click", refreshAll);
  el("#readerClose").addEventListener("click", closeReader);
  el("#readerList").addEventListener("click", openChapterListFromReader);
  el("#readerBody").addEventListener("click", (e) => {
    if (e.target.closest(".end-next")) goNextChapter();
    else if (e.target.closest(".end-list")) openChapterListFromReader();
    else if (e.target.closest(".end-comments")) el("#readerComments").click();
    else if (!e.target.closest("button, a, input, .reader-msg")) {
      // แตะที่รูป = โชว์/ซ่อนแถบบน-ล่าง (เดิมต้องเลื่อนขึ้นถึงจะเห็นแถบ เสียตำแหน่งที่อ่านอยู่)
      const hide = !el("#readerTopbar").classList.contains("nav-hidden");
      el("#readerTopbar").classList.toggle("nav-hidden", hide);
      el("#readerBottombar").classList.toggle("nav-hidden", hide);
    }
  });
  el("#chapterListClose").addEventListener("click", closeChapterList);
  el("#readerPrev").addEventListener("click", goPrevChapter);
  el("#readerNext").addEventListener("click", goNextChapter);
}

init();
