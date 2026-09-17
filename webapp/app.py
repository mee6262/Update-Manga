import gzip
import hmac
import io
import os
import re
import secrets
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, Response, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import scraper
import storage
from telegram_notify import send_telegram

try:
    from PIL import Image, ImageOps
except ImportError:
    # ไม่มี Pillow ก็ยังใช้งานได้ปกติ แค่ส่งรูปต้นฉบับไปตรง ๆ ไม่ย่อให้
    Image = ImageOps = None

# โหลด .env จาก root ของโปรเจกต์ (ไฟล์เดียวกับที่ใช้ทั้ง Linux/Windows ไม่ต้องพึ่ง export/set เอง)
load_dotenv(Path(__file__).parent.parent / ".env")

STATIC_MAX_AGE = 365 * 24 * 3600


class MangaApp(Flask):
    def get_send_file_max_age(self, filename):
        # ไฟล์ static ที่มี ?v=<mtime> (ใส่ให้อัตโนมัติผ่าน url_for) แคชได้ยาวเป็นปี เพราะแก้ไฟล์เมื่อไหร่
        # URL ก็เปลี่ยนเอง ส่วนที่ไม่มี v (เช่นไอคอนที่อ้างจาก manifest.json) แคชแค่ 1 วัน
        return STATIC_MAX_AGE if request.args.get("v") else 86400


app = MangaApp(__name__)

# SECRET_KEY ต้องคงที่ (ใส่ใน .env) ไม่งั้น session จะหลุดทุกครั้งที่รีสตาร์ทแอป
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.permanent_session_lifetime = timedelta(days=90)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,
    # ไม่ต่ออายุ cookie ทุก request (ไม่งั้นทุกรูป/ทุก API ได้ Set-Cookie ค่าใหม่ ทำให้ browser cache
    # ที่ Vary: Cookie ใช้ไม่ได้เลย) — ต่ออายุเฉพาะตอนเปิดหน้าเว็บแทน (ดู index())
    SESSION_REFRESH_EACH_REQUEST=False,
)
app.json.sort_keys = False

COMPRESSIBLE_MIMETYPES = {
    "application/json",
    "text/html",
    "text/css",
    "text/javascript",
    "application/javascript",
    "application/manifest+json",
    "image/svg+xml",
}
NO_VARY_COOKIE_ENDPOINTS = {"static", "proxy_image"}


@app.url_defaults
def _static_cache_buster(endpoint, values):
    if endpoint == "static" and "filename" in values and "v" not in values:
        try:
            values["v"] = int(os.stat(Path(app.static_folder) / values["filename"]).st_mtime)
        except OSError:
            pass


@app.after_request
def _optimize_response(response):
    if request.endpoint in NO_VARY_COOKIE_ENDPOINTS:
        # เนื้อหาเหมือนกันทุกคน อย่าให้ cache แยกตาม cookie
        response.vary.discard("Cookie")
        if request.endpoint == "static" and request.args.get("v"):
            response.cache_control.immutable = True

    if (
        request.method == "GET"
        and response.status_code == 200
        and response.mimetype == "application/json"
        and request.path.startswith("/api/")
    ):
        # ให้ browser ถามซ้ำได้ด้วย If-None-Match แล้วได้ 304 เปล่า ๆ ถ้าข้อมูลไม่เปลี่ยน
        response.cache_control.private = True
        response.cache_control.no_cache = True
        response.add_etag(weak=True)
        response.make_conditional(request)

    _maybe_gzip(response)
    return response


def _maybe_gzip(response):
    if (
        response.status_code != 200
        or response.mimetype not in COMPRESSIBLE_MIMETYPES
        or response.headers.get("Content-Encoding")
        or "gzip" not in request.headers.get("Accept-Encoding", "").lower()
        or response.is_streamed and not response.direct_passthrough
    ):
        return
    if response.direct_passthrough:
        # ไฟล์ static (send_file) — อ่านเข้ามาบีบอัดเองได้เพราะไฟล์เล็ก และหลังแคชแล้วแทบไม่โดนเรียกซ้ำ
        response.direct_passthrough = False
    data = response.get_data()
    if len(data) < 1024:
        return
    response.set_data(gzip.compress(data, compresslevel=6))
    response.headers["Content-Encoding"] = "gzip"
    response.vary.add("Accept-Encoding")
    etag, weak = response.get_etag()
    if etag and not weak:
        response.set_etag(etag, weak=True)

WEB_USERNAME = os.environ.get("WEB_USERNAME")
WEB_PASSWORD = os.environ.get("WEB_PASSWORD")

# โทเคนสำหรับให้ refresh_cron.py/refresh_loop.py เรียก /api/refresh_all ได้เองโดยไม่ต้อง login
# (ใช้ header แทน ไม่ใช้ remote_addr==127.0.0.1 เพราะ Caddy ก็ proxy มาจาก 127.0.0.1 เหมือนกัน
# เช็คแค่ IP จะเท่ากับเปิดช่องให้ใครก็ได้จากอินเทอร์เน็ตข้าม login ได้)
CRON_TOKEN = os.environ.get("CRON_TOKEN")

REQUEST_DELAY = 1.0  # เว้นระยะคำขอไปเว็บเดียวกันตอน refresh ทั้งหมด กันโดน block
REFRESH_WORKERS = 4  # เว็บต่างกันดึงพร้อมกันได้ (เว็บเดียวกันยังเว้นระยะตาม REQUEST_DELAY)


def _bootstrap_first_admin():
    """ครั้งแรกที่รันหลังอัปเดตเป็นระบบหลายผู้ใช้: ย้าย WEB_USERNAME/WEB_PASSWORD เดิมจาก .env
    มาเป็นบัญชี admin คนแรกในระบบ พร้อมย้ายประวัติการอ่านเดิม (read_state.json แบบเก่า) และตั้งให้
    ติดตามทุกเรื่องที่มีอยู่แล้ว (ของเดิมเห็นทุกเรื่องหมดอยู่แล้วก่อนจะมีระบบติดตามรายคน)"""
    if storage.load_users():
        return
    if not WEB_USERNAME or not WEB_PASSWORD:
        return

    storage.save_users(
        {WEB_USERNAME: {"password_hash": generate_password_hash(WEB_PASSWORD), "is_admin": True}}
    )

    legacy_read_state = storage.DATA_DIR / "read_state.json"
    new_read_state = storage.user_dir(WEB_USERNAME) / "read_state.json"
    if legacy_read_state.exists() and not new_read_state.exists():
        shutil.copy(legacy_read_state, new_read_state)

    storage.save_subscriptions(WEB_USERNAME, [m["id"] for m in storage.load_manga()])


