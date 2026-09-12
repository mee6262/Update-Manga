import hmac
import os
import re
import secrets
import shutil
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, Response, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import scraper
import storage
from telegram_notify import send_telegram

# โหลด .env จาก root ของโปรเจกต์ (ไฟล์เดียวกับที่ใช้ทั้ง Linux/Windows ไม่ต้องพึ่ง export/set เอง)
load_dotenv(Path(__file__).parent.parent / ".env")

app = Flask(__name__)

# SECRET_KEY ต้องคงที่ (ใส่ใน .env) ไม่งั้น session จะหลุดทุกครั้งที่รีสตาร์ทแอป
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.permanent_session_lifetime = timedelta(days=90)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,
)

WEB_USERNAME = os.environ.get("WEB_USERNAME")
WEB_PASSWORD = os.environ.get("WEB_PASSWORD")

# โทเคนสำหรับให้ refresh_cron.py/refresh_loop.py เรียก /api/refresh_all ได้เองโดยไม่ต้อง login
# (ใช้ header แทน ไม่ใช้ remote_addr==127.0.0.1 เพราะ Caddy ก็ proxy มาจาก 127.0.0.1 เหมือนกัน
# เช็คแค่ IP จะเท่ากับเปิดช่องให้ใครก็ได้จากอินเทอร์เน็ตข้าม login ได้)
CRON_TOKEN = os.environ.get("CRON_TOKEN")

REQUEST_DELAY = 1.0  # หน่วงระหว่างเรื่องตอน refresh ทั้งหมด กันโดน block


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


_bootstrap_first_admin()


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
        if not is_admin():
            return jsonify({"error": "เฉพาะ admin เท่านั้น"}), 403
        return view(*args, **kwargs)

    return wrapper


@app.before_request
def require_login():
    # ถ้ายังไม่มีผู้ใช้ในระบบเลย (เช่น dev บนเครื่องตัวเอง ไม่เคยตั้ง WEB_USERNAME/WEB_PASSWORD)
    # ปล่อยผ่านไม่บังคับ login
    if not storage.load_users():
        return None
    if request.endpoint in ("login", "static"):
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


@app.route("/api/me")
def me():
    if not current_username():
        return jsonify({"username": None, "is_admin": False})
    return jsonify({"username": current_username(), "is_admin": is_admin()})


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

    users = storage.load_users()
    if username in users:
        return jsonify({"error": "มีชื่อผู้ใช้นี้อยู่แล้ว"}), 409

    users[username] = {"password_hash": generate_password_hash(password), "is_admin": new_is_admin}
    storage.save_users(users)
    # สมาชิกใหม่เริ่มจากไม่ติดตามอะไรเลย ไปเลือกเองที่หน้า "เรื่องทั้งหมด"
    storage.save_subscriptions(username, [])
    return jsonify({"username": username, "is_admin": new_is_admin}), 201


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_chapter_read(entry: dict | None, chapter_url: str, chapter_text: str | None = None) -> bool:
    """เช็คว่าตอนนี้ (ระบุด้วย url) อ่านแล้วหรือยัง"""
    if not entry:
        return False
    if chapter_url in entry.get("read_urls", []):
        return True
    # fallback สำหรับข้อมูลเก่าก่อนมีระบบติดตามรายตอน (มีแค่ last_read_chapter เป็นข้อความ)
    old_last = entry.get("last_read_chapter")
    if old_last and chapter_text and old_last == chapter_text:
        return True
    return False


def is_new(manga: dict, read_state: dict) -> bool:
    url = manga.get("latest_chapter_url")
    if not url:
        return False
    entry = read_state.get(manga["id"])
    return not is_chapter_read(entry, url, manga.get("latest_chapter"))


def mark_chapter_read(read_state: dict, manga_id: str, chapter_url: str):
    entry = read_state.setdefault(manga_id, {"read_urls": [], "last_read_at": None})
    read_urls = entry.setdefault("read_urls", [])
    # ย้ายไปท้ายลิสต์เสมอ (ไม่ใช่แค่ append ตอนยังไม่เคยอ่าน) เพราะ "ตอนล่าสุดที่อ่าน" (สำหรับ
    # bookmark/auto-scroll) อิงจากตัวท้ายสุดของลิสต์นี้ ถ้ากดกลับไปอ่านตอนเก่าที่เคยอ่านแล้วซ้ำ
    # ต้องขยับมาเป็น "ล่าสุด" ด้วย ไม่ใช่ค้างอยู่ตำแหน่งเดิมตอนอ่านครั้งแรก
    if chapter_url in read_urls:
        read_urls.remove(chapter_url)
    read_urls.append(chapter_url)
    entry["last_read_at"] = now_iso()


