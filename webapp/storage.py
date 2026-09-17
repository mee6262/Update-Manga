import hashlib
import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

DATA_DIR = Path(__file__).parent / "data"
MANGA_FILE = DATA_DIR / "manga.json"
CHAPTERS_DIR = DATA_DIR / "chapters"
COVERS_DIR = DATA_DIR / "covers"
IMAGE_DOMAINS_FILE = DATA_DIR / "image_domains.json"
USERS_FILE = DATA_DIR / "users.json"
USERS_DIR = DATA_DIR / "users"

DATA_DIR.mkdir(exist_ok=True)
CHAPTERS_DIR.mkdir(exist_ok=True)
COVERS_DIR.mkdir(exist_ok=True)
USERS_DIR.mkdir(exist_ok=True)


def make_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]


# ---------- JSON cache ----------
# เก็บผล parse ไว้ในหน่วยความจำ ตรวจความสดด้วย (mtime_ns, size) ของไฟล์ — ทุก request แค่ stat()
# ไม่ต้องอ่าน+parse ใหม่ และใช้ได้ข้าม gunicorn หลาย worker เพราะอีก process เขียนไฟล์ mtime ก็เปลี่ยน
# ค่าที่ได้จาก cache (fresh=False) เป็นของที่แชร์กันทั้ง process ห้ามแก้ไขตรง ๆ — โค้ดที่จะแก้แล้ว
# save กลับต้องขอ fresh=True เสมอ (ได้ object ใหม่จากดิสก์ ไม่กระทบคนอื่นที่อ่านอยู่พร้อมกัน)
_cache: dict[Path, tuple[tuple[int, int], object]] = {}
_cache_lock = threading.Lock()


def _stat_sig(path: Path):
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _read_json(path: Path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def _load_json(path: Path, default, fresh: bool = False):
    if fresh:
        return _read_json(path, default)
    sig = _stat_sig(path)
    if sig is None:
        return default
    hit = _cache.get(path)
    if hit and hit[0] == sig:
        return hit[1]
    data = _read_json(path, default)
    with _cache_lock:
        _cache[path] = (sig, data)
    return data


def _atomic_replace(tmp: Path, path: Path):
    """ย้ายไฟล์ชั่วคราวทับไฟล์จริง — บน Windows ถ้ามี thread/process อื่นกำลังเปิดอ่านไฟล์ปลายทางอยู่
    พอดี การเขียนทับจะล้มด้วย PermissionError (Linux ไม่มีปัญหานี้) ลองใหม่สั้น ๆ ไม่กี่ครั้งก็ผ่าน
    เพราะการอ่านไฟล์ใช้เวลาแค่ไม่กี่มิลลิวินาที"""
    for attempt in range(5):
        try:
            tmp.replace(path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.05)


def _save_json(path: Path, data, compact: bool = False):
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=2)
    _atomic_replace(tmp, path)
    with _cache_lock:
        _cache.pop(path, None)


def load_manga(fresh: bool = False) -> list[dict]:
    return _load_json(MANGA_FILE, [], fresh)


def save_manga(items: list[dict]):
    _save_json(MANGA_FILE, items)


def get_manga(manga_id: str) -> dict | None:
    """หาเรื่องจาก id แบบอ่านอย่างเดียว (ใช้ index ที่ cache ไว้ ไม่ต้องไล่ลิสต์ทุกครั้ง)"""
    return _manga_index().get(manga_id)


_index_memo: tuple[list, dict] | None = None


def _manga_index() -> dict:
    global _index_memo
    items = load_manga()
    memo = _index_memo
    if memo and memo[0] is items:
        return memo[1]
    index = {m["id"]: m for m in items if m.get("id")}
    _index_memo = (items, index)
    return index


# ---------- ผู้ใช้ ----------

def load_users(fresh: bool = False) -> dict:
    """username -> {"password_hash": ..., "is_admin": bool}"""
    return _load_json(USERS_FILE, {}, fresh)


def save_users(users: dict):
    _save_json(USERS_FILE, users)


def user_dir(username: str) -> Path:
    d = USERS_DIR / username
    d.mkdir(exist_ok=True)
    return d


def _user_file(username: str, name: str) -> Path:
    return USERS_DIR / username / name


