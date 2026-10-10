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
    if not parts or parts.scheme != "https" or not parts.hostname:
        raise StreamError(PLAYER_INFO_MISSING, f"{provider_name}: ไม่ได้ลิงก์ตัวเล่นที่ใช้ได้")
    expires = playback.get("expires_at")
    return {"kind": kind, "url": url, "expires_at": float(expires) if expires else None,
            "frame": playback.get("frame"), "provider": provider_name}


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