def serialize(manga: dict, read_state: dict) -> dict:
    out = dict(manga)
    out["is_new"] = is_new(manga, read_state)
    return out


def notify_subscribed_admins(manga_id: str, name: str, chapter: str, cover_url: str | None):
    """ส่ง Telegram แจ้งเตือนเฉพาะตอนที่ admin (ที่ตั้งค่า Telegram ไว้) ติดตามเรื่องนี้อยู่จริง"""
    for admin_username in admin_usernames():
        if manga_id in storage.load_subscriptions(admin_username):
            send_telegram(name, chapter, cover_url)
            return  # ส่งครั้งเดียวพอ (Telegram ตั้งค่าเป็นแชทเดียวอยู่แล้ว)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/manga", methods=["GET"])
def list_manga():
    subscribed_ids = set(storage.load_subscriptions(current_username())) if current_username() else None
    manga_items = storage.load_manga()
    if subscribed_ids is not None:
        manga_items = [m for m in manga_items if m["id"] in subscribed_ids]
    read_state = storage.load_read_state(current_username()) if current_username() else {}
    items = [serialize(m, read_state) for m in manga_items]
    # เรื่องที่ยังไม่อ่านขึ้นก่อน แล้วภายในกลุ่มเดียวกันเรียงตามเวลาที่ "เจอตอนใหม่จริง ๆ"
    # ล่าสุดก่อน (last_updated_at เปลี่ยนเฉพาะตอนตอนล่าสุดเปลี่ยนจริง ไม่ใช่ทุกครั้งที่เช็ค)
    items.sort(key=lambda m: m.get("last_updated_at") or "", reverse=True)
    items.sort(key=lambda m: m["is_new"], reverse=True)
    return jsonify(items)


@app.route("/api/catalog", methods=["GET"])
def list_catalog():
    """เรื่องทั้งหมดในระบบ (ไม่กรองตามที่ติดตาม) ไว้ให้เลือกติดตามเพิ่ม"""
    subscribed_ids = set(storage.load_subscriptions(current_username())) if current_username() else set()
    manga_items = storage.load_manga()
    items = []
    for m in manga_items:
        out = dict(m)
        out["is_subscribed"] = m["id"] in subscribed_ids
        items.append(out)
    items.sort(key=lambda m: m["name"])
    return jsonify(items)


@app.route("/api/catalog/<manga_id>/subscribe", methods=["POST"])
def subscribe(manga_id):
    username = current_username()
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    manga_items = storage.load_manga()
    if not any(m["id"] == manga_id for m in manga_items):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    subs = storage.load_subscriptions(username)
    if manga_id not in subs:
        subs.append(manga_id)
        storage.save_subscriptions(username, subs)
    return jsonify({"ok": True})


@app.route("/api/catalog/<manga_id>/unsubscribe", methods=["POST"])
def unsubscribe(manga_id):
    username = current_username()
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    subs = storage.load_subscriptions(username)
    if manga_id in subs:
        subs.remove(manga_id)
        storage.save_subscriptions(username, subs)
    return jsonify({"ok": True})


@app.route("/api/manga", methods=["POST"])
@require_admin
def add_manga():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    url = (body.get("url") or "").strip()

    if not name or not url:
        return jsonify({"error": "ต้องระบุชื่อและ URL"}), 400
    if not url.startswith("http://") and not url.startswith("https://"):
        return jsonify({"error": "URL ไม่ถูกต้อง"}), 400

    manga_items = storage.load_manga()
    mid = storage.make_id(url)
    if any(m["id"] == mid for m in manga_items):
        return jsonify({"error": "มีเรื่องนี้อยู่แล้ว"}), 409

    new_item = {
        "id": mid,
        "name": name,
        "url": url,
        "source": urlparse(url).netloc,
        "latest_chapter": None,
        "latest_chapter_url": None,
        "cover_url": None,
        "chapters": [],
        "last_checked_at": None,
        "last_updated_at": None,
    }

    # ลองดึงข้อมูลทันทีตอนเพิ่ม เพื่อให้เห็นตอนล่าสุด/ปก ทันที
    try:
        html = scraper.fetch(url)
        parsed = scraper.parse_index_page(html)
        new_item.update(parsed)
        new_item["last_checked_at"] = now_iso()
        if parsed.get("latest_chapter"):
            new_item["last_updated_at"] = new_item["last_checked_at"]
    except Exception as e:
        print(f"⚠️ ดึงข้อมูลตอนเพิ่มเรื่องใหม่ไม่สำเร็จ: {e}")

    manga_items.append(new_item)
    storage.save_manga(manga_items)

    # คนเพิ่มเรื่อง (admin) ให้ติดตามเรื่องนี้เองอัตโนมัติ
    subs = storage.load_subscriptions(current_username())
    subs.append(mid)
    storage.save_subscriptions(current_username(), subs)

    return jsonify(new_item), 201