def _save_user_file(username: str, name: str, data):
    d = USERS_DIR / username
    d.mkdir(exist_ok=True)
    _save_json(d / name, data)


# ---------- ข้อมูลรายคน (อ่านแล้ว/ติดตามเรื่องไหนบ้าง) ----------

def load_read_state(username: str, fresh: bool = False) -> dict:
    return _load_json(_user_file(username, "read_state.json"), {}, fresh)


def save_read_state(username: str, state: dict):
    _save_user_file(username, "read_state.json", state)


def load_subscriptions(username: str, fresh: bool = False) -> list[str]:
    return _load_json(_user_file(username, "subscriptions.json"), [], fresh)


def save_subscriptions(username: str, manga_ids: list[str]):
    _save_user_file(username, "subscriptions.json", manga_ids)


def all_usernames() -> list[str]:
    return list(load_users().keys())


def load_prefs(username: str, fresh: bool = False) -> dict:
    return _load_json(_user_file(username, "prefs.json"), {}, fresh)


def save_prefs(username: str, prefs: dict):
    _save_user_file(username, "prefs.json", prefs)


def load_image_domains() -> set[str]:
    return set(_load_json(IMAGE_DOMAINS_FILE, []))


def add_image_domains(domains: set[str]):
    """จำโดเมน CDN รูปภาพที่เจอจากการ scrape จริง (เช่น img3.sing-manga.com, i0.wp.com)
    ไว้อนุญาตให้ /api/img พร็อกซีได้ โดยไม่ต้องเปิดเป็น proxy โดเมนอะไรก็ได้"""
    domains = {d for d in domains if d}
    if not domains:
        return
    existing = load_image_domains()
    if domains <= existing:
        return
    _save_json(IMAGE_DOMAINS_FILE, sorted(existing | domains))


_allowed_memo: tuple[tuple[list, list], set[str]] | None = None


def get_allowed_domains() -> set[str]:
    """เรียกทุกครั้งที่พร็อกซีรูป (ตอนหนึ่งมีหลายสิบรูป) — คำนวณใหม่เฉพาะตอน manga.json หรือ
    image_domains.json เปลี่ยนเท่านั้น"""
    global _allowed_memo
    manga_items = load_manga()
    raw_domains = _load_json(IMAGE_DOMAINS_FILE, [])
    memo = _allowed_memo
    if memo and memo[0][0] is manga_items and memo[0][1] is raw_domains:
        return memo[1]

    domains = set(raw_domains)
    for m in manga_items:
        for src in m.get("sources") or [{"url": m.get("url")}]:
            if src.get("url"):
                domains.add(urlparse(src["url"]).netloc)
        if m.get("latest_chapter_url"):
            domains.add(urlparse(m["latest_chapter_url"]).netloc)
        if m.get("cover_url"):
            domains.add(urlparse(m["cover_url"]).netloc)
    _allowed_memo = ((manga_items, raw_domains), domains)
    return domains


def chapter_cache_path(manga_id: str, chapter_url: str) -> Path:
    key = hashlib.sha1(chapter_url.encode("utf-8")).hexdigest()[:16]
    return CHAPTERS_DIR / f"{manga_id}__{key}.json"


def load_chapter_cache(manga_id: str, chapter_url: str) -> dict | None:
    # อ่านจากดิสก์ตรง ๆ ทุกครั้ง (ไม่เข้า memory cache) เพราะมีได้เป็นพัน ๆ ไฟล์ และ caller แก้ dict ต่อ
    return _read_json(chapter_cache_path(manga_id, chapter_url), None)


def save_chapter_cache(manga_id: str, chapter_url: str, data: dict):
    _save_json(chapter_cache_path(manga_id, chapter_url), data, compact=True)


# ---------- รูปปกที่ย่อแล้ว ----------

def cover_cache_path(src: str, width: int) -> Path:
    key = hashlib.sha1(src.encode("utf-8")).hexdigest()[:16]
    return COVERS_DIR / f"{key}_{width}.webp"


def load_cover_cache(src: str, width: int) -> bytes | None:
    try:
        return cover_cache_path(src, width).read_bytes()
    except FileNotFoundError:
        return None


def save_cover_cache(src: str, width: int, data: bytes):
    path = cover_cache_path(src, width)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    _atomic_replace(tmp, path)