def _migrate_manga_sources():
    """ของเดิมมีแค่ manga["url"] เดียว ก่อนจะรองรับหลายแหล่งที่มาต่อเรื่อง ย้ายให้เป็น
    manga["sources"] = [{"url": ...}] ครั้งเดียวตอนสตาร์ท กันโค้ดที่เหลือต้องเช็ค key ไม่มีอยู่ทุกที่"""
    manga_items = storage.load_manga(fresh=True)
    changed = False
    for m in manga_items:
        if not m.get("sources") and m.get("url"):
            m["sources"] = [{"url": m["url"]}]
            changed = True
    if changed:
        storage.save_manga(manga_items)


_bootstrap_first_admin()
_migrate_manga_sources()


def current_username():
    return session.get("user")


def is_admin() -> bool:
    return bool(session.get("is_admin"))


def admin_usernames() -> list[str]:
    users = storage.load_users()
    return [u for u, info in users.items() if info.get("is_admin")]


def require_admin(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        # ไม่มีผู้ใช้ในระบบเลย (dev บนเครื่องตัวเอง ไม่เคยตั้ง WEB_USERNAME/WEB_PASSWORD) ปล่อยผ่าน
        # เหมือน require_login ไม่งั้น dev mode จะใช้ปุ่ม admin อะไรไม่ได้เลยสักอย่าง
        if not storage.load_users():
            return view(*args, **kwargs)
        if not is_admin():
            return jsonify({"error": "เฉพาะ admin เท่านั้น"}), 403
        return view(*args, **kwargs)

    return wrapper


@app.before_request
def require_login():
    if request.endpoint in ("login", "static"):
        return None
    # ถ้ายังไม่มีผู้ใช้ในระบบเลย (เช่น dev บนเครื่องตัวเอง ไม่เคยตั้ง WEB_USERNAME/WEB_PASSWORD)
    # ปล่อยผ่านไม่บังคับ login
    if not storage.load_users():
        return None
    if (
        request.endpoint == "refresh_all"
        and CRON_TOKEN
        and hmac.compare_digest(request.headers.get("X-Cron-Token", ""), CRON_TOKEN)
    ):
        return None
    if current_username():
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "unauthorized"}), 401
    return redirect(url_for("login", next=request.path))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        users = storage.load_users()
        user = users.get(username)
        if user and check_password_hash(user["password_hash"], password):
            session.permanent = True
            session["user"] = username
            session["is_admin"] = bool(user.get("is_admin"))
            return redirect(request.args.get("next") or url_for("index"))
        error = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/api/prefs", methods=["POST"])
def update_prefs():
    # ค่าตั้งค่าส่วนตัว (เช่น ลำดับการเรียงเรื่องทั้งหมด) เก็บแยกบัญชีใครบัญชีมัน — ตอนอ่านไม่มี
    # endpoint แยก เพราะส่งไปพร้อมหน้าเว็บตั้งแต่แรกแล้ว (ดู index())
    # dev mode ที่ไม่มีบัญชี (current_username()==None) ไม่ต้องจำอะไรเลย
    if not current_username():
        return jsonify({"ok": True})
    body = request.get_json(force=True) or {}
    prefs = storage.load_prefs(current_username(), fresh=True)
    prefs.update(body)
    storage.save_prefs(current_username(), prefs)
    return jsonify({"ok": True})


@app.route("/api/users", methods=["GET"])
@require_admin
def list_users():
    users = storage.load_users()
    return jsonify([{"username": u, "is_admin": bool(info.get("is_admin"))} for u, info in users.items()])