@app.route("/api/manga/<manga_id>", methods=["DELETE"])
@require_admin
def delete_manga(manga_id):
    manga_items = storage.load_manga()
    remaining = [m for m in manga_items if m["id"] != manga_id]
    if len(remaining) == len(manga_items):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    storage.save_manga(remaining)

    # เอาออกจาก subscriptions/read_state ของทุกคน กันข้อมูลค้าง
    for username in storage.all_usernames():
        subs = storage.load_subscriptions(username)
        if manga_id in subs:
            subs.remove(manga_id)
            storage.save_subscriptions(username, subs)
        read_state = storage.load_read_state(username)
        if manga_id in read_state:
            del read_state[manga_id]
            storage.save_read_state(username, read_state)

    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/refresh", methods=["POST"])
@require_admin
def refresh_manga(manga_id):
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    try:
        html = scraper.fetch(manga["url"])
        parsed = scraper.parse_index_page(html)
        prev_chapter = manga.get("latest_chapter")
        manga.update(parsed)
        manga["last_checked_at"] = now_iso()
        if parsed.get("latest_chapter") and parsed["latest_chapter"] != prev_chapter:
            manga["last_updated_at"] = manga["last_checked_at"]
    except Exception as e:
        return jsonify({"error": f"ดึงข้อมูลไม่สำเร็จ: {e}"}), 502

    storage.save_manga(manga_items)

    if prev_chapter and parsed.get("latest_chapter") and parsed["latest_chapter"] != prev_chapter:
        notify_subscribed_admins(manga_id, manga["name"], parsed["latest_chapter"], manga.get("cover_url"))

    read_state = storage.load_read_state(current_username())
    return jsonify(serialize(manga, read_state))


@app.route("/api/refresh_all", methods=["POST"])
def refresh_all():
    # เข้าถึงได้จาก CRON_TOKEN (refresh_loop.py, ไม่มี session) หรือ session ของ admin เท่านั้น
    if current_username() and not is_admin():
        return jsonify({"error": "เฉพาะ admin เท่านั้น"}), 403

    manga_items = storage.load_manga()
    updated_ids = []
    failed = []

    for idx, manga in enumerate(manga_items):
        if idx > 0:
            time.sleep(REQUEST_DELAY)
        try:
            html = scraper.fetch(manga["url"])
            parsed = scraper.parse_index_page(html)
            prev_chapter = manga.get("latest_chapter")
            manga.update(parsed)
            manga["last_checked_at"] = now_iso()
            if parsed.get("latest_chapter") and parsed["latest_chapter"] != prev_chapter:
                manga["last_updated_at"] = manga["last_checked_at"]
                updated_ids.append(manga["id"])
                # แจ้งเตือนเฉพาะตอนที่เคยรู้ตอนล่าสุดมาก่อนแล้วเปลี่ยน (ไม่แจ้งตอนเพิ่งเพิ่มเรื่องใหม่)
                if prev_chapter:
                    notify_subscribed_admins(manga["id"], manga["name"], parsed["latest_chapter"], manga.get("cover_url"))
        except Exception as e:
            failed.append({"id": manga["id"], "name": manga["name"], "error": str(e)})

    storage.save_manga(manga_items)
    read_state = storage.load_read_state(current_username()) if current_username() else {}
    subscribed_ids = set(storage.load_subscriptions(current_username())) if current_username() else None
    visible = [m for m in manga_items if subscribed_ids is None or m["id"] in subscribed_ids]
    items = [serialize(m, read_state) for m in visible]
    return jsonify({"items": items, "updated_ids": updated_ids, "failed": failed})


