"""ตัวกลางหาวิธีเล่นตอนจากแหล่งภายนอก (provider) — ถามแหล่งทุกครั้งที่กดเล่น ไม่ดาวน์โหลด/เก็บไฟล์วิดีโอบนเซิร์ฟเวอร์

provider (เช่น anifume.Provider, a037.Provider) ลงทะเบียนด้วย register() และมี:
    name                         ตรงกับ video["provider"]
    validate_series_url(url)     → URL มาตรฐาน หรือ None
    get_series_metadata(url)     → {"url", "name", "title", "image"}
    get_episode_list(url)        → [{"url"/"id", "title", "episode", ...}]
    get_episode_metadata(url)    → {"url", "title", ...}
    resolve_playback(video, ctx) → Playback (dict) หรือ raise StreamError

Playback = {"kind", "url", "expires_at" (epoch วินาที | None), "frame" (คำแนะนำการวางกรอบ iframe | None)}
    kind: page_embed = ฝังหน้าเว็บของแหล่ง (ตัวเล่นของเขาเอง) / embed = ฝังลิงก์ตัวเล่น
          file = ไฟล์วิดีโอตรง (mp4/webm) / hls = .m3u8 — สองแบบหลังเล่นด้วย <video> ตัวเดิมของแอป
    sources (file) = {"hd", "sd"} หลายความละเอียด / alt = ตัวสำรอง (มักเป็นตัวฝัง) เมื่อ <video> เล่นไม่ได้
Facebook/YouTube ยังใช้ทางเดิม (/sources + ตัวเล่นของ YouTube) ไม่ผ่านโมดูลนี้

ห้าม log URL เต็ม (ลิงก์มีลายเซ็น/โทเคน) — ใช้ redact()
"""
import threading
import time
from urllib.parse import urlsplit

SERIES_PARSE_FAILED = "SERIES_PARSE_FAILED"
EPISODE_LIST_FAILED = "EPISODE_LIST_FAILED"
PLAYER_INFO_MISSING = "PLAYER_INFO_MISSING"
STREAM_RESOLUTION_FAILED = "STREAM_RESOLUTION_FAILED"
STREAM_EXPIRED = "STREAM_EXPIRED"
PLAYBACK_UNSUPPORTED = "PLAYBACK_UNSUPPORTED"
PROVIDER_RESTRICTION = "PROVIDER_RESTRICTION"

KINDS = {"page_embed", "embed", "file", "hls"}
EXPIRY_MARGIN = 60          # หมดอายุภายใน 60 วิ = ถือว่าหมดแล้ว (กันเริ่มเล่นแล้วลิงก์ตายกลางทาง)
MAX_REFRESHES = 2           # ขอใหม่ (refresh) ได้กี่ครั้งต่อตอน ภายใน REFRESH_WINDOW — กันวนไม่รู้จบ
REFRESH_WINDOW = 10 * 60
CACHE_SECONDS = 10 * 60     # ไม่มีวันหมดอายุ: จำไว้ 10 นาที

_providers: dict[str, object] = {}
_cache: dict[tuple, tuple[float, dict]] = {}     # (video id, origin) → (หมดเวลาแคช, playback)
_refreshes: dict[tuple, list[float]] = {}        # (ผู้ใช้, video id) → เวลาที่ขอใหม่ — คนหนึ่งใช้ครบไม่กระทบคนอื่น
_lock = threading.Lock()


class StreamError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable

    def to_dict(self) -> dict:
        return {"code": self.code, "error": self.message, "retryable": self.retryable}


def register(provider):
    _providers[provider.name] = provider
    return provider


def get(name: str | None):
    return _providers.get(name or "")


def redact(url: str | None) -> str:
    """ไว้ log: เหลือแค่โฮสต์ + path ระดับแรก ตัด query (ลายเซ็น/โทเคน) และรหัสวิดีโอใน path ออก"""
    try:
        parts = urlsplit(url or "")
        path = "/".join(parts.path.split("/")[:2])
        return f"{parts.scheme}://{parts.hostname}{path}…" if parts.hostname else "-"
    except ValueError:
        return "-"