@app.route("/api/users", methods=["POST"])
@require_admin
def add_user():
    body = request.get_json(force=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    new_is_admin = bool(body.get("is_admin"))

    if not username or not password:
        return jsonify({"error": "ต้องระบุชื่อผู้ใช้และรหัสผ่าน"}), 400
    if len(password) < 4:
        return jsonify({"error": "รหัสผ่านสั้นเกินไป"}), 400

    users = storage.load_users(fresh=True)
    if username in users:
        return jsonify({"error": "มีชื่อผู้ใช้นี้อยู่แล้ว"}), 409

    users[username] = {"password_hash": generate_password_hash(password), "is_admin": new_is_admin}
    storage.save_users(users)
    # สมาชิกใหม่เริ่มจากไม่ติดตามอะไรเลย ไปเลือกเองที่หน้า "เรื่องทั้งหมด"
    storage.save_subscriptions(username, [])
    return jsonify({"username": username, "is_admin": new_is_admin}), 201


def _normalize_host(netloc: str) -> str:
    """แปลงโดเมนให้เป็นรูปแบบเดียวกันก่อนเทียบ กันเว็บที่ใช้โดเมนภาษาไทย/unicode (IDN) ตรง ๆ
    เช่น สดใสเมะ.com แต่ลิงก์ตอน/รูปภายในเพจ (ที่ scrape มา) กลับเป็น punycode
    (www.xn--l3c0azab5a2gta.com) — ถ้าเทียบ string ตรง ๆ จะเข้าใจผิดว่าเป็นคนละโดเมน"""
    host = netloc.split(":")[0].lower()
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        return host


def _source_domains(manga: dict) -> set[str]:
    return {
        _normalize_host(urlparse(s["url"]).netloc)
        for s in manga.get("sources") or [{"url": manga.get("url")}]
        if s.get("url")
    }


def _chapter_key(text: str | None, url_fallback: str | None = None):
    """คีย์เอกลักษณ์ของตอน คงที่ไม่ว่าจะดึงจากแหล่งไหน/URL ไหนก็ตาม (เดียวกับที่ใช้ตัดตัวซ้ำตอน
    ตอนรวมหลายแหล่งที่มาใน refresh_from_sources) — ใช้เลขตอนเป็นหลัก ไม่ใช่ URL เพราะเรื่องที่มี
    หลายแหล่งที่มา พอสลับลำดับแหล่งหรือแหล่งเดิมหายไป URL ของตอนเดียวกันจะเปลี่ยน ถ้าประวัติการ
    อ่าน/bookmark อิงกับ URL ตรง ๆ จะหายไปทั้งที่จริง ๆ ยังอ่านตอนนั้นอยู่ ตอนที่ไม่มีเลข (เช่นตอน
    พิเศษ) ใช้ข้อความแทน — ถ้าไม่มีข้อความเลย (เช่นดึง chapter_text จากหน้าตอนไม่สำเร็จ) ใช้
    url_fallback แทนที่จะไม่มาร์คว่าอ่านแล้วเสียเฉย ๆ"""
    if not text:
        return url_fallback
    num = scraper.chapter_number(text)
    return num if num is not None else text


def _guess_chapter_number_from_url(url: str) -> float | None:
    """เดาเลขตอนจากเลขท้าย URL (เช่น .../magic-emperor-908/ -> 908) ใช้เฉพาะตอน migrate
    ข้อมูลอ่านแล้วแบบเก่าที่เก็บ URL ไว้ตรง ๆ และหาข้อความตอนจากรายชื่อตอนปัจจุบันไม่เจอแล้ว"""
    match = re.search(r"(\d+)/?$", url.rstrip("/"))
    return float(match.group(1)) if match else None


def _migrate_read_state_to_keys():
    """ของเดิม read_state เก็บ read_urls (URL ตรง ๆ) ตอนนี้เปลี่ยนมาเก็บ read_keys (คีย์เอกลักษณ์
    จาก _chapter_key) แทน เพราะเรื่องที่มีหลายแหล่งที่มา พอสลับลำดับแหล่งหรือแหล่งเดิมหายไป URL
    ของตอนเดียวกันจะเปลี่ยน ทำให้ประวัติการอ่าน/bookmark ที่อิงกับ URL ตรง ๆ หายไปทั้งที่จริง ๆ ยัง
    อ่านตอนนั้นอยู่ — ย้ายครั้งเดียวตอนสตาร์ท: หาเลขตอนจากรายชื่อตอนปัจจุบันของเรื่องนั้นก่อน (แม่น
    สุด) ไม่เจอค่อยเดาจากเลขท้าย URL แทน (เผื่อ URL เก่าไม่อยู่ในลิสต์เรื่องนั้นแล้วเพราะสลับแหล่ง
    ไปแล้ว เช่นเคสที่ทำให้เจอบั๊กนี้)"""
    chapters_by_manga = {m["id"]: m.get("chapters") or [] for m in storage.load_manga() if m.get("id")}

    for username in storage.all_usernames():
        read_state = storage.load_read_state(username, fresh=True)
        changed = False
        for manga_id, entry in read_state.items():
            if not isinstance(entry, dict) or "read_urls" not in entry:
                continue
            changed = True
            url_to_text = {
                c["url"]: c.get("text") for c in chapters_by_manga.get(manga_id, []) if c.get("url")
            }

            def resolve_key(url: str):
                # ห้ามใช้ `or` เชื่อมสอง fallback เพราะเลขตอน 0 (ตอน prologue) เป็นค่า falsy
                # ใน Python แต่เป็นคีย์ที่ถูกต้อง ต้องเช็ค `is None` ตรง ๆ เท่านั้น
                key = _chapter_key(url_to_text.get(url))
                return key if key is not None else _guess_chapter_number_from_url(url)

            keys = []
            for url in entry.pop("read_urls") or []:
                if not isinstance(url, str):
                    continue
                key = resolve_key(url)
                if key is not None and key not in keys:
                    keys.append(key)
            entry["read_keys"] = keys

            raw_scroll = entry.get("last_scroll")
            if isinstance(raw_scroll, dict) and raw_scroll.get("url"):
                key = resolve_key(raw_scroll["url"])
                entry["last_scroll"] = {"key": key, "fraction": raw_scroll["fraction"]} if key is not None else None

        if changed:
            storage.save_read_state(username, read_state)


_migrate_read_state_to_keys()


def _num_or_neg(c: dict) -> float:
    n = scraper.chapter_number(c["text"]) if c.get("text") else None
    return n if n is not None else -1


def refresh_from_sources(sources: list[dict], min_interval: float = 0.0) -> dict:
    """ดึงข้อมูลจากทุกแหล่งที่มาของเรื่องเดียวกันแล้วรวมเป็นชุดเดียว กันเรื่องที่แหล่งใดแหล่งหนึ่ง
    เงียบหายไม่อัพเดต — ตอนล่าสุดเอาจากแหล่งที่มีเลขตอนสูงสุด ส่วนรายชื่อตอนรวมจากทุกแหล่งเข้า
    ด้วยกัน (ตัวซ้ำตามเลขตอน แหล่งที่มาก่อนในลิสต์ชนะถ้าเลขตอนซ้ำ) เพื่อให้อ่านตอนเก่าจากแหล่งที่
    ยังมีอยู่ได้ปกติ ถึงแหล่งอื่นจะตายไปแล้วก็ตาม แหล่งไหนดึงพลาดก็ข้ามไป ไม่ล้มทั้งเรื่อง"""
    per_source = []
    for src in sources:
        url = src.get("url")
        if not url:
            continue
        try:
            html = scraper.fetch(url, min_interval=min_interval)
            per_source.append(scraper.parse_index_page(html, url, min_interval))
        except Exception as e:
            print(f"⚠️ ดึงข้อมูลจาก {url} ไม่สำเร็จ: {e}")

    if not per_source:
        return {}

    by_num = {}
    for parsed in per_source:
        for c in parsed["chapters"]:
            by_num.setdefault(_chapter_key(c["text"]), c)
    merged_chapters = sorted(by_num.values(), key=_num_or_neg, reverse=True)

    # เผื่อทุกแหล่งไม่มี #chapterlist/AJAX เลย (เช่น Madara ที่ดึงลิสต์ไม่ได้) แต่ยังรู้ตอนล่าสุด
    # จากปุ่ม "Read Last" อยู่ — เทียบตอนล่าสุดของแต่ละแหล่งเข้าไปในกองเดียวกันด้วย
    candidates = list(merged_chapters)
    known_urls = {c["url"] for c in candidates}
    for parsed in per_source:
        if parsed.get("latest_chapter_url") and parsed["latest_chapter_url"] not in known_urls:
            candidates.append({"text": parsed.get("latest_chapter"), "url": parsed["latest_chapter_url"], "date": None})
            known_urls.add(parsed["latest_chapter_url"])

    best = max(candidates, key=_num_or_neg, default=None)

    return {
        "chapters": merged_chapters,
        "cover_url": next((p["cover_url"] for p in per_source if p.get("cover_url")), None),
        "latest_chapter": best["text"] if best else None,
        "latest_chapter_url": best["url"] if best else None,
        "latest_chapter_date": next(
            (d for c in merged_chapters if (d := scraper.parse_release_date(c.get("date")))), None
        ),
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _apply_refresh(manga: dict, parsed: dict) -> str | None:
    """เอาผลจาก refresh_from_sources มาอัพเดตลง manga record คืนค่าตอนล่าสุดก่อนหน้า (ให้ caller
    เอาไปเทียบว่าเปลี่ยนไหมสำหรับแจ้งเตือน) — ถ้ารอบนี้ดึงรายชื่อตอนมาได้ว่างเปล่า (เช่นโดน
    rate-limit หรือหน้าเพจเพี้ยนชั่วคราว) แต่ก่อนหน้านี้เคยมีรายชื่อตอนอยู่แล้ว จะไม่ยอมทับด้วยลิสต์
    ว่าง เพราะเรื่องที่ตอนล่าสุดหายไปจากลิสต์ (ถึง latest_chapter_url จะยังถูกต้อง) ทำให้ประวัติการ
    อ่าน/bookmark ของตอนอื่น ๆ ในเรื่องนั้นหาตัวเองในลิสต์ไม่เจอ แล้วมองว่ายังไม่เคยอ่านทั้งหมด"""
    prev_chapter = manga.get("latest_chapter")
    if not parsed.get("chapters") and manga.get("chapters"):
        parsed = {**parsed, "chapters": manga["chapters"]}
    manga.update(parsed)
    manga["last_checked_at"] = now_iso()
    if parsed.get("latest_chapter_url"):
        manga["source"] = urlparse(parsed["latest_chapter_url"]).netloc
    if parsed.get("latest_chapter") and parsed["latest_chapter"] != prev_chapter:
        manga["last_updated_at"] = manga["last_checked_at"]
    return prev_chapter


class ReadChecker:
    """เช็คว่าตอนไหน (ระบุด้วยคีย์เอกลักษณ์จาก _chapter_key) อ่านแล้วบ้างของเรื่องหนึ่ง — แปลง
    read_keys เป็น set ครั้งเดียว เรื่องที่มีเป็นพันตอนจะไม่ต้องไล่ลิสต์ซ้ำทุกตอน"""

    def __init__(self, entry: dict | None):
        entry = entry or {}
        self.read_keys = set(entry.get("read_keys") or [])
        # fallback สำหรับข้อมูลเก่ามาก (ก่อนมีระบบติดตามรายตอน มีแค่ last_read_chapter เป็นข้อความ)
        old_last = entry.get("last_read_chapter")
        self.old_key = _chapter_key(old_last) if old_last is not None else None

    def __call__(self, key) -> bool:
        if key is None:
            return False
        return key in self.read_keys or (self.old_key is not None and self.old_key == key)


def is_chapter_read(entry: dict | None, key) -> bool:
    return ReadChecker(entry)(key)


def is_new(manga: dict, read_state: dict) -> bool:
    if not manga.get("latest_chapter_url"):
        return False
    entry = read_state.get(manga["id"])
    return not is_chapter_read(entry, _chapter_key(manga.get("latest_chapter")))


def mark_chapter_read(read_state: dict, manga_id: str, key):
    if key is None:
        return
    entry = read_state.setdefault(manga_id, {"read_keys": [], "last_read_at": None})
    read_keys = entry.setdefault("read_keys", [])
    # ย้ายไปท้ายลิสต์เสมอ (ไม่ใช่แค่ append ตอนยังไม่เคยอ่าน) เพราะ "ตอนล่าสุดที่อ่าน" (สำหรับ
    # bookmark/auto-scroll) อิงจากตัวท้ายสุดของลิสต์นี้ ถ้ากดกลับไปอ่านตอนเก่าที่เคยอ่านแล้วซ้ำ
    # ต้องขยับมาเป็น "ล่าสุด" ด้วย ไม่ใช่ค้างอยู่ตำแหน่งเดิมตอนอ่านครั้งแรก
    if key in read_keys:
        read_keys.remove(key)
    read_keys.append(key)
    entry["last_read_at"] = now_iso()


def public_manga(manga: dict) -> dict:
    """ข้อมูลเรื่องสำหรับส่งให้หน้าเว็บในหน้ารวม — ตัดรายชื่อตอนทั้งหมดออก (ใหญ่ที่สุดในไฟล์ และหน้า
    รวมไม่ได้ใช้ หน้าเลือกตอนดึงแยกจาก /api/manga/<id>/chapters อยู่แล้ว)"""
    return {k: v for k, v in manga.items() if k != "chapters"}


def serialize(manga: dict, read_state: dict) -> dict:
    out = public_manga(manga)
    out["is_new"] = is_new(manga, read_state)
    return out


def manga_list_payload(username: str | None) -> list[dict]:
    manga_items = storage.load_manga()
    if username:
        subscribed_ids = set(storage.load_subscriptions(username))
        manga_items = [m for m in manga_items if m["id"] in subscribed_ids]
    read_state = storage.load_read_state(username) if username else {}
    items = [serialize(m, read_state) for m in manga_items]
    # เรื่องที่ยังไม่อ่านขึ้นก่อน แล้วภายในกลุ่มเดียวกันเรียงตามเวลาที่ "เจอตอนใหม่จริง ๆ"
    # ล่าสุดก่อน (last_updated_at เปลี่ยนเฉพาะตอนตอนล่าสุดเปลี่ยนจริง ไม่ใช่ทุกครั้งที่เช็ค)
    items.sort(key=lambda m: m.get("last_updated_at") or "", reverse=True)
    items.sort(key=lambda m: m["is_new"], reverse=True)
    return items


def notify_subscribed_admins(manga_id: str, name: str, chapter: str, cover_url: str | None):
    """ส่ง Telegram แจ้งเตือนเฉพาะตอนที่ admin (ที่ตั้งค่า Telegram ไว้) ติดตามเรื่องนี้อยู่จริง"""
    for admin_username in admin_usernames():
        if manga_id in storage.load_subscriptions(admin_username):
            send_telegram(name, chapter, cover_url)
            return  # ส่งครั้งเดียวพอ (Telegram ตั้งค่าเป็นแชทเดียวอยู่แล้ว)


@app.route("/")
def index():
    username = current_username()
    if username:
        # ต่ออายุ cookie 90 วันนับจากครั้งล่าสุดที่เปิดเว็บ (ปิด SESSION_REFRESH_EACH_REQUEST ไว้แล้ว)
        session.modified = True
    # ฝังข้อมูลเริ่มต้นมาในหน้าเลย หน้าแรกขึ้นทันทีไม่ต้องรอยิง API ต่อกันหลายรอบ
    boot = {
        "me": {"username": username, "is_admin": is_admin()},
        "prefs": storage.load_prefs(username) if username else {},
        "manga": manga_list_payload(username),
    }
    resp = app.make_response(render_template("index.html", boot=boot))
    resp.cache_control.private = True
    resp.cache_control.no_cache = True
    return resp


@app.route("/api/manga", methods=["GET"])
def list_manga():
    return jsonify(manga_list_payload(current_username()))


@app.route("/api/catalog", methods=["GET"])
def list_catalog():
    """เรื่องทั้งหมดในระบบ (ไม่กรองตามที่ติดตาม) ไว้ให้เลือกติดตามเพิ่ม"""
    subscribed_ids = set(storage.load_subscriptions(current_username())) if current_username() else set()
    items = []
    for m in storage.load_manga():
        out = public_manga(m)
        out["is_subscribed"] = m["id"] in subscribed_ids
        items.append(out)
    items.sort(key=lambda m: m["name"])
    return jsonify(items)


@app.route("/api/catalog/<manga_id>/subscribe", methods=["POST"])
def subscribe(manga_id):
    username = current_username()
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    if not storage.get_manga(manga_id):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    subs = storage.load_subscriptions(username, fresh=True)
    if manga_id not in subs:
        subs.append(manga_id)
        storage.save_subscriptions(username, subs)
    return jsonify({"ok": True})


@app.route("/api/catalog/<manga_id>/unsubscribe", methods=["POST"])
def unsubscribe(manga_id):
    username = current_username()
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    subs = storage.load_subscriptions(username, fresh=True)
    if manga_id in subs:
        subs.remove(manga_id)
        storage.save_subscriptions(username, subs)
    return jsonify({"ok": True})


def _parse_sources_body(body: dict) -> tuple[list[str] | None, str | None]:
    """อ่านรายการ URL แหล่งที่มาจาก request body คืน (urls, error) — รองรับ body["sources"]
    เป็น list ของ url string ล้วน ๆ, ตัดช่องว่าง/ช่องว่างเปล่าทิ้ง, กันซ้ำ (คงลำดับเดิม)"""
    raw = body.get("sources")
    if not isinstance(raw, list):
        return None, "ต้องระบุแหล่งที่มาอย่างน้อย 1 เว็บ"
    urls = []
    for u in raw:
        u = (u or "").strip()
        if not u:
            continue
        if not u.startswith("http://") and not u.startswith("https://"):
            return None, f"URL ไม่ถูกต้อง: {u}"
        if u not in urls:
            urls.append(u)
    if not urls:
        return None, "ต้องระบุแหล่งที่มาอย่างน้อย 1 เว็บ"
    return urls, None


@app.route("/api/manga", methods=["POST"])
@require_admin
def add_manga():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    urls, error = _parse_sources_body(body)

    if not name:
        return jsonify({"error": "ต้องระบุชื่อเรื่อง"}), 400
    if error:
        return jsonify({"error": error}), 400

    mid = storage.make_id(urls[0])
    if storage.get_manga(mid):
        return jsonify({"error": "มีเรื่องนี้อยู่แล้ว"}), 409

    new_item = {
        "id": mid,
        "name": name,
        "url": urls[0],
        "sources": [{"url": u} for u in urls],
        "source": urlparse(urls[0]).netloc,
        "latest_chapter": None,
        "latest_chapter_url": None,
        "cover_url": None,
        "chapters": [],
        "last_checked_at": None,
        "last_updated_at": None,
    }

    # ลองดึงข้อมูลทันทีตอนเพิ่ม เพื่อให้เห็นตอนล่าสุด/ปก ทันที
    parsed = refresh_from_sources(new_item["sources"])
    if parsed:
        new_item.update(parsed)
        new_item["last_checked_at"] = now_iso()
        if parsed.get("latest_chapter_url"):
            new_item["source"] = urlparse(parsed["latest_chapter_url"]).netloc
        if parsed.get("latest_chapter"):
            new_item["last_updated_at"] = new_item["last_checked_at"]

    # โหลดใหม่หลังดึงข้อมูลเสร็จ (ใช้เวลาหลายวินาที) กันทับของที่คนอื่นแก้ระหว่างนั้น
    manga_items = storage.load_manga(fresh=True)
    if any(m["id"] == mid for m in manga_items):
        return jsonify({"error": "มีเรื่องนี้อยู่แล้ว"}), 409
    manga_items.append(new_item)
    storage.save_manga(manga_items)

    # คนเพิ่มเรื่อง (admin) ให้ติดตามเรื่องนี้เองอัตโนมัติ (ถ้ามี session จริง — dev mode ไม่มี user เลยข้าม)
    if current_username():
        subs = storage.load_subscriptions(current_username(), fresh=True)
        if mid not in subs:
            subs.append(mid)
            storage.save_subscriptions(current_username(), subs)

    return jsonify(public_manga(new_item)), 201


@app.route("/api/manga/<manga_id>", methods=["PUT"])
@require_admin
def edit_manga(manga_id):
    """แก้ไขชื่อ/แหล่งที่มาของเรื่องที่มีอยู่แล้ว (id เดิมไม่เปลี่ยน ต่อให้แหล่งแรกจะถูกแก้ก็ตาม
    เพื่อไม่ให้กระทบ subscriptions/read_state ของทุกคนที่ผูกกับ id เดิมอยู่)"""
    if not storage.get_manga(manga_id):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    urls, error = _parse_sources_body(body)

    if not name:
        return jsonify({"error": "ต้องระบุชื่อเรื่อง"}), 400
    if error:
        return jsonify({"error": error}), 400

    sources = [{"url": u} for u in urls]
    # ดึงข้อมูลใหม่ทันทีตามแหล่งที่มาชุดล่าสุด เพื่อให้เห็นผลทันทีไม่ต้องรอรีเฟรชรอบถัดไป
    # (ดึงก่อนโหลดไฟล์มาแก้ ช่วงรอเว็บต้นทางหลายวินาทีจะได้ไม่ทับของที่คนอื่นบันทึกไประหว่างนั้น)
    parsed = refresh_from_sources(sources)

    manga_items = storage.load_manga(fresh=True)
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    manga["name"] = name
    manga["sources"] = sources
    manga["url"] = urls[0]
    if parsed:
        _apply_refresh(manga, parsed)

    storage.save_manga(manga_items)
    return jsonify(public_manga(manga))


@app.route("/api/manga/<manga_id>", methods=["DELETE"])
@require_admin
def delete_manga(manga_id):
    manga_items = storage.load_manga(fresh=True)
    remaining = [m for m in manga_items if m["id"] != manga_id]
    if len(remaining) == len(manga_items):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    storage.save_manga(remaining)

    # เอาออกจาก subscriptions/read_state ของทุกคน กันข้อมูลค้าง
    for username in storage.all_usernames():
        subs = storage.load_subscriptions(username, fresh=True)
        if manga_id in subs:
            subs.remove(manga_id)
            storage.save_subscriptions(username, subs)
        read_state = storage.load_read_state(username, fresh=True)
        if manga_id in read_state:
            del read_state[manga_id]
            storage.save_read_state(username, read_state)

    return jsonify({"ok": True})


def _sources_of(manga: dict) -> list[dict]:
    return manga.get("sources") or [{"url": manga["url"]}]


def _commit_refreshes(results: dict[str, dict]) -> list[str]:
    """บันทึกผลดึงข้อมูลหลายเรื่องลงไฟล์ครั้งเดียว — โหลดไฟล์ใหม่ตอนจะบันทึก (ไม่ใช้ชุดที่โหลดไว้
    ก่อนเริ่มดึง ซึ่งอาจนานหลายนาที) กันทับเรื่องที่ถูกเพิ่ม/แก้/ลบระหว่างนั้น แล้วค่อยแจ้งเตือน
    หลังบันทึกเสร็จ คืนค่า id เรื่องที่ตอนล่าสุดเปลี่ยน"""
    if not results:
        return []
    manga_items = storage.load_manga(fresh=True)
    changed = []
    for manga in manga_items:
        parsed = results.get(manga["id"])
        if not parsed:
            continue
        prev_chapter = _apply_refresh(manga, parsed)
        if parsed.get("latest_chapter") and parsed["latest_chapter"] != prev_chapter:
            changed.append((manga, prev_chapter))
    storage.save_manga(manga_items)

    for manga, prev_chapter in changed:
        # แจ้งเตือนเฉพาะตอนที่เคยรู้ตอนล่าสุดมาก่อนแล้วเปลี่ยน (ไม่แจ้งตอนเพิ่งเพิ่มเรื่องใหม่)
        if prev_chapter:
            notify_subscribed_admins(manga["id"], manga["name"], manga["latest_chapter"], manga.get("cover_url"))
    return [manga["id"] for manga, _ in changed]


@app.route("/api/manga/<manga_id>/refresh", methods=["POST"])
@require_admin
def refresh_manga(manga_id):
    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    parsed = refresh_from_sources(_sources_of(manga))
    if not parsed:
        return jsonify({"error": "ดึงข้อมูลไม่สำเร็จ (ทุกแหล่งที่มา)"}), 502

    _commit_refreshes({manga_id: parsed})

    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    read_state = storage.load_read_state(current_username()) if current_username() else {}
    return jsonify(serialize(manga, read_state))


@app.route("/api/refresh_all", methods=["POST"])
def refresh_all():
    # เข้าถึงได้จาก CRON_TOKEN (refresh_loop.py, ไม่มี session) หรือ session ของ admin เท่านั้น
    if current_username() and not is_admin():
        return jsonify({"error": "เฉพาะ admin เท่านั้น"}), 403

    manga_items = list(storage.load_manga())
    results: dict[str, dict] = {}
    failed = []

    def work(manga):
        try:
            return manga, refresh_from_sources(_sources_of(manga), min_interval=REQUEST_DELAY)
        except Exception as e:
            # เรื่องเดียวพังต้องไม่ทำให้ทั้งรอบล้ม (ไม่งั้นผลของเรื่องที่ดึงสำเร็จแล้วหายไปทั้งหมด)
            print(f"⚠️ รีเฟรช {manga['name']} ไม่สำเร็จ: {e}")
            return manga, None

    with ThreadPoolExecutor(max_workers=REFRESH_WORKERS) as pool:
        for manga, parsed in pool.map(work, manga_items):
            if parsed:
                results[manga["id"]] = parsed
            else:
                failed.append({"id": manga["id"], "name": manga["name"], "error": "ดึงข้อมูลไม่สำเร็จ (ทุกแหล่งที่มา)"})

    updated_ids = _commit_refreshes(results)
    items = manga_list_payload(current_username())
    return jsonify({"items": items, "updated_ids": updated_ids, "failed": failed})


@app.route("/api/manga/<manga_id>/chapter", methods=["GET"])
def get_chapter(manga_id):
    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    chapter_url = request.args.get("url") or manga.get("latest_chapter_url")
    if not chapter_url:
        return jsonify({"error": "ยังไม่ทราบลิงก์ตอนล่าสุด ลองรีเฟรชเรื่องนี้ก่อน"}), 400

    # กันไม่ให้ยิงไปโดเมนอื่นที่ไม่เกี่ยวกับเรื่องนี้ (เทียบแบบ normalize โดเมนก่อน กัน
    # เว็บที่ใช้โดเมนภาษาไทย/unicode ตรง ๆ แต่ลิงก์ในเพจเป็น punycode คนละรูปแบบกัน) เทียบกับ
    # โดเมนของทุกแหล่งที่มาของเรื่องนี้ ไม่ใช่แค่แหล่งแรก เพราะตอนล่าสุดอาจมาจากแหล่งอื่นก็ได้
    if _normalize_host(urlparse(chapter_url).netloc) not in _source_domains(manga):
        return jsonify({"error": "URL ตอนไม่ถูกต้อง"}), 400

    cached = storage.load_chapter_cache(manga_id, chapter_url)
    if cached:
        data = cached
    else:
        try:
            # ใช้โดเมนจาก chapter_url เอง แทน manga["url"] ตรง ๆ เพราะบางเว็บผู้ใช้กรอกโดเมนภาษาไทย/
            # unicode ไว้ — แต่ต้อง normalize เป็น punycode ก่อนเสมอ (เผื่อ chapter_url ที่ส่งมาดัน
            # เป็นโดเมนภาษาไทยตรง ๆ ด้วย ไม่ใช่แค่ที่ scrape มาซึ่งมักเป็น punycode อยู่แล้ว) เพราะ
            # ใส่เป็นค่า header (Referer) แบบ unicode ตรง ๆ ไม่ได้ — HTTP header ต้อง encode เป็น
            # latin-1 ได้เท่านั้น
            referer = f"{urlparse(chapter_url).scheme}://{_normalize_host(urlparse(chapter_url).netloc)}/"
            html = scraper.fetch(chapter_url, referer=referer)
            data = scraper.parse_chapter_page(html)
        except Exception as e:
            return jsonify({"error": f"ดึงหน้าตอนไม่สำเร็จ: {e}"}), 502
        if data.get("images"):
            storage.save_chapter_cache(manga_id, chapter_url, data)
            storage.add_image_domains({urlparse(src).netloc for src in data["images"]})

    chapters = manga.get("chapters") or []
    idx = next((i for i, c in enumerate(chapters) if c["url"] == chapter_url), None)

    # เว็บกลุ่ม Madara ไม่มีลิงก์ตอนก่อนหน้า/ถัดไปในหน้าอ่าน หาเอาจากลำดับในรายชื่อตอนแทน
    # (ลิสต์เรียงใหม่->เก่า ตอนถัดไปจึงอยู่ก่อนหน้าในลิสต์)
    if not data.get("prev_url") and not data.get("next_url") and idx is not None:
        data["next_url"] = chapters[idx - 1]["url"] if idx > 0 else None
        data["prev_url"] = chapters[idx + 1]["url"] if idx + 1 < len(chapters) else None

    # มาร์คเฉพาะ "ตอนที่เปิดดูจริง" ว่าอ่านแล้ว (ไม่กระทบตอนอื่นของเรื่องเดียวกัน) เฉพาะของคนที่ login อยู่
    # ใช้ข้อความตอนจากรายชื่อตอนที่ scrape ไว้แล้ว (แม่นกว่าเสมอ) แทนการพาร์สจากหน้าตอนเอง
    # (data["chapter_text"]) เพราะบางเว็บ h1/title ของหน้าตอนไม่มีเลขตอนกำกับชัดเจนแบบที่คาดไว้
    # (เช่น h1 เป็นหัวข้อทั่วไปของเว็บ ไม่ใช่ชื่อตอน) ถ้าเจอใน chapters ก็ใช้ text เดียวกับที่
    # list_chapters ใช้เช็ค is_read เป๊ะ ๆ เลย รับประกันว่าจะตรงกันเสมอ
    # peek=1 = หน้าเว็บโหลดล่วงหน้าไว้ก่อนผู้ใช้จะเลื่อนไปถึงตอนนั้นจริง ห้ามมาร์คว่าอ่านแล้ว
    if current_username() and request.args.get("peek") != "1":
        known_text = chapters[idx]["text"] if idx is not None else None
        key = _chapter_key(known_text or data.get("chapter_text"), chapter_url)
        read_state = storage.load_read_state(current_username(), fresh=True)
        mark_chapter_read(read_state, manga_id, key)
        storage.save_read_state(current_username(), read_state)

    data["chapter_url"] = chapter_url
    data["manga_name"] = manga["name"]
    return jsonify(data)


@app.route("/api/manga/<manga_id>/chapters", methods=["GET"])
def list_chapters(manga_id):
    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    read_state = storage.load_read_state(current_username()) if current_username() else {}
    entry = read_state.get(manga_id)
    chapters = manga.get("chapters") or []
    keys = [_chapter_key(c["text"]) for c in chapters]
    is_read = ReadChecker(entry)
    items = [{**c, "is_read": is_read(k)} for c, k in zip(chapters, keys)]
    url_by_key = {}
    for c, k in zip(chapters, keys):
        url_by_key.setdefault(k, c["url"])

    # ตอนล่าสุดที่กดอ่าน (ไว้ให้หน้าเว็บเลื่อนไปหาอัตโนมัติ) เอาจากตัวท้ายสุดของ read_keys (ย้ายไป
    # ท้ายลิสต์ทุกครั้งที่อ่าน จึงเป็นตอนล่าสุดที่อ่านจริง) แล้วหา URL ปัจจุบันของตอนนั้นจากรายชื่อ
    # ตอนตอนนี้ (ไม่ใช้ URL ที่เก็บไว้ตรง ๆ เพราะเรื่องที่มีหลายแหล่งที่มา พอสลับลำดับแหล่ง URL ของ
    # ตอนเดียวกันอาจเปลี่ยนได้) หรือ fallback ข้อมูลเก่ามาก ๆ ที่มีแค่ last_read_chapter
    last_read_url = None
    if entry:
        read_keys = entry.get("read_keys") or []
        if read_keys:
            last_read_url = url_by_key.get(read_keys[-1])
        elif entry.get("last_read_chapter"):
            match = next((c for c in chapters if c["text"] == entry["last_read_chapter"]), None)
            if match:
                last_read_url = match["url"]

    # last_scroll เก็บคีย์เอกลักษณ์ของตอนไว้ (ไม่ใช่ URL ตรง ๆ) ด้วยเหตุผลเดียวกัน — แปลงกลับเป็น
    # URL ปัจจุบันก่อนส่งให้หน้าเว็บ เพื่อให้เทียบกับตอนที่เปิดอยู่ตรงกันเสมอ
    last_scroll = None
    raw_scroll = (entry or {}).get("last_scroll")
    if raw_scroll:
        scroll_url = url_by_key.get(raw_scroll.get("key"))
        if scroll_url:
            last_scroll = {"url": scroll_url, "fraction": raw_scroll["fraction"]}

    return jsonify(
        {
            "manga_name": manga["name"],
            "cover_url": manga.get("cover_url"),
            "chapters": items,
            "last_read_url": last_read_url,
            "last_scroll": last_scroll,
        }
    )


@app.route("/api/manga/<manga_id>/scroll_position", methods=["POST"])
def save_scroll_position(manga_id):
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True) or {}
    chapter_url = body.get("url")
    fraction = body.get("fraction")
    if not chapter_url or not isinstance(fraction, (int, float)):
        return jsonify({"error": "ข้อมูลไม่ครบ"}), 400
    fraction = max(0.0, min(1.0, float(fraction)))

    manga = storage.get_manga(manga_id)
    chapter = next((c for c in (manga.get("chapters") or []) if c["url"] == chapter_url), None) if manga else None
    key = _chapter_key(chapter["text"] if chapter else None, chapter_url)

    read_state = storage.load_read_state(current_username(), fresh=True)
    entry = read_state.setdefault(manga_id, {"read_keys": [], "last_read_at": None})
    # ถ้าอ่านจบตอนแล้ว (>=95%) ไม่ต้องเก็บตำแหน่งไว้ เปิดใหม่ควรเริ่มจากบนสุดตามปกติ — เก็บเป็นคีย์
    # เอกลักษณ์ของตอน ไม่ใช่ URL ตรง ๆ ด้วยเหตุผลเดียวกับ read_keys (เรื่องหลายแหล่งที่มา URL เปลี่ยนได้)
    entry["last_scroll"] = None if fraction >= 0.95 else {"key": key, "fraction": fraction}
    storage.save_read_state(current_username(), read_state)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/mark_read", methods=["POST"])
def mark_read(manga_id):
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    if not manga.get("latest_chapter_url"):
        return jsonify({"error": "ยังไม่ทราบลิงก์ตอนล่าสุด ลองรีเฟรชเรื่องนี้ก่อน"}), 400

    read_state = storage.load_read_state(current_username(), fresh=True)
    mark_chapter_read(read_state, manga_id, _chapter_key(manga.get("latest_chapter"), manga["latest_chapter_url"]))
    storage.save_read_state(current_username(), read_state)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/mark_unread", methods=["POST"])
def mark_unread(manga_id):
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    read_state = storage.load_read_state(current_username(), fresh=True)
    entry = read_state.get(manga_id)
    key = _chapter_key(manga.get("latest_chapter"), manga.get("latest_chapter_url"))
    if entry and key is not None and key in entry.get("read_keys", []):
        entry["read_keys"].remove(key)
        storage.save_read_state(current_username(), read_state)
    return jsonify({"ok": True})


# ความกว้างที่ยอมให้ย่อได้ (เท่าที่หน้าเว็บใช้จริง: การ์ดในกริด และรูปเล็กในหน้าตั้งค่า) — จำกัดไว้
# เป็นชุด ไม่รับเลขอะไรก็ได้ กันคนยิงสุ่มความกว้างจนเครื่องไล่ย่อรูป/สร้างไฟล์แคชไม่จำกัด
COVER_WIDTHS = {120, 400}
MAX_RESIZE_BYTES = 25 * 1024 * 1024  # รูปใหญ่เกินนี้ไม่ย่อ (กันโหลดทั้งก้อนเข้าหน่วยความจำ)

IMAGE_HEADERS = {
    # รูปของตอน/ปกไม่เปลี่ยนตาม URL เดิม ให้ browser เก็บไว้ยาว ๆ ไม่ต้องถามซ้ำ (private = ไม่ให้
    # proxy/CDN กลางทางแคชแทน เพราะ endpoint นี้ต้อง login)
    "Cache-Control": "private, max-age=2592000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


def _resize_cover(raw: bytes, width: int) -> bytes | None:
    """ย่อรูปปกให้พอดีกับขนาดที่หน้าเว็บใช้จริง แล้วแปลงเป็น WebP — ปกจากเว็บต้นทางมักเป็นไฟล์เต็ม
    ขนาด (ที่เจอคือ 1516x2020 หนัก 250 KB) ทั้งที่การ์ดบนหน้าเว็บกว้างแค่ ~160px คืน None ถ้าย่อ
    ไม่ได้ (ไม่มี Pillow/ไฟล์เพี้ยน) ให้ผู้เรียกส่งรูปต้นฉบับแทน"""
    if Image is None:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            if img.width > width:
                img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
            has_alpha = img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info
            img = img.convert("RGBA" if has_alpha else "RGB")
            out = io.BytesIO()
            img.save(out, format="WEBP", quality=80, method=4)
            return out.getvalue()
    except Exception as e:
        print(f"⚠️ ย่อรูปปกไม่สำเร็จ ({e}) ส่งรูปต้นฉบับแทน")
        return None


@app.route("/api/img")
def proxy_image():
    src = request.args.get("src")
    if not src:
        return "missing src", 400

    allowed = storage.get_allowed_domains()
    parsed_src = urlparse(src)
    netloc = parsed_src.netloc

    is_allowed = netloc in allowed
    # เว็บกลุ่มนี้บางเว็บใช้ Jetpack Photon CDN (i0/i1/i2/i3.wp.com) พร็อกซีรูปโดยฝัง
    # โดเมนต้นทางไว้ใน path เช่น https://i0.wp.com/www.tanuki-manga.net/wp-content/...
    if not is_allowed and re.match(r"^i[0-3]\.wp\.com$", netloc):
        origin = parsed_src.path.lstrip("/").split("/", 1)[0]
        is_allowed = origin in allowed

    if not is_allowed:
        return "domain not allowed", 403

    try:
        width = int(request.args.get("w", ""))
    except ValueError:
        width = 0
    if width not in COVER_WIDTHS:
        width = 0

    if width:
        cached = storage.load_cover_cache(src, width)
        if cached:
            return Response(cached, content_type="image/webp", headers=IMAGE_HEADERS)

    try:
        resp = scraper.session().get(
            src,
            headers={
                "User-Agent": scraper.HEADERS["User-Agent"],
                "Referer": f"https://{netloc}/",
            },
            timeout=20,
            stream=not width,
        )
        resp.raise_for_status()
    except Exception as e:
        return f"fetch failed: {e}", 502

    # เฉพาะ path นี้ที่โหลดทั้งรูปเข้าหน่วยความจำ (stream=False ด้านบน) เพราะต้องมีไฟล์ครบก่อนถึงย่อได้
    if width and len(resp.content) <= MAX_RESIZE_BYTES:
        resized = _resize_cover(resp.content, width)
        if resized:
            storage.save_cover_cache(src, width, resized)
            return Response(resized, content_type="image/webp", headers=IMAGE_HEADERS)

    content_type = resp.headers.get("Content-Type", "image/jpeg")
    if not content_type.lower().startswith("image/"):
        # โดเมนที่อนุญาตรวมถึงตัวเว็บมังงะเองด้วย กันไม่ให้ใช้ proxy นี้เสิร์ฟหน้า HTML/สคริปต์ของเว็บอื่น
        # ภายใต้โดเมนเรา (แท็ก <img> ยังแสดงรูปได้ปกติ แม้ CDN บางเจ้าจะส่ง type มาไม่ตรง)
        content_type = "application/octet-stream"

    headers = dict(IMAGE_HEADERS)
    if resp.headers.get("Content-Length") and not resp.headers.get("Content-Encoding"):
        headers["Content-Length"] = resp.headers["Content-Length"]

    def stream():
        # ส่งต่อทีละก้อน ไม่อ่านทั้งรูปเข้าหน่วยความจำก่อน
        try:
            yield from resp.iter_content(chunk_size=64 * 1024)
        finally:
            resp.close()

    return Response(stream(), content_type=content_type, headers=headers, direct_passthrough=True)


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG") == "1"
    port = int(os.environ.get("PORT", "5050"))
    # host default เป็น 127.0.0.1 (ปลอดภัยกว่า); บน VPS ให้รันผ่าน gunicorn
    # แล้ววางหลัง nginx (ดู README) แทนที่จะรัน dev server ตรง ๆ
    app.run(debug=debug, host=os.environ.get("HOST", "127.0.0.1"), port=port)