@app.route("/api/manga/<manga_id>/chapter", methods=["GET"])
def get_chapter(manga_id):
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    chapter_url = request.args.get("url") or manga.get("latest_chapter_url")
    if not chapter_url:
        return jsonify({"error": "ยังไม่ทราบลิงก์ตอนล่าสุด ลองรีเฟรชเรื่องนี้ก่อน"}), 400

    # กันไม่ให้ยิงไปโดเมนอื่นที่ไม่เกี่ยวกับเรื่องนี้
    if urlparse(chapter_url).netloc != urlparse(manga["url"]).netloc:
        return jsonify({"error": "URL ตอนไม่ถูกต้อง"}), 400

    cached = storage.load_chapter_cache(manga_id, chapter_url)
    if cached:
        data = cached
    else:
        try:
            html = scraper.fetch(chapter_url, referer=manga["url"])
            data = scraper.parse_chapter_page(html)
        except Exception as e:
            return jsonify({"error": f"ดึงหน้าตอนไม่สำเร็จ: {e}"}), 502
        if data.get("images"):
            storage.save_chapter_cache(manga_id, chapter_url, data)
            storage.add_image_domains({urlparse(src).netloc for src in data["images"]})

    # มาร์คเฉพาะ "ตอนที่เปิดดูจริง" ว่าอ่านแล้ว (ไม่กระทบตอนอื่นของเรื่องเดียวกัน) เฉพาะของคนที่ login อยู่
    if current_username():
        read_state = storage.load_read_state(current_username())
        mark_chapter_read(read_state, manga_id, chapter_url)
        storage.save_read_state(current_username(), read_state)

    data["chapter_url"] = chapter_url
    data["manga_name"] = manga["name"]
    return jsonify(data)


@app.route("/api/manga/<manga_id>/chapters", methods=["GET"])
def list_chapters(manga_id):
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    read_state = storage.load_read_state(current_username()) if current_username() else {}
    entry = read_state.get(manga_id)
    chapters = manga.get("chapters") or []
    items = [
        {**c, "is_read": is_chapter_read(entry, c["url"], c["text"])}
        for c in chapters
    ]

    # ตอนล่าสุดที่กดอ่าน (ไว้ให้หน้าเว็บเลื่อนไปหาอัตโนมัติ) เอาจากตัวท้ายสุดของ read_urls
    # (ย้ายไปท้ายลิสต์ทุกครั้งที่อ่าน จึงเป็นตอนล่าสุดที่อ่านจริง) หรือ fallback ข้อมูลเก่า
    last_read_url = None
    if entry:
        read_urls = entry.get("read_urls") or []
        if read_urls:
            last_read_url = read_urls[-1]
        elif entry.get("last_read_chapter"):
            match = next((c for c in chapters if c["text"] == entry["last_read_chapter"]), None)
            if match:
                last_read_url = match["url"]

    return jsonify(
        {
            "manga_name": manga["name"],
            "cover_url": manga.get("cover_url"),
            "chapters": items,
            "last_read_url": last_read_url,
            "last_scroll": (entry or {}).get("last_scroll"),
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

    read_state = storage.load_read_state(current_username())
    entry = read_state.setdefault(manga_id, {"read_urls": [], "last_read_at": None})
    # ถ้าอ่านจบตอนแล้ว (>=95%) ไม่ต้องเก็บตำแหน่งไว้ เปิดใหม่ควรเริ่มจากบนสุดตามปกติ
    entry["last_scroll"] = None if fraction >= 0.95 else {"url": chapter_url, "fraction": fraction}
    storage.save_read_state(current_username(), read_state)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/mark_read", methods=["POST"])
def mark_read(manga_id):
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    if not manga.get("latest_chapter_url"):
        return jsonify({"error": "ยังไม่ทราบลิงก์ตอนล่าสุด ลองรีเฟรชเรื่องนี้ก่อน"}), 400

    read_state = storage.load_read_state(current_username())
    mark_chapter_read(read_state, manga_id, manga["latest_chapter_url"])
    storage.save_read_state(current_username(), read_state)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/mark_unread", methods=["POST"])
def mark_unread(manga_id):
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    read_state = storage.load_read_state(current_username())
    entry = read_state.get(manga_id)
    latest_url = manga.get("latest_chapter_url")
    if entry and latest_url and latest_url in entry.get("read_urls", []):
        entry["read_urls"].remove(latest_url)
        storage.save_read_state(current_username(), read_state)
    return jsonify({"ok": True})


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
        resp = requests.get(
            src,
            headers={
                "User-Agent": scraper.HEADERS["User-Agent"],
                "Referer": f"https://{netloc}/",
            },
            timeout=20,
            stream=True,
        )
        resp.raise_for_status()
    except Exception as e:
        return f"fetch failed: {e}", 502

    content_type = resp.headers.get("Content-Type", "image/jpeg")
    return Response(
        resp.content,
        content_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG") == "1"
    port = int(os.environ.get("PORT", "5050"))
    # host default เป็น 127.0.0.1 (ปลอดภัยกว่า); บน VPS ให้รันผ่าน gunicorn
    # แล้ววางหลัง nginx (ดู README) แทนที่จะรัน dev server ตรง ๆ
    app.run(debug=debug, host=os.environ.get("HOST", "127.0.0.1"), port=port)
