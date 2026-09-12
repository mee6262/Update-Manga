import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

DATA_DIR = Path(__file__).parent / "data"
MANGA_FILE = DATA_DIR / "manga.json"
CHAPTERS_DIR = DATA_DIR / "chapters"
IMAGE_DOMAINS_FILE = DATA_DIR / "image_domains.json"
USERS_FILE = DATA_DIR / "users.json"
USERS_DIR = DATA_DIR / "users"

DATA_DIR.mkdir(exist_ok=True)
CHAPTERS_DIR.mkdir(exist_ok=True)
USERS_DIR.mkdir(exist_ok=True)


def make_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]


def _load_json(path: Path, default):
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def load_manga() -> list[dict]:
    return _load_json(MANGA_FILE, [])


def save_manga(items: list[dict]):
    _save_json(MANGA_FILE, items)


# ---------- ผู้ใช้ ----------

def load_users() -> dict:
    """username -> {"password_hash": ..., "is_admin": bool}"""
    return _load_json(USERS_FILE, {})


def save_users(users: dict):
    _save_json(USERS_FILE, users)


def user_dir(username: str) -> Path:
    d = USERS_DIR / username
    d.mkdir(exist_ok=True)
    return d


# ---------- ข้อมูลรายคน (อ่านแล้ว/ติดตามเรื่องไหนบ้าง) ----------

def load_read_state(username: str) -> dict:
    return _load_json(user_dir(username) / "read_state.json", {})


def save_read_state(username: str, state: dict):
    _save_json(user_dir(username) / "read_state.json", state)


def load_subscriptions(username: str) -> list[str]:
    return _load_json(user_dir(username) / "subscriptions.json", [])


def save_subscriptions(username: str, manga_ids: list[str]):
    _save_json(user_dir(username) / "subscriptions.json", manga_ids)


def all_usernames() -> list[str]:
    return list(load_users().keys())


def load_prefs(username: str) -> dict:
    return _load_json(user_dir(username) / "prefs.json", {})


def save_prefs(username: str, prefs: dict):
    _save_json(user_dir(username) / "prefs.json", prefs)


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


def get_allowed_domains() -> set[str]:
    domains = load_image_domains()
    for m in load_manga():
        domains.add(urlparse(m["url"]).netloc)
        if m.get("latest_chapter_url"):
            domains.add(urlparse(m["latest_chapter_url"]).netloc)
        if m.get("cover_url"):
            domains.add(urlparse(m["cover_url"]).netloc)
    return domains


def chapter_cache_path(manga_id: str, chapter_url: str) -> Path:
    key = hashlib.sha1(chapter_url.encode("utf-8")).hexdigest()[:16]
    return CHAPTERS_DIR / f"{manga_id}__{key}.json"


def load_chapter_cache(manga_id: str, chapter_url: str) -> dict | None:
    path = chapter_cache_path(manga_id, chapter_url)
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_chapter_cache(manga_id: str, chapter_url: str, data: dict):
    _save_json(chapter_cache_path(manga_id, chapter_url), data)
