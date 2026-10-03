// ข้อมูลชุดแรก (ผู้ใช้ปัจจุบัน + เรื่องที่ติดตาม + ค่าตั้งค่า) ฝังมากับหน้า HTML แล้ว (ดู index())
// หน้าแรกจึงขึ้นได้ทันทีโดยไม่ต้องรอยิง API ต่อกันหลายรอบก่อนจะวาดอะไรได้
const BOOT = window.__BOOT__ || {};

const state = {
  manga: BOOT.manga || [],
  catalog: [],
  prefs: BOOT.prefs || {},
  currentUser: BOOT.me || { username: null, is_admin: false },
  videos: [],
  videoCursor: null,
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
  el("#accountName").textContent = state.currentUser.username || "ผู้ใช้";
  el("#accountRole").textContent = state.currentUser.is_admin ? "ผู้ดูแลระบบ" : "สมาชิก";
}

// ---------- Tabs (เมนูล่าง) ----------
// วาดจากข้อมูลที่มีอยู่ทันที แล้วค่อยดึงของใหม่มาอัปเดตทีหลัง (ไม่ปล่อยจอว่างรอเน็ต)
function showTab(tab) {
  state.tab = tab;
  document.body.dataset.tab = tab;
  els(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  els(".view").forEach((v) => v.classList.toggle("active", v.id === `${tab}View`));
  els(".topbar-title").forEach((t) => { t.hidden = t.dataset.for !== tab; });
  updateCategoryBar();
  window.scrollTo(0, 0);

  if (tab === "catalog") {
    renderCatalog(filterCatalog());
    loadCatalog().then(() => renderCatalog(filterCatalog()));
  }
  if (tab === "search") {
    renderSearch();
    loadCatalog().then(renderSearch);
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

// ---------- หนังสั้น AI (Facebook Embed) ----------
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
  return `<button class="video-card" data-video-id="${escapeHtml(video.id)}"><span class="video-media">${image}${resume}</span><span class="video-card-info"><span class="video-card-title">${escapeHtml(video.title)}</span><span class="video-card-meta">เพิ่มโดย ${escapeHtml(video.added_by)} · ${timeAgo(video.created_at)}</span></span></button>`;
}

function renderVideos() {
  el("#videoGrid").innerHTML = state.videos.map(videoCardHtml).join("");
  el("#videoEmpty").hidden = state.videos.length > 0;
  el("#videoMoreBtn").hidden = !state.videoCursor;
}

async function loadVideos(append = false) {
  if (videoLoading) return;
  videoLoading = true;
  try {
    const qs = append && state.videoCursor ? `?cursor=${encodeURIComponent(state.videoCursor)}` : "";
    const data = await getJSON(`/api/videos${qs}`);
    state.videos = append ? state.videos.concat(data.items || []) : (data.items || []);
    state.videoCursor = data.next_cursor || null;
    renderVideos();
  } catch (e) {
    if (!append) el("#videoGrid").innerHTML = `<div class="reader-msg">${escapeHtml(e.body?.error || "โหลดคลิปไม่สำเร็จ")}</div>`;
  } finally {
    videoLoading = false;
  }
}

function showVideoForm(show) {
  el("#videoFormModal").hidden = !show;
  if (show) el("#videoForm [name=title]").focus();
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
      player.subscribe("finishedPlaying", () => { stopVideoClock(); clearActiveVideoProgress(); });
    } catch (e) { /* SDK บางรุ่นไม่มี event เหล่านี้ */ }
    return player;
  });
}

async function openVideo(video) {
  activeVideo = video;
  activeFbPlayer = null;
  activeVideoDuration = Number(video.duration_seconds) || null;
  lastSavedVideoPosition = null;
  activeVideoFinished = false;
  videoApiWorks = false;
  videoClockBase = 0;
  videoClockStartedAt = null;
  el("#videoPlayerTitle").textContent = video.title;
  el("#videoDeleteBtn").hidden = !video.can_delete;
  el("#videoPlayer").hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const progress = await getJSON(`/api/videos/${encodeURIComponent(video.id)}/progress`);
    if (!activeVideo || activeVideo.id !== video.id) return;
    await mountFacebookVideo(video, Number(progress.position_seconds) || 0);
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
  lastSavedVideoPosition = 0;
}

function closeVideo() {
  stopVideoClock();
  saveActiveVideoProgress(true);
  clearInterval(videoSaveTimer);
  videoSaveTimer = null;
  activeFbPlayer = null;
  activeVideo = null;
  activeVideoFinished = false;
  el("#videoPlayer").hidden = true;
  el("#videoDeleteBtn").hidden = true;
  el("#videoPlayerBody").innerHTML = '<div class="reader-msg">กำลังโหลด...</div>';
  document.body.style.overflow = "";
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
  el("#videoGrid").addEventListener("click", (event) => {
    const card = event.target.closest(".video-card");
    const video = state.videos.find((item) => item.id === card?.dataset.videoId);
    if (video) openVideo(video);
  });
  el("#videoMoreBtn").addEventListener("click", () => loadVideos(true));
  el("#videoPlayerClose").addEventListener("click", closeVideo);
  window.addEventListener("pagehide", () => { stopVideoClock(); saveActiveVideoProgress(true); });
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
    el("#searchCount").textContent = items.length ? `พบ ${items.length} เรื่อง` : `ไม่พบเรื่องที่ตรงกับ "${q}"`;
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

function initSearch() {
  el("#searchInput").addEventListener("input", debounce(renderSearch, 120));
  // กด "ค้นหา" บนแป้นมือถือ = ปิดแป้น ให้เห็นผลเต็มจอ
  el("#searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
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
  empty.hidden = state.manga.length > 0 || state.homeMode !== "grid";

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

function setPushButton(on) {
  const btn = el("#pushBtn");
  btn.classList.toggle("push-on", on);
  btn.title = on ? "แจ้งเตือนเปิดอยู่ (แตะเพื่อปิด)" : "เปิดแจ้งเตือนตอนใหม่";
}

async function pushRegistration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function initPush() {
  const btn = el("#pushBtn");
  if (!BOOT.push_key || !state.currentUser.username) return; // เซิร์ฟเวอร์ไม่ได้เปิดระบบนี้ / ไม่ได้ login
  if (!pushSupported && !isIOS) return; // เบราว์เซอร์ไม่รองรับเลย ซ่อนปุ่มไป
  btn.hidden = false;
  btn.addEventListener("click", togglePush);

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
        ? "iPhone/iPad รับแจ้งเตือนได้เฉพาะตอนเปิดจากไอคอนบนหน้าจอโฮม\n\n1. กดปุ่มแชร์ (สี่เหลี่ยมมีลูกศรขึ้น)\n2. เลือก \"เพิ่มไปยังหน้าจอโฮม\"\n3. เปิดเว็บจากไอคอนนั้น แล้วกดกระดิ่งอีกครั้ง\n\n(ต้องเป็น iOS 16.4 ขึ้นไป)"
        : "เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองเปิดด้วย Chrome หรือ Safari เวอร์ชันล่าสุด"
    );
    return;
  }
  const btn = el("#pushBtn");
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
function openFromUrl(url) {
  const id = url.searchParams.get("manga");
  if (!id) return;
  history.replaceState(null, "", "/");
  el("#reader").hidden = true;
  const manga = mangaById(id);
  if (manga) openChapterList(manga);
  else loadManga().then(() => mangaById(id) && openChapterList(mangaById(id)));
}

function init() {
  applyAdminGating();
  renderGrid();
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