def _normalize(playback: dict, provider_name: str) -> dict:
    kind = playback.get("kind")
    url = playback.get("url") or ""
    if kind not in KINDS:
        raise StreamError(PLAYBACK_UNSUPPORTED, f"{provider_name}: รูปแบบตัวเล่นที่แอปไม่รองรับ ({kind})")
    try:
        parts = urlsplit(url)
    except ValueError:
        parts = None
    own = kind == "hls" and url.startswith("/api/videos/") and ".." not in url  # ไฟล์รายการที่เซิร์ฟเวอร์เราส่งต่อให้
    if not own and (not parts or parts.scheme != "https" or not parts.hostname):
        raise StreamError(PLAYER_INFO_MISSING, f"{provider_name}: ไม่ได้ลิงก์ตัวเล่นที่ใช้ได้")
    alt = playback.get("alt")
    if alt:
        try:
            alt = _normalize(alt, provider_name)
            alt.pop("alt", None)
        except StreamError:
            alt = None
    expires = playback.get("expires_at")
    # file หลายความละเอียด: {"hd": ..., "sd": ...} ลิงก์ https เท่านั้น (ตัวเล่นแอปเลือก 720p/360p)
    sources = {q: u for q, u in (playback.get("sources") or {}).items()
               if kind == "file" and q in ("hd", "sd") and isinstance(u, str) and u.startswith("https://")} or None
    return {"kind": kind, "url": url, "expires_at": float(expires) if expires else None, "sources": sources,
            "frame": playback.get("frame"), "provider": provider_name,
            # "none" = ฝังโดยไม่ส่ง Referer (ตัวเล่นที่ปฏิเสธเมื่อเห็นชื่อเว็บอื่น เช่น 108player)
            "referrer": "none" if playback.get("referrer") == "none" else None, "alt": alt}


def _expired(playback: dict, now: float) -> bool:
    return bool(playback["expires_at"]) and playback["expires_at"] - EXPIRY_MARGIN <= now


def resolve(video: dict, *, refresh: bool = False, ctx: dict | None = None, now: float | None = None) -> dict:
    """วิธีเล่นของตอนนี้ — ใช้แคชถ้ายังไม่หมดอายุ; refresh=True (ตัวเล่นแจ้งว่าลิงก์ใช้ไม่ได้แล้ว) ขอใหม่จากแหล่ง
    ได้ไม่เกิน MAX_REFRESHES ครั้งใน REFRESH_WINDOW เกินแล้ว STREAM_EXPIRED (ให้ผู้ใช้เปิดหน้าต้นฉบับแทน)"""
    now = time.time() if now is None else now
    provider = get(video.get("provider"))
    if not provider:
        raise StreamError(PLAYBACK_UNSUPPORTED, "แหล่งนี้ไม่ได้เล่นผ่านตัวหาวิธีเล่น")
    ctx = ctx or {}
    vid = video["id"]
    key, rkey = (vid, ctx.get("origin") or ""), (ctx.get("user") or "", vid)
    with _lock:
        cached = _cache.get(key)
        if refresh:
            recent = [t for t in _refreshes.get(rkey, []) if now - t < REFRESH_WINDOW]
            if len(recent) >= MAX_REFRESHES:
                raise StreamError(STREAM_EXPIRED, "ขอลิงก์ตัวเล่นใหม่หลายครั้งแล้วยังเล่นไม่ได้ — เปิดหน้าต้นฉบับแทน")
            _refreshes[rkey] = recent + [now]
            _cache.pop(key, None)
        elif cached and cached[0] > now and not _expired(cached[1], now):
            return cached[1]
    try:
        playback = _normalize(provider.resolve_playback(video, ctx), provider.name)
    except StreamError:
        raise
    except Exception as e:  # แหล่งเปลี่ยนหน้าเว็บ/ล่ม — บอกชนิดปัญหา ไม่ส่งข้อความดิบที่อาจมี URL
        raise StreamError(STREAM_RESOLUTION_FAILED, f"{provider.name}: หาวิธีเล่นไม่สำเร็จ ({e.__class__.__name__})",
                          retryable=True) from None
    if _expired(playback, now):
        raise StreamError(STREAM_EXPIRED, f"{provider.name}: ลิงก์ที่ได้หมดอายุแล้ว", retryable=True)
    ttl = min(CACHE_SECONDS, playback["expires_at"] - EXPIRY_MARGIN - now) if playback["expires_at"] else CACHE_SECONDS
    with _lock:
        _cache[key] = (now + ttl, playback)
    return playback


def clear():
    with _lock:
        _cache.clear()
        _refreshes.clear()


def hls_playlist(master_url: str, fetch, own_url: str, variant: str | None, *,
                 segment=lambda url: url, variant_ok=lambda url: True) -> str:
    """ไฟล์รายการ HLS ที่เซิร์ฟเวอร์ส่งต่อให้ <video>/hls.js (/api/videos/<id>/stream.m3u8)
    variant None = master: แต่ละความละเอียดชี้กลับมาที่ own_url?v=<ลำดับ> (เลือกได้/อัตโนมัติใน hls.js)
    variant "<n>" = ไฟล์รายการย่อยตัวที่ n: ลิงก์ท่อนเป็นลิงก์เต็ม https ผ่าน segment() (เช่น เซ็นให้ Worker)
    master ที่จริงเป็นไฟล์ย่อยเลย (ไม่มี STREAM-INF) = ความละเอียดเดียว ?v=0
    fetch(url) → ข้อความ; ผิดรูปแบบ raise ValueError (หน้าเว็บสลับไปตัวสำรองเอง)"""
    from urllib.parse import urljoin
    text = fetch(master_url)
    if not text.lstrip().startswith("#EXTM3U"):
        raise ValueError("ไฟล์รายการวิดีโอไม่ใช่ HLS")
    variants, inf = [], None
    if "#EXT-X-STREAM-INF" in text:
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("#EXT-X-STREAM-INF"):
                inf = line
            elif line and not line.startswith("#") and inf:
                url = urljoin(master_url, line)
                if url.startswith("https://") and variant_ok(url):
                    variants.append((inf, url))
                inf = None
        if not variants:
            raise ValueError("ไฟล์รายการวิดีโอไม่มีความละเอียดให้เลือก")
    else:
        variants = [("#EXT-X-STREAM-INF:BANDWIDTH=1", master_url)]
    if variant is None:
        lines = ["#EXTM3U"]
        for i, (inf, _) in enumerate(variants):
            lines += [inf, f"{own_url}?v={i}"]
        return "\n".join(lines) + "\n"
    if not variant.isdigit() or int(variant) >= len(variants):
        raise ValueError("ไม่มีความละเอียดนี้")
    url = variants[int(variant)][1]
    text = text if url == master_url else fetch(url)
    if not text.lstrip().startswith("#EXTM3U") or "#EXTINF" not in text:
        raise ValueError("ไฟล์รายการวิดีโอว่าง (เว็บอาจเปลี่ยนวิธี)")
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-KEY") or line.startswith("#EXT-X-MAP"):
            raise ValueError("ไฟล์วิดีโอแบบเข้ารหัส/แยกหัวไฟล์ — ยังไม่รองรับ")
        if line and not line.startswith("#"):
            seg = urljoin(url, line)
            if not seg.startswith("https://"):
                raise ValueError("ลิงก์ท่อนวิดีโอไม่ใช่ https")
            line = segment(seg)
        out.append(line)
    return "\n".join(out) + "\n"
