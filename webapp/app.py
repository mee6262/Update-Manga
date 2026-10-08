import gzip
import hashlib
import hmac
import html
import io
import json
import os
import re
import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlsplit, urlunsplit

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, Response, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import scraper
import storage
import webpush
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


def build_id() -> str:
    """รหัสเวอร์ชันของหน้าเว็บ = เวลาที่แก้ไฟล์หน้าบ้านล่าสุด ใช้ให้หน้าเว็บที่เปิดค้างอยู่รู้ว่ามีของ
    ใหม่แล้วควรโหลดตัวเองใหม่ — คิดจากไฟล์ static เท่านั้น (เสิร์ฟจากดิสก์ตรง ๆ จึงตรงกับของที่
    ผู้ใช้ได้รับจริงเสมอ) ไม่รวม app.py เพราะโค้ดฝั่ง server ที่แก้แล้วยังไม่รีสตาร์ท ของที่รันอยู่
    ยังเป็นตัวเก่า ถ้าเอามานับด้วยหน้าเว็บจะรีโหลดวนไม่จบ"""
    stamp = 0
    for name in ("app.js", "style.css"):
        try:
            stamp = max(stamp, int(os.stat(Path(app.static_folder) / name).st_mtime))
        except OSError:
            pass
    return str(stamp)


@app.route("/healthz")
def healthz():
    # ให้ตัวคุมเซิร์ฟเวอร์ (run_windows.py) เช็คว่ายังรับคำขอได้อยู่ไหม — ไม่ต้อง login ไม่แตะไฟล์ข้อมูล
    # ถ้าเซิร์ฟเวอร์ค้าง (thread ถูกใช้หมด) คำขอนี้ก็จะค้างตาม ตัวคุมจะรู้และรีสตาร์ทให้เอง
    return "ok"


@app.route("/sw.js")
def service_worker():
    # ต้องเสิร์ฟจาก root (ไม่ใช่ /static/) ถึงจะดูแลได้ทั้งเว็บ ไม่ต้อง login เพราะเบราว์เซอร์ดึงไฟล์นี้เอง
    # เบื้องหลัง — ห้ามแคชนาน ไม่งั้นแก้ไฟล์แล้วเครื่องผู้ใช้ไม่ได้ตัวใหม่
    resp = app.send_static_file("sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/api/push/subscribe", methods=["POST"])
def push_subscribe():
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    if not webpush.available():
        return jsonify({"error": "เซิร์ฟเวอร์ยังไม่ได้ติดตั้งระบบแจ้งเตือน (pip install -r requirements.txt)"}), 503
    sub = request.get_json(force=True, silent=True)
    if not webpush.valid_subscription(sub):
        return jsonify({"error": "ข้อมูลการสมัครรับแจ้งเตือนไม่ถูกต้อง"}), 400
    webpush.subscribe(current_username(), sub, request.headers.get("User-Agent", ""))
    return jsonify({"ok": True})


@app.route("/api/push/unsubscribe", methods=["POST"])
def push_unsubscribe():
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    endpoint = (request.get_json(force=True, silent=True) or {}).get("endpoint")
    if isinstance(endpoint, str):
        webpush.unsubscribe(current_username(), endpoint)
    return jsonify({"ok": True})


@app.route("/api/push/test", methods=["POST"])
def push_test():
    if not current_username():
        return jsonify({"error": "unauthorized"}), 401
    sent = webpush.send_to_user(
        current_username(),
        {"title": "MeeManga", "body": "เปิดแจ้งเตือนเรียบร้อย จะแจ้งเมื่อเรื่องที่ติดตามมีตอนใหม่หรือมีคนตอบคอมเมนต์", "tag": "test", "url": "/"},
        wait=True,
    )
    return jsonify({"sent": sent})


@app.route("/api/version")
def version():
    return jsonify({"build": build_id()})


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
    if request.endpoint in ("login", "register", "static", "healthz", "service_worker"):
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
        # บัญชีถูกลบ หรือรหัสผ่านถูกเปลี่ยน/รีเซ็ต (pw_ver เปลี่ยน) หลังจาก login เครื่องนี้ไว้ → ให้ login ใหม่
        # ทุกเครื่องที่ค้างอยู่ ไม่งั้นคนที่รู้รหัสเก่าก็ยังใช้บัญชีต่อได้เรื่อย ๆ
        user = storage.load_users().get(current_username())
        if user and user.get("pw_ver", 0) == session.get("pw_ver", 0):
            _record_activity(current_username())
            return None
        session.clear()
    if request.path.startswith("/api/"):
        return jsonify({"error": "unauthorized"}), 401
    return redirect(url_for("login", next=request.path))


# ---------- บัญชีผู้ใช้ ----------
# ชื่อผู้ใช้ถูกใช้เป็นชื่อโฟลเดอร์ (data/users/<ชื่อ>/) ต้องจำกัดตัวอักษรเสมอ ไม่งั้นชื่ออย่าง "../x" จะเขียนไฟล์
# ออกนอกโฟลเดอร์ข้อมูลได้
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,19}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
MIN_PASSWORD = 8
RESET_PASSWORD = "00000000"
REGISTER_LIMIT = 5              # สมัครได้ไม่เกินกี่บัญชี
REGISTER_WINDOW = 3600          # ต่อ IP ต่อชั่วโมง (กันบอทสมัครรัว ๆ)
_register_log: dict[str, list[float]] = {}


def registration_open() -> bool:
    # ค่าเริ่มต้นปิด: เว็บเปิดให้เข้าจากอินเทอร์เน็ต ถ้าเปิดรับสมัครเองโดยไม่ตั้งใจ ใครรู้ลิงก์ก็สมัครใช้เซิร์ฟเวอร์ได้
    return bool(storage.load_site_settings().get("registration_open", False))


def _validate_username(username: str) -> str | None:
    if not USERNAME_RE.match(username):
        return "ชื่อผู้ใช้ต้องยาว 3-20 ตัว ใช้ได้เฉพาะ a-z, 0-9, _ . - (ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)"
    return None


def _validate_new_password(password: str, confirm: str | None = None) -> str | None:
    if len(password) < MIN_PASSWORD:
        return f"รหัสผ่านต้องยาวอย่างน้อย {MIN_PASSWORD} ตัว"
    if len(password) > 128:
        return "รหัสผ่านยาวเกินไป"
    if confirm is not None and password != confirm:
        return "ยืนยันรหัสผ่านไม่ตรงกัน"
    return None


def _start_session(username: str, user: dict):
    session.clear()
    session.permanent = True
    session["user"] = username
    session["is_admin"] = bool(user.get("is_admin"))
    session["pw_ver"] = user.get("pw_ver", 0)


def _safe_next(target: str | None) -> str:
    # กันลิงก์ ?next=https://เว็บอื่น พาผู้ใช้ออกไปนอกเว็บหลัง login (open redirect)
    if target and target.startswith("/") and not target.startswith("//"):
        return target
    return url_for("index")


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        users = storage.load_users()
        user = users.get(username)
        if user and check_password_hash(user["password_hash"], password):
            _start_session(username, user)
            return redirect(_safe_next(request.args.get("next")))
        error = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
    return render_template("login.html", error=error, mode="login", form={}, registration_open=registration_open())


@app.route("/register", methods=["GET", "POST"])
def register():
    if not registration_open():
        return render_template(
            "login.html", error="ขณะนี้ปิดรับสมัครสมาชิก ติดต่อผู้ดูแลเพื่อขอบัญชี", mode="login", form={},
            registration_open=False,
        ), 403
    if request.method == "GET":
        return render_template("login.html", error=None, mode="register", form={}, registration_open=True)
    form = {k: request.form.get(k, "").strip() for k in ("username", "email")}
    password = request.form.get("password", "")
    confirm = request.form.get("confirm", "")

    def fail(message):
        return render_template("login.html", error=message, mode="register", form=form, registration_open=True), 400

    error = _validate_username(form["username"]) or (
        None if EMAIL_RE.match(form["email"]) else "รูปแบบอีเมลไม่ถูกต้อง"
    ) or _validate_new_password(password, confirm)
    if error:
        return fail(error)

    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    now = time.time()
    recent = [t for t in _register_log.get(ip, []) if now - t < REGISTER_WINDOW]
    if len(recent) >= REGISTER_LIMIT:
        return fail("สมัครสมาชิกถี่เกินไป ลองใหม่อีกครั้งภายหลัง")

    with storage.state_lock:
        users = storage.load_users(fresh=True)
        if any(u.casefold() == form["username"].casefold() for u in users):
            return fail("มีชื่อผู้ใช้นี้อยู่แล้ว")
        if any((info.get("email") or "").casefold() == form["email"].casefold() for info in users.values()):
            return fail("อีเมลนี้ถูกใช้สมัครไปแล้ว")
        user = {
            "password_hash": generate_password_hash(password),
            "is_admin": False,
            "email": form["email"],
            "created_at": now_iso(),
        }
        users[form["username"]] = user
        storage.save_users(users)
        # สมาชิกใหม่เริ่มจากไม่ติดตามอะไรเลย ไปเลือกเองที่หน้า "ทั้งหมด"
        storage.save_subscriptions(form["username"], [])
    _register_log[ip] = recent + [now]
    _start_session(form["username"], user)
    return redirect(url_for("index"))


@app.route("/api/account/password", methods=["POST"])
def change_password():
    username = current_username()
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    old, new, confirm = body.get("old") or "", body.get("new") or "", body.get("confirm") or ""
    error = _validate_new_password(new, confirm)
    if error:
        return jsonify({"error": error}), 400
    if new == RESET_PASSWORD:
        return jsonify({"error": "รหัสผ่านใหม่ต้องไม่ใช่รหัสเริ่มต้น 00000000"}), 400
    with storage.state_lock:
        users = storage.load_users(fresh=True)
        user = users.get(username)
        if not user or not check_password_hash(user["password_hash"], old):
            return jsonify({"error": "รหัสผ่านเดิมไม่ถูกต้อง"}), 400
        user["password_hash"] = generate_password_hash(new)
        user["pw_ver"] = user.get("pw_ver", 0) + 1  # เครื่องอื่นที่ login ค้างไว้ต้อง login ใหม่
        user.pop("must_change_password", None)
        storage.save_users(users)
    session["pw_ver"] = user["pw_ver"]  # เครื่องที่กดเปลี่ยนเองยังใช้ต่อได้
    return jsonify({"ok": True})


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
    with storage.state_lock:
        prefs = storage.load_prefs(current_username(), fresh=True)
        prefs.update(body)
        storage.save_prefs(current_username(), prefs)
    return jsonify({"ok": True})


@app.route("/api/users", methods=["GET"])
@require_admin
def list_users():
    users = storage.load_users()
    return jsonify([
        {
            "username": u,
            "is_admin": bool(info.get("is_admin")),
            "email": info.get("email"),
            "must_change_password": bool(info.get("must_change_password")),
        }
        for u, info in users.items()
    ])


@app.route("/api/site_settings", methods=["GET"])
@require_admin
def get_site_settings():
    return jsonify({"registration_open": registration_open()})


@app.route("/api/site_settings", methods=["PUT"])
@require_admin
def update_site_settings():
    body = request.get_json(force=True, silent=True) or {}
    with storage.state_lock:
        settings = storage.load_site_settings(fresh=True)
        if "registration_open" in body:
            settings["registration_open"] = bool(body["registration_open"])
        storage.save_site_settings(settings)
    return jsonify({"registration_open": registration_open()})


@app.route("/api/users/<username>/reset_password", methods=["POST"])
@require_admin
def reset_password(username):
    """รีเซ็ตรหัสผ่านสมาชิกเป็น 00000000 — ทุกเครื่องของสมาชิกคนนั้นถูกให้ login ใหม่ และจะเห็นแจ้งเตือนให้ไป
    เปลี่ยนรหัสผ่านที่หน้าตั้งค่าจนกว่าจะเปลี่ยน"""
    with storage.state_lock:
        users = storage.load_users(fresh=True)
        user = users.get(username)
        if not user:
            return jsonify({"error": "ไม่พบสมาชิกนี้"}), 404
        user["password_hash"] = generate_password_hash(RESET_PASSWORD)
        user["pw_ver"] = user.get("pw_ver", 0) + 1
        user["must_change_password"] = True
        storage.save_users(users)
    if username == current_username():
        session["pw_ver"] = user["pw_ver"]
    return jsonify({"ok": True})


@app.route("/api/users", methods=["POST"])
@require_admin
def add_user():
    body = request.get_json(force=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    new_is_admin = bool(body.get("is_admin"))

    error = _validate_username(username) or _validate_new_password(password)
    if error:
        return jsonify({"error": error}), 400

    users = storage.load_users(fresh=True)
    if any(u.casefold() == username.casefold() for u in users):
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


def refresh_from_sources(sources: list[dict], min_interval: float = 0.0, manga_id: str | None = None) -> dict:
    """ดึงข้อมูลจากทุกแหล่งที่มาของเรื่องเดียวกันแล้วรวมเป็นชุดเดียว กันเรื่องที่แหล่งใดแหล่งหนึ่ง
    เงียบหายไม่อัพเดต — ตอนล่าสุดเอาจากแหล่งที่มีเลขตอนสูงสุด ส่วนรายชื่อตอนรวมจากทุกแหล่งเข้า
    ด้วยกัน (ตัวซ้ำตามเลขตอน แหล่งที่มาก่อนในลิสต์ชนะถ้าเลขตอนซ้ำ) เพื่อให้อ่านตอนเก่าจากแหล่งที่
    ยังมีอยู่ได้ปกติ ถึงแหล่งอื่นจะตายไปแล้วก็ตาม แหล่งไหนดึงพลาดก็ข้ามไป ไม่ล้มทั้งเรื่อง"""
    per_source = []
    failed = 0
    for src in sources:
        url = src.get("url")
        if not url:
            continue
        # เว็บที่เพิ่งล่มไป (จำไว้ใน scraper) ข้ามไปก่อน ไม่ต้องรอ timeout ซ้ำทุกเรื่องที่อยู่เว็บเดียวกัน
        if scraper.host_is_down(url):
            failed += 1
            print(f"⚠️ ข้าม {url} (เว็บนี้เพิ่งล่ม)")
            continue
        try:
            html = scraper.fetch(url, min_interval=min_interval)
            per_source.append(scraper.parse_index_page(html, url, min_interval))
        except Exception as e:
            failed += 1
            print(f"⚠️ ดึงข้อมูลจาก {url} ไม่สำเร็จ: {e}")

    if not per_source:
        return {}

    # ตอนเดียวกันจากหลายแหล่ง: แหล่งแรกในลิสต์เป็นลิงก์หลัก ส่วนของแหล่งอื่นเก็บไว้ใน "alts" เป็นทางสำรอง
    # เวลาแหล่งหลักล่มตอนผู้ใช้กดอ่าน จะได้สลับไปอ่านจากแหล่งอื่นให้อัตโนมัติ (ดู get_chapter)
    by_num = {}
    for parsed in per_source:
        for c in parsed["chapters"]:
            key = _chapter_key(c["text"])
            primary = by_num.get(key)
            if primary is None:
                by_num[key] = {**c}
            elif c["url"] != primary["url"] and c["url"] not in primary.get("alts", []):
                primary.setdefault("alts", []).append(c["url"])
    merged_chapters = sorted(by_num.values(), key=_num_or_neg, reverse=True)
    dropped = _drop_placeholder_chapters(manga_id, merged_chapters, min_interval)
    dropped_urls = {u for c in dropped for u in [c["url"], *(c.get("alts") or [])]}

    # เผื่อทุกแหล่งไม่มี #chapterlist/AJAX เลย (เช่น Madara ที่ดึงลิสต์ไม่ได้) แต่ยังรู้ตอนล่าสุด
    # จากปุ่ม "Read Last" อยู่ — เทียบตอนล่าสุดของแต่ละแหล่งเข้าไปในกองเดียวกันด้วย
    candidates = list(merged_chapters)
    known_urls = {c["url"] for c in candidates} | dropped_urls
    for parsed in per_source:
        if parsed.get("latest_chapter_url") and parsed["latest_chapter_url"] not in known_urls:
            candidates.append({"text": parsed.get("latest_chapter"), "url": parsed["latest_chapter_url"], "date": None})
            known_urls.add(parsed["latest_chapter_url"])

    best = max(candidates, key=_num_or_neg, default=None)

    return {
        # มีบางแหล่งดึงไม่สำเร็จรอบนี้ (_apply_refresh จะเก็บตอนเก่าของแหล่งนั้นไว้ ไม่ให้หายจากลิสต์)
        "_partial": failed > 0,
        # ตอนหลอกที่ถูกตัดทิ้งรอบนี้ (_apply_refresh ต้องไม่เอาตอนเดิมที่เคยเก็บไว้กลับมาใส่คืน)
        "_dropped_keys": [_chapter_key(c["text"]) for c in dropped],
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


def _is_new_chapter(prev: str | None, new: str | None) -> bool:
    """ตอนล่าสุดเปลี่ยนจริงไหม — เทียบด้วยคีย์ตอน (เลขตอน) ไม่ใช่ข้อความตรง ๆ เพราะบางเว็บเปลี่ยนรูปแบบ
    ข้อความของตอนเดิมได้ (เช่นมีป้าย "ใหม่" ต่อท้ายช่วงแรก แล้วหายไปทีหลัง) ถ้าเทียบข้อความจะแจ้งเตือนซ้ำ"""
    if not new:
        return False
    new_key, prev_key = _chapter_key(new), _chapter_key(prev)
    # เลขตอนถอยหลัง (เช่นตอนหลอกที่เคยขึ้นเป็นตอนล่าสุดถูกตัดทิ้ง กลับมาเป็นตอนเดิม) ไม่ใช่ตอนใหม่
    if isinstance(new_key, float) and isinstance(prev_key, float):
        return new_key > prev_key
    return new_key != prev_key


def _apply_refresh(manga: dict, parsed: dict) -> str | None:
    """เอาผลจาก refresh_from_sources มาอัพเดตลง manga record คืนค่าตอนล่าสุดก่อนหน้า (ให้ caller
    เอาไปเทียบว่าเปลี่ยนไหมสำหรับแจ้งเตือน) — ถ้ารอบนี้ดึงรายชื่อตอนมาได้ว่างเปล่า (เช่นโดน
    rate-limit หรือหน้าเพจเพี้ยนชั่วคราว) แต่ก่อนหน้านี้เคยมีรายชื่อตอนอยู่แล้ว จะไม่ยอมทับด้วยลิสต์
    ว่าง เพราะเรื่องที่ตอนล่าสุดหายไปจากลิสต์ (ถึง latest_chapter_url จะยังถูกต้อง) ทำให้ประวัติการ
    อ่าน/bookmark ของตอนอื่น ๆ ในเรื่องนั้นหาตัวเองในลิสต์ไม่เจอ แล้วมองว่ายังไม่เคยอ่านทั้งหมด"""
    prev_chapter = manga.get("latest_chapter")
    parsed = dict(parsed)
    partial = parsed.pop("_partial", False)
    dropped_keys = set(parsed.pop("_dropped_keys", []))
    if not parsed.get("chapters") and manga.get("chapters"):
        parsed["chapters"] = manga["chapters"]
    elif partial and manga.get("chapters"):
        # บางแหล่งล่มรอบนี้ ข้อมูลของแหล่งนั้นจะหายไปจากผลรอบนี้ทั้งที่เว็บแค่ล่มชั่วคราว:
        # - ตอนที่มีแค่ในแหล่งนั้น (เช่นตอนเก่า ๆ ที่แหล่งอื่นไม่มี) เก็บตอนเดิมไว้ในลิสต์ก่อน
        # - ตอนที่มีหลายแหล่ง ลิงก์เดิมของแหล่งที่ล่มเก็บไว้เป็นลิงก์สำรอง ไม่งั้นหน้าเว็บที่ยังถือลิงก์เดิมอยู่
        #   (เปิดค้างไว้ก่อนรีเฟรช) กดอ่านแล้วจะหาทางสลับไปแหล่งอื่นไม่เจอ
        # รอแหล่งนั้นกลับมาแล้วรีเฟรชรอบถัดไปจะได้ของสดครบเหมือนเดิม
        old_by_key = {
            k: c for c in manga["chapters"] if (k := _chapter_key(c["text"])) not in dropped_keys
        }
        for c in parsed["chapters"]:
            old = old_by_key.pop(_chapter_key(c["text"]), None)
            for url in [old["url"], *(old.get("alts") or [])] if old else []:
                if url != c["url"] and url not in c.get("alts", []):
                    c.setdefault("alts", []).append(url)
        if old_by_key:
            parsed["chapters"] = sorted(parsed["chapters"] + list(old_by_key.values()), key=_num_or_neg, reverse=True)
    manga.update(parsed)
    manga["last_checked_at"] = now_iso()
    if parsed.get("latest_chapter_url"):
        manga["source"] = urlparse(parsed["latest_chapter_url"]).netloc
    if _is_new_chapter(prev_chapter, parsed.get("latest_chapter")):
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
        "build": build_id(),
        "push_key": webpush.public_key() if username else None,
        "categories": storage.load_categories(),
        "me": {
            "username": username,
            "is_admin": is_admin(),
            "must_change_password": bool(storage.load_users().get(username, {}).get("must_change_password")) if username else False,
        },
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
    followers = _follower_counts()
    items = []
    for m in storage.load_manga():
        out = public_manga(m)
        out["is_subscribed"] = m["id"] in subscribed_ids
        out["followers"] = followers.get(m["id"], 0)
        items.append(out)
    items.sort(key=lambda m: m["name"])
    return jsonify(items)


def _follower_counts() -> dict[str, int]:
    """จำนวนคนที่ติดตามแต่ละเรื่อง (ไว้ทำ "เรื่องที่ทุกคนกำลังตาม" ในหน้าค้นหา) — อ่านจากแคชในหน่วยความจำ ถูกมาก"""
    counts: dict[str, int] = {}
    for username in storage.all_usernames():
        for manga_id in storage.load_subscriptions(username):
            counts[manga_id] = counts.get(manga_id, 0) + 1
    return counts


# ---------- วิดีโอ Facebook ----------

FACEBOOK_VIDEO_HOSTS = {"facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"}
MAX_VIDEO_TITLE = 160
MAX_VIDEO_POSITION = 24 * 60 * 60


def _canonical_facebook_video_url(value: object) -> tuple[str | None, str | None]:
    """ตรวจ URL ที่ฝังได้และตัด tracking ออกก่อนใช้เป็นตัวตนของคลิป

    Facebook มีทั้ง /videos/, /reel/ และ fb.watch ที่ไม่ได้มีเลข id ใน URL เสมอไป จึงใช้ URL ที่
    normalize แล้ว hash แทน regex ดึงตัวเลข ซึ่งกันคลิปซ้ำได้ไม่ครบและพังกับ Reels บางแบบ.
    """
    if not isinstance(value, str):
        return None, "ลิงก์วิดีโอไม่ถูกต้อง"
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None, "ลิงก์วิดีโอไม่ถูกต้อง"
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in FACEBOOK_VIDEO_HOSTS or not parsed.path:
        return None, "รับเฉพาะลิงก์ https ของ Facebook หรือ fb.watch"
    if host != "fb.watch" and parsed.path.startswith("/share/"):
        # ลิงก์แชร์ต้องถูกแปลงเป็นลิงก์ /reel/ ก่อน (add_video ทำให้ด้วย _facebook_page_meta) — ถ้ามาถึงตรงนี้
        # แปลว่าแปลงไม่สำเร็จ ฝังลิงก์ share ตรง ๆ ไม่ได้
        return None, "แปลงลิงก์แชร์ Facebook ไม่สำเร็จ ลองเปิดลิงก์แล้วคัดลอก URL /reel/ หรือ /videos/ มาแทน"
    video_id = _facebook_video_id(parsed)
    if video_id and "/reel/" in parsed.path:
        return f"https://www.facebook.com/reel/{video_id}", None
    if video_id and parsed.path.rstrip("/") in ("/watch", "/video.php"):
        # เดิมตัด query ทิ้งทั้งหมด ลิงก์ /watch?v=... ทุกคลิปเลยกลายเป็นลิงก์เดียวกัน (เพิ่มคลิปที่ 2 ไม่ได้)
        return f"https://www.facebook.com/watch/?v={video_id}", None
    # URL query ของ Facebook ส่วนใหญ่เป็น tracking; ใช้ path เป็น identity เพื่อกันการเพิ่มคลิปเดิมซ้ำ
    path = "/" + parsed.path.strip("/")
    canonical_host = "www.facebook.com" if host in {"facebook.com", "m.facebook.com"} else host
    return urlunsplit(("https", canonical_host, path, "", "")), None


def _facebook_video_id(parsed) -> str | None:
    match = re.search(r"/(?:reel|videos)/(?:[^/]+/)*?(\d{6,})", parsed.path)
    if match:
        return match.group(1)
    if parsed.path.rstrip("/") in ("/watch", "/video.php"):
        match = re.search(r"(?:^|&)v=(\d{6,})", parsed.query)
        return match.group(1) if match else None
    return None


FB_META_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


# og:title ของลิงก์ watch/?v= มียอดดู/ยอดรีแอคนำหน้า เช่น "ยอดดู 6 พัน ครั้ง · 159 ความรู้สึก | ชื่อจริง"
_FB_TITLE_STATS_RE = re.compile(
    r"^[^|]*?\d[^|]*?(?:ยอดดู|ความรู้สึก|views?|reactions?|plays?)[^|]*\|\s*", re.IGNORECASE)


def _clean_video_title(title: str) -> str:
    title = " ".join((title or "").split())
    cleaned = _FB_TITLE_STATS_RE.sub("", title, count=1)
    return cleaned or title


def _facebook_page_meta(url: str) -> dict:
    """เปิดหน้า Facebook แบบเบราว์เซอร์มือถือ แล้วอ่าน og:url / og:image / og:title — ใช้แปลงลิงก์แชร์
    (/share/v/...) เป็นลิงก์ reel และดึงชื่อ/รูปปกให้อัตโนมัติ ไม่ต้องใช้ App Token พลาดคืน {} (ไม่ล้มทั้งการเพิ่ม)"""
    try:
        resp = requests.get(url, headers={"User-Agent": FB_META_UA, "Accept-Language": "th,en;q=0.8"},
                            timeout=(5, 10), allow_redirects=True)
        if (urlsplit(resp.url).hostname or "").lower() not in FACEBOOK_VIDEO_HOSTS:
            return {}
        text = resp.text[:600_000]
    except Exception as e:
        print(f"⚠️ อ่านข้อมูลคลิป Facebook ไม่สำเร็จ: {e}")
        return {}
    meta = {}
    for key in ("url", "image", "title"):
        match = re.search(rf'<meta property="og:{key}" content="([^"]+)"', text)
        if match:
            meta[key] = html.unescape(match.group(1))
    # คลิปไม่สาธารณะ Facebook ส่งหน้า login มาแทน (og:url = /login/, og:title = "เข้าสู่ระบบ Facebook") — ห้ามใช้เป็นชื่อ/ลิงก์
    if urlsplit(meta.get("url", "")).path.startswith("/login"):
        return {}
    return meta


FB_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
_DASH_DURATION_RE = re.compile(r'mediaPresentationDuration=\\?"PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S')


def _facebook_embed_check(facebook_url: str) -> tuple[float | None, bool]:
    """เปิดหน้าตัวเล่นแบบฝัง (plugins/video.php) คืน (ความยาวคลิปเป็นวินาที, เล่นแบบฝังไม่ได้)
    - ความยาว: จาก DASH manifest (mediaPresentationDuration) — iPhone อ่านความยาวจากตัวเล่นไม่ได้
      (getDuration ไม่ตอบ) แถบความคืบหน้าบนการ์ดเลยไม่ขึ้น จึงเก็บไว้กับคลิปแทน
    - เล่นไม่ได้: คลิปไม่สาธารณะ/เจ้าของปิดการฝัง หน้าขึ้น "Video unavailable ... permission" — เพิ่มไปก็เปิดดูในเว็บไม่ได้
    พลาด (เน็ต/ไม่เจอ) คืน (None, False) ไม่ขวางการเพิ่มคลิป"""
    url = "https://www.facebook.com/plugins/video.php?" + urlencode({"href": facebook_url, "show_text": "false"})
    try:
        resp = requests.get(url, headers={"User-Agent": FB_DESKTOP_UA, "Accept-Language": "en"}, timeout=(5, 10))
        text = resp.text
    except Exception as e:
        print(f"⚠️ อ่านข้อมูลตัวเล่น Facebook ไม่สำเร็จ: {e}")
        return None, False
    match = _DASH_DURATION_RE.search(text)
    if not match:
        return None, "Video unavailable" in text and "permission to view" in text
    seconds = int(match.group(1) or 0) * 3600 + int(match.group(2) or 0) * 60 + float(match.group(3))
    return (round(seconds, 1) if 0 < seconds <= MAX_VIDEO_POSITION else None), False


_HD_SD_SRC_RE = re.compile(r'"(hd_src|sd_src)":"(https:[^"]+)"')
_video_sources_cache: dict[str, tuple[float, dict]] = {}


def _fbcdn_sources(pairs) -> tuple[dict, float]:
    """[(hd|sd, ลิงก์)] → ({"hd", "sd"}, เวลาหมดอายุของแคช) รับเฉพาะ https *.fbcdn.net"""
    sources, expires = {}, time.time() + 6 * 3600
    for kind, link in pairs:
        parts = urlsplit(link or "")
        if parts.scheme != "https" or not (parts.hostname or "").endswith(".fbcdn.net"):
            continue
        sources.setdefault(kind, link)
        oe = parse_qs(parts.query).get("oe", [""])[0]
        try:
            expires = min(expires, int(oe, 16) - 3600)
        except ValueError:
            pass
    return sources, expires


def _facebook_embed_sources(facebook_url: str) -> list:
    """ทางหลัก: hd_src/sd_src ในหน้าตัวเล่นแบบฝัง (plugins/video.php)"""
    url = "https://www.facebook.com/plugins/video.php?" + urlencode({"href": facebook_url, "show_text": "false"})
    try:
        resp = requests.get(url, headers={"User-Agent": FB_DESKTOP_UA, "Accept-Language": "en"}, timeout=(5, 10))
    except Exception as e:
        print(f"⚠️ อ่านลิงก์ไฟล์คลิป Facebook ไม่สำเร็จ: {e}")
        return []
    pairs = []
    for kind, raw in _HD_SD_SRC_RE.findall(resp.text):
        try:
            pairs.append(("hd" if kind == "hd_src" else "sd", json.loads(f'"{raw}"')))  # สตริง JSON (\/ และ \u0025)
        except ValueError:
            continue
    return pairs


_FB_LSD_RE = re.compile(r'"LSD",\[\],\{"token":"([^"]+)"')
_FB_REELS_QUERY_RE = re.compile(
    r'"preloaderID":"adp_FBReelsRootWithEntrypointQueryRelayPreloader_[0-9a-f]+","queryID":"(\d+)","variables":')


def _facebook_graphql_sources(facebook_url: str) -> list:
    """ทางสำรอง: ยิง GraphQL query เดียวกับที่หน้า reel ของ Facebook ใช้โหลดคลิป (ไม่ล็อกอิน)
    ได้ browser_native_hd_url/sd_url — ใช้เมื่อหน้าตัวเล่นแบบฝังไม่ให้ลิงก์ (Facebook เปลี่ยนหน้า/เจ้าของปิดการฝัง)
    doc_id และ variables อ่านจากหน้า reel ทุกครั้ง ไม่ hardcode (Facebook เปลี่ยนเลขบ่อย)
    คลิปที่ต้องล็อกอินจะได้ video: null → คืน []"""
    video_id = _facebook_video_id(urlsplit(facebook_url))
    if not video_id:
        return []
    friendly = "FBReelsRootWithEntrypointQuery"
    try:
        with requests.Session() as http:  # ต้องใช้คุกกี้ (datr) จากหน้า reel ตอนยิง GraphQL
            http.headers.update({"User-Agent": FB_DESKTOP_UA, "Accept-Language": "en-US,en;q=0.9"})
            page_url = f"https://www.facebook.com/reel/{video_id}"
            page = http.get(page_url, headers={"Accept": "text/html", "Sec-Fetch-Mode": "navigate"}, timeout=(5, 10)).text
            lsd, query = _FB_LSD_RE.search(page), _FB_REELS_QUERY_RE.search(page)
            if not lsd or not query:
                return []
            variables, _ = json.JSONDecoder().raw_decode(page, query.end())
            resp = http.post(
                "https://www.facebook.com/api/graphql/",
                data={"lsd": lsd.group(1), "doc_id": query.group(1), "variables": json.dumps(variables),
                      "fb_api_req_friendly_name": friendly, "server_timestamps": "true"},
                headers={"X-FB-LSD": lsd.group(1), "X-FB-Friendly-Name": friendly, "Origin": "https://www.facebook.com",
                         "Referer": page_url, "Sec-Fetch-Site": "same-origin"},
                timeout=(5, 15),
            )
    except Exception as e:
        print(f"⚠️ GraphQL คลิป Facebook ไม่สำเร็จ: {e}")
        return []
    # ผลเป็น JSON หลายบรรทัด และมีคลิปแนะนำอื่นปนมา → เอาเฉพาะโหนดที่ id ตรงกับคลิปนี้
    found = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("id") == video_id and ("browser_native_hd_url" in node or "browser_native_sd_url" in node):
                found.extend([("hd", node.get("browser_native_hd_url")), ("sd", node.get("browser_native_sd_url"))])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    for line in resp.text.splitlines():
        try:
            walk(json.loads(line))
        except ValueError:
            continue
    return found


def _facebook_video_sources(facebook_url: str) -> dict:
    """ลิงก์ไฟล์ MP4 ตรงของคลิป ({"hd": ..., "sd": ...}) ให้หน้าเว็บเล่นด้วย <video> เอง
    — ตัวเล่น Facebook บน iPhone ไม่บอกตำแหน่ง/ไม่รับคำสั่ง seek จึงจำจุดดูค้างไม่ได้ ไฟล์ตรงได้ currentTime จริง
    ลองหน้าตัวเล่นแบบฝังก่อน ไม่ได้ค่อยใช้ GraphQL; ลิงก์มีอายุ (oe= ราว 4 วัน) แคชไว้ถึงก่อนหมดอายุ 1 ชม.
    พลาดทั้งสองทางคืน {} (หน้าเว็บกลับไปใช้ตัวเล่น Facebook)"""
    cached = _video_sources_cache.get(facebook_url)
    if cached and cached[0] > time.time():
        return cached[1]
    sources, expires = _fbcdn_sources(_facebook_embed_sources(facebook_url))
    if not sources:
        sources, expires = _fbcdn_sources(_facebook_graphql_sources(facebook_url))
    if sources:
        _video_sources_cache[facebook_url] = (expires, sources)
    return sources


def _facebook_video_duration(facebook_url: str) -> float | None:
    return _facebook_embed_check(facebook_url)[0]


FB_CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"


def _resolve_facebook_share(url: str) -> str | None:
    """ลิงก์แชร์ (/share/v/..., /share/r/...) → ลิงก์คลิปจริง จาก Location ที่ Facebook ตอบ crawler
    — แบบเบราว์เซอร์บางคลิปโดนเด้งไปหน้า login (ไม่มี og:url ให้อ่าน) แต่ crawler ได้ 302 ไป /reel/<id> ทุกครั้ง"""
    try:
        resp = requests.get(url, headers={"User-Agent": FB_CRAWLER_UA}, timeout=(5, 10), allow_redirects=False)
        location = resp.headers.get("Location") or ""
    except Exception as e:
        print(f"⚠️ แปลงลิงก์แชร์ Facebook ไม่สำเร็จ: {e}")
        return None
    target = urlsplit(location)
    if (target.hostname or "").lower() not in FACEBOOK_VIDEO_HOSTS or target.path.startswith(("/share/", "/login")):
        return None
    return location


_duration_backfill_lock = threading.Lock()
_duration_backfill_tried: set[str] = set()


def _needs_duration_backfill(video: dict) -> bool:
    # ตอนใน playlist นำเข้าทีละหลายร้อย — ไม่ไล่ยิงหน้าฝังของ Facebook ทุกตอน ความยาวได้จากตัวเล่นตอนดูจริง
    return not video.get("duration_seconds") and not video.get("playlist_id") and video["id"] not in _duration_backfill_tried


def _backfill_video_durations():
    """เติมความยาวให้คลิปที่เพิ่มไว้ก่อนมีระบบนี้ — รันเป็น thread แยก ไม่ให้หน้าคลังรอเน็ต
    ลองแต่ละคลิปครั้งเดียวต่อการรันเซิร์ฟเวอร์ (ดึงไม่ได้จะไม่ยิงซ้ำทุกครั้งที่เปิดหน้าคลัง)"""
    if not _duration_backfill_lock.acquire(blocking=False):
        return
    try:
        todo = [(v["id"], v["facebook_url"]) for v in storage.load_videos() if _needs_duration_backfill(v)]
        for video_id, facebook_url in todo:
            _duration_backfill_tried.add(video_id)
            duration = _facebook_video_duration(facebook_url)  # ยิงเน็ตนอก lock
            if not duration:
                continue
            with storage.state_lock:
                videos = storage.load_videos(fresh=True)
                for video in videos:
                    if video.get("id") == video_id:
                        video["duration_seconds"] = duration
                        storage.save_videos(videos)
                        break
    finally:
        _duration_backfill_lock.release()


def _fetch_video_thumb(video_id: str, image_url: str) -> bool:
    """ดาวน์โหลดรูปปกจาก Facebook มาย่อเก็บบนเซิร์ฟเวอร์ — ลิงก์รูปของ fbcdn มีวันหมดอายุ (พารามิเตอร์ oe=)
    ถ้าเก็บแค่ลิงก์ ปกจะหายเองภายในไม่กี่สัปดาห์ รับเฉพาะรูปจาก fbcdn.net (กันใช้เซิร์ฟเวอร์ยิงที่อยู่อื่น)"""
    host = (urlsplit(image_url).hostname or "").lower()
    if urlsplit(image_url).scheme != "https" or not host.endswith(".fbcdn.net"):
        return False
    try:
        resp = requests.get(image_url, headers={"User-Agent": FB_META_UA}, timeout=(5, 10))
        resp.raise_for_status()
        if len(resp.content) > MAX_RESIZE_BYTES:
            return False
        data = _resize_cover(resp.content, 400)
    except Exception as e:
        print(f"⚠️ ดาวน์โหลดรูปปกคลิปไม่สำเร็จ: {e}")
        return False
    if not data:
        return False
    storage.save_video_thumb(video_id, data)
    return True


def _can_delete_video(video: dict) -> bool:
    if not storage.load_users():  # dev mode ไม่มีบัญชี
        return True
    return is_admin() or video.get("added_by") == current_username()


def _public_video(video: dict, progress: dict | None = None, saved: dict | None = None) -> dict:
    entry = (progress or {}).get(video["id"]) or {}
    return {
        "watched_at": entry.get("updated_at"),  # มีค่า = เคยเล่น (แท็บประวัติการดู)
        "saved_at": (saved or {}).get(video["id"]),
        "position_seconds": entry.get("position_seconds", 0),
        "duration_seconds": entry.get("duration_seconds") or video.get("duration_seconds"),
        "id": video["id"],
        "title": _clean_video_title(video["title"]),  # คลิปที่เพิ่มก่อนมีตัวตัดยอดดู
        "facebook_url": video["facebook_url"],
        "thumbnail_url": video.get("thumbnail_url") or None,
        "external": bool(video.get("external")),
        "category_id": video.get("category_id"),
        "playlist_id": video.get("playlist_id"),
        "episode": video.get("episode"),
        "added_by": video["added_by"],
        "created_at": video["created_at"],
        "can_delete": _can_delete_video(video),
    }


@app.route("/api/videos", methods=["GET"])
def list_videos():
    # ส่งทั้งคลังทีเดียว (คลิปเพิ่มด้วยมือ จำนวนไม่มาก) ให้หน้าเว็บแบ่งหน้า/แยกแท็บ หน้าหลัก-คลัง-ประวัติ เอง
    # เดิมแบ่งหน้าด้วย cursor ฝั่งเซิร์ฟเวอร์ แล้วปุ่ม "โหลดเพิ่ม" ที่ไม่มีหน้าถัดไปดึงหน้าแรกมาต่อซ้ำ
    videos = sorted(storage.load_videos(), key=lambda item: item.get("created_at", ""), reverse=True)
    username = current_username() or "local"
    progress = storage.load_video_progress(username)
    saved = storage.load_video_saved(username)
    if any(_needs_duration_backfill(v) for v in videos):
        threading.Thread(target=_backfill_video_durations, daemon=True).start()
    return jsonify({
        "items": [_public_video(video, progress, saved) for video in videos],
        "categories": storage.load_video_categories(),
        "playlists": _public_playlists(videos),
        "next_cursor": None,
    })


@app.route("/api/videos", methods=["POST"])
def add_video():
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    title = " ".join(str(body.get("title") or "").split())
    raw_url = str(body.get("facebook_url") or "").strip()
    thumbnail_url = str(body.get("thumbnail_url") or "").strip()
    if thumbnail_url:
        thumb = urlsplit(thumbnail_url)
        if thumb.scheme != "https" or not thumb.hostname:
            return jsonify({"error": "รูปปกต้องเป็นลิงก์ https"}), 400

    # อ่านข้อมูลจากหน้า Facebook ก่อนเข้า lock (ห้ามยิงเน็ตใน state_lock) — แปลงลิงก์แชร์เป็น reel และใช้เป็น
    # ชื่อ/ปกอัตโนมัติถ้าผู้ใช้ไม่ได้ใส่มา
    meta = {}
    try:
        is_share = urlsplit(raw_url).path.startswith("/share/")
    except ValueError:
        is_share = False
    if raw_url.startswith("https://") and (is_share or not title or not thumbnail_url):
        meta = _facebook_page_meta(raw_url)
    resolved = (_resolve_facebook_share(raw_url) if is_share else None) or (meta.get("url") if is_share else None)
    facebook_url, error = _canonical_facebook_video_url(resolved or raw_url)
    if error:
        return jsonify({"error": error}), 400
    # คลิปที่เล่นแบบฝังไม่ได้ (ไม่สาธารณะ/ปิดการฝัง) ยังเพิ่มได้ แต่การ์ดจะเปิดในแอป Facebook แทนตัวเล่นในเว็บ
    duration, external = _facebook_embed_check(facebook_url)
    if external and _facebook_video_sources(facebook_url):
        external = False  # ปิดการฝังแต่เป็นคลิปสาธารณะ: GraphQL ให้ไฟล์ตรง เล่นในเว็บได้
    if not title:
        title = _clean_video_title(meta.get("title") or "")[:MAX_VIDEO_TITLE]
    title = title or "คลิปจาก Facebook"  # ฟอร์มไม่มีช่องชื่อแล้ว ดึงชื่อไม่ได้ก็ยังเพิ่มได้
    if len(title) > MAX_VIDEO_TITLE:
        return jsonify({"error": f"ชื่อเรื่องต้องไม่เกิน {MAX_VIDEO_TITLE} ตัวอักษร"}), 400
    canonical_key = hashlib.sha256(facebook_url.encode("utf-8")).hexdigest()[:20]
    if not thumbnail_url and meta.get("image") and not storage.video_thumb_path(canonical_key).exists():
        _fetch_video_thumb(canonical_key, meta["image"])
    if not thumbnail_url and storage.video_thumb_path(canonical_key).exists():
        thumbnail_url = f"/api/videos/{canonical_key}/thumb"
    # เขียนคลังกลางใต้ lock และ fresh=True เพื่อไม่ให้ request เพิ่มคนละคลิปพร้อมกันทับกัน
    with storage.state_lock:
        videos = storage.load_videos(fresh=True)
        existing = next((video for video in videos if video.get("canonical_key") == canonical_key), None)
        if existing:
            # POST แบบ idempotent: มือถือ/เน็ตช้าส่งซ้ำได้ แต่หน้าเว็บต้องไม่แจ้งล้มเหลวหลังคลิปถูกสร้างแล้ว
            return jsonify({**_public_video(existing), "already_exists": True})
        video = {
            "id": canonical_key,
            "canonical_key": canonical_key,
            "title": title,
            "facebook_url": facebook_url,
            "thumbnail_url": thumbnail_url or None,
            "duration_seconds": duration,
            "external": external,
            "added_by": username or "local",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        videos.append(video)
        storage.save_videos(videos)
    return jsonify(_public_video(video)), 201

@app.route("/api/videos/<video_id>", methods=["DELETE"])
def delete_video(video_id):
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    with storage.state_lock:
        videos = storage.load_videos(fresh=True)
        video = next((v for v in videos if v.get("id") == video_id), None)
        if not video:
            return jsonify({"error": "ไม่พบวิดีโอ"}), 404
        if not _can_delete_video(video):
            return jsonify({"error": "ลบได้เฉพาะคลิปที่ตัวเองเพิ่ม หรือ admin"}), 403
        storage.save_videos([v for v in videos if v.get("id") != video_id])
        # ล้างตำแหน่งที่ดูค้างของทุกคน กันข้อมูลค้างใน video_progress.json
        for u in [*storage.all_usernames(), "local"]:
            progress = storage.load_video_progress(u, fresh=True)
            if video_id in progress:
                del progress[video_id]
                storage.save_video_progress(u, progress)
        comments = storage.load_comments(fresh=True)
        if comments.pop(f"video:{video_id}", None) is not None:
            storage.save_comments(comments)
    return jsonify({"ok": True})

@app.route("/api/videos/<video_id>/thumb")
def video_thumb(video_id):
    if not re.fullmatch(r"[0-9a-f]{20}", video_id):
        return "not found", 404
    path = storage.video_thumb_path(video_id)
    if not path.exists():
        return "not found", 404
    resp = Response(path.read_bytes(), content_type="image/webp")
    resp.headers["Cache-Control"] = "private, max-age=2592000"
    return resp


def _video_exists(video_id: str) -> bool:
    return any(video.get("id") == video_id for video in storage.load_videos())


_SPEEDTEST_BYTES = os.urandom(256 * 1024)  # สุ่ม = บีบอัดไม่ได้ วัดความเร็วจริง


@app.route("/api/videos/speedtest", methods=["GET"])
def video_speedtest():
    """โหมดอัตโนมัติของตัวเล่นวัดความเร็วเน็ตกับ VPS เอง — fbcdn ไม่ส่ง CORS ให้ fetch ไฟล์วิดีโอวัดตรง ๆ"""
    return Response(_SPEEDTEST_BYTES, mimetype="application/octet-stream", headers={"Cache-Control": "no-store"})


@app.route("/api/videos/<video_id>/sources", methods=["GET"])
def get_video_sources(video_id):
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    video = next((v for v in storage.load_videos() if v.get("id") == video_id), None)
    if not video:
        return jsonify({"error": "ไม่พบวิดีโอ"}), 404
    if video.get("external"):
        return jsonify({})
    _record_activity(username or "local", "plays", video_id)  # เปิดตัวเล่น 1 ครั้ง = ดู 1 ครั้ง
    return jsonify(_facebook_video_sources(video["facebook_url"]))


@app.route("/api/videos/<video_id>/progress", methods=["GET"])
def get_video_progress(video_id):
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    if not _video_exists(video_id):
        return jsonify({"error": "ไม่พบวิดีโอ"}), 404
    entry = storage.load_video_progress(username or "local").get(video_id) or {}
    return jsonify({"position_seconds": entry.get("position_seconds", 0)})


@app.route("/api/videos/<video_id>/progress", methods=["POST"])
def save_video_progress(video_id):
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    if not _video_exists(video_id):
        return jsonify({"error": "ไม่พบวิดีโอ"}), 404
    body = request.get_json(force=True, silent=True) or {}
    value, duration = body.get("position_seconds"), body.get("duration_seconds")
    valid = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and 0 <= v <= MAX_VIDEO_POSITION
    if not valid(value) or (duration is not None and not valid(duration)):
        return jsonify({"error": "ตำแหน่งวิดีโอไม่ถูกต้อง"}), 400
    with storage.state_lock:
        progress = storage.load_video_progress(username or "local", fresh=True)
        entry = {"position_seconds": round(float(value), 1), "updated_at": datetime.now(timezone.utc).isoformat()}
        # ความยาวคลิปไว้วาดแถบความคืบหน้าบนการ์ด (ส่งมาไม่ได้ทุกครั้ง ใช้ค่าเดิมถ้ารอบนี้ไม่มี)
        if duration:
            entry["duration_seconds"] = round(float(duration), 1)
        elif progress.get(video_id, {}).get("duration_seconds"):
            entry["duration_seconds"] = progress[video_id]["duration_seconds"]
        progress[video_id] = entry
        storage.save_video_progress(username or "local", progress)
    return jsonify({"ok": True})


@app.route("/api/videos/<video_id>/progress", methods=["DELETE"])
def clear_video_progress(video_id):
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    with storage.state_lock:
        progress = storage.load_video_progress(username or "local", fresh=True)
        # ดูจบ: ล้างจุดที่ดูค้าง แต่เก็บรายการไว้ในประวัติการดู (เวลาที่ดู + ความยาว)
        # ไม่เคยบันทึกจุดค้าง (เช่น ข้ามไปท้ายตอนแล้วจบ) ก็สร้างรายการไว้ — playlist ใช้บอกว่าตอนนี้ "ดูแล้ว"
        old = progress.get(video_id)
        if old is not None or _video_exists(video_id):
            progress[video_id] = {**(old or {}), "position_seconds": 0, "updated_at": datetime.now(timezone.utc).isoformat()}
            storage.save_video_progress(username or "local", progress)
    return jsonify({"ok": True})


@app.route("/api/videos/<video_id>/save", methods=["POST"])
def save_video_bookmark(video_id):
    """ปุ่ม "บันทึก" ใต้การ์ด — เก็บรายคนใน video_saved.json"""
    username = current_username()
    if not username and storage.load_users():
        return jsonify({"error": "unauthorized"}), 401
    if not _video_exists(video_id):
        return jsonify({"error": "ไม่พบวิดีโอ"}), 404
    want = bool((request.get_json(force=True, silent=True) or {}).get("saved"))
    with storage.state_lock:
        saved = storage.load_video_saved(username or "local", fresh=True)
        if want:
            saved.setdefault(video_id, datetime.now(timezone.utc).isoformat())
        else:
            saved.pop(video_id, None)
        storage.save_video_saved(username or "local", saved)
        saved_at = saved.get(video_id)
    return jsonify({"saved_at": saved_at})


# ---------- สถิติการใช้งานรายวัน (หน้าแอดมิน) ----------
_SERVER_STARTED = time.time()
_activity_seen: set[tuple[str, str]] = set()  # (วัน, ผู้ใช้) ที่บันทึกแล้ว — ไม่เขียนไฟล์ทุก request
ACTIVITY_KEEP_DAYS = 60


def _record_activity(username: str, kind: str | None = None, item_id: str | None = None):
    """นับผู้ใช้ที่เข้าเว็บรายวัน + จำนวนครั้งที่อ่านตอน (reads) / เปิดคลิป (plays) ต่อเรื่อง/คลิป
    เขียนไฟล์เฉพาะตอนเจอผู้ใช้ใหม่ของวัน หรือมีการอ่าน/เปิดคลิป (ไม่ใช่ทุก request)"""
    day = datetime.now().strftime("%Y-%m-%d")
    if kind is None and (day, username) in _activity_seen:
        return
    try:
        with storage.state_lock:
            activity = storage.load_activity(fresh=True)
            entry = activity.setdefault(day, {"users": [], "reads": {}, "plays": {}})
            if username not in entry["users"]:
                entry["users"].append(username)
            if kind and item_id:
                bucket = entry.setdefault(kind, {})
                bucket[item_id] = bucket.get(item_id, 0) + 1
            for old in sorted(activity)[:-ACTIVITY_KEEP_DAYS]:
                del activity[old]
            storage.save_activity(activity)
        _activity_seen.add((day, username))
    except Exception as e:  # สถิติพังต้องไม่ทำให้หน้าเว็บพัง
        print(f"⚠️ บันทึกสถิติไม่สำเร็จ: {e}")


# ---------- คอมเมนต์ (มังงะรายตอน / วิดีโอรายคลิป) ----------
MAX_COMMENT_LENGTH = 1000


def _comment_target(args) -> tuple[str | None, str | None, str | None]:
    """อ่านเป้าหมายคอมเมนต์จาก query/body → (target, ป้ายบอกว่าคอมเมนต์อะไร, error)
    ตอนมังงะอ้างด้วยเลขตอน (_chapter_key) ไม่ใช่ URL — ลิงก์เปลี่ยน/สลับแหล่งแล้วคอมเมนต์ยังอยู่ที่ตอนเดิม"""
    kind = args.get("kind")
    if kind == "video":
        video = next((v for v in storage.load_videos() if v.get("id") == args.get("id")), None)
        if not video:
            return None, None, "ไม่พบวิดีโอ"
        return f"video:{video['id']}", f"🎬 {_clean_video_title(video['title'])}", None
    if kind == "chapter":
        manga = storage.get_manga(str(args.get("manga_id") or ""))
        url = args.get("url") or ""
        if not manga or not url:
            return None, None, "ไม่พบตอนนี้"
        chapter = next((c for c in manga.get("chapters") or [] if c["url"] == url or url in (c.get("alts") or [])), None)
        if not chapter:
            return None, None, "ไม่พบตอนนี้"
        return f"chapter:{manga['id']}:{_chapter_key(chapter['text'], url)}", f"📚 {manga['name']} · {chapter['text']}", None
    return None, None, "ประเภทคอมเมนต์ไม่ถูกต้อง"


def _public_comment(comment: dict) -> dict:
    username = current_username()
    can_delete = not storage.load_users() or is_admin() or comment["user"] == username
    return {**comment, "can_delete": can_delete}


@app.route("/api/comments", methods=["GET"])
def list_comments():
    target, _, error = _comment_target(request.args)
    if error:
        return jsonify({"error": error}), 404
    return jsonify({"items": [_public_comment(c) for c in storage.load_comments().get(target, [])]})


@app.route("/api/comments", methods=["POST"])
def add_comment():
    body = request.get_json(force=True, silent=True) or {}
    target, label, error = _comment_target(body)
    if error:
        return jsonify({"error": error}), 404
    text = str(body.get("text") or "").strip()
    if not text or len(text) > MAX_COMMENT_LENGTH:
        return jsonify({"error": f"ข้อความต้องมี 1-{MAX_COMMENT_LENGTH} ตัวอักษร"}), 400
    comment = {
        "id": secrets.token_hex(8),
        "user": current_username() or "local",
        "text": text,
        "created_at": now_iso(),
        "target": target,
        "label": label,
    }
    with storage.state_lock:
        comments = storage.load_comments(fresh=True)
        thread = list(comments.get(target, []))
        parent = next((c for c in thread if c["id"] == body.get("reply_to")), None)
        if parent:
            comment["reply_to"] = parent["id"]
        comments.setdefault(target, []).append(comment)
        storage.save_comments(comments)
    _notify_comment(comment, parent, thread, body)
    return jsonify(_public_comment(comment)), 201


@app.route("/api/comments/<comment_id>", methods=["DELETE"])
def delete_comment(comment_id):
    with storage.state_lock:
        comments = storage.load_comments(fresh=True)
        for target, items in comments.items():
            comment = next((c for c in items if c["id"] == comment_id), None)
            if not comment:
                continue
            if not _public_comment(comment)["can_delete"]:
                return jsonify({"error": "ลบได้เฉพาะคอมเมนต์ของตัวเอง"}), 403
            items.remove(comment)
            if not items:
                del comments[target]
            storage.save_comments(comments)
            return jsonify({"ok": True})
    return jsonify({"error": "ไม่พบคอมเมนต์"}), 404


# ---------- แจ้งเตือนในเว็บ (แผงกระดิ่ง) + push ----------
MAX_NOTIFICATIONS = 100
THREAD_NOTIFY_GAP = timedelta(minutes=10)
_MENTION_RE = re.compile(r"@([A-Za-z0-9][A-Za-z0-9_.-]{2,19})")


def _add_notification(username: str, item: dict) -> bool:
    """เพิ่มแจ้งเตือนให้ผู้ใช้ คืน False ถ้าถูกกันไว้
    - chapter: ตอนใหม่ของเรื่องเดิมแทนที่อันเก่าที่ยังไม่อ่าน (เหมือน tag ของ push) ไม่กองซ้อน
    - thread: คอมเมนต์ใหม่ในที่ที่เคยคุย แจ้งไม่เกิน 1 ครั้งต่อ 10 นาทีต่อที่ (ถ้ามีอันที่ยังไม่อ่านอยู่)"""
    now = datetime.now(timezone.utc)
    with storage.state_lock:
        items = storage.load_notifications(username, fresh=True)
        same = [n for n in items if n.get("target") == item.get("target") and not n.get("read")]
        # thread: มีแจ้งเตือนอะไรก็ตามของที่เดียวกันที่ยังไม่อ่านภายใน 10 นาที (รวม ตอบ/พูดถึง) = รู้อยู่แล้ว ไม่ต้องซ้ำ
        if item["type"] == "thread" and any(now - datetime.fromisoformat(n["created_at"]) < THREAD_NOTIFY_GAP for n in same):
            return False
        if item["type"] == "chapter":
            items = [n for n in items if not (n in same and n.get("type") == "chapter")]
        items.insert(0, {**item, "id": secrets.token_hex(6), "created_at": now.isoformat(), "read": False})
        storage.save_notifications(username, items[:MAX_NOTIFICATIONS])
    return True


def _comment_link(body: dict) -> str:
    if body.get("kind") == "video":
        return "/?" + urlencode({"comments": "video", "id": body.get("id", "")})
    return "/?" + urlencode({"comments": "chapter", "manga_id": body.get("manga_id", ""), "url": body.get("url", "")})


def _notify_comment(comment: dict, parent: dict | None, thread: list[dict], body: dict):
    """ใครได้แจ้งเตือนเมื่อมีคอมเมนต์ใหม่ (คนพิมพ์เองไม่ได้ / คนละหลายเงื่อนไขได้อันเดียว ลำดับความสำคัญตามนี้):
    1. reply   — เจ้าของคอมเมนต์ที่ถูกกด "ตอบ"
    2. mention — สมาชิกที่ถูก @ชื่อ (ต้องเป็นชื่อที่มีอยู่จริง)
    3. thread  — คนที่เคยคอมเมนต์ในตอน/คลิปเดียวกัน (กันรัวไม่เกิน 1 ครั้ง/10 นาที)"""
    users = storage.load_users()
    if not users:
        return  # dev mode ไม่มีบัญชี
    author = comment["user"]
    recipients: dict[str, str] = {}
    if parent and parent["user"] in users:
        recipients[parent["user"]] = "reply"
    for name in _MENTION_RE.findall(comment["text"]):
        if name in users:
            recipients.setdefault(name, "mention")
    for c in thread:
        if c["user"] in users:
            recipients.setdefault(c["user"], "thread")
    recipients.pop(author, None)
    snippet = comment["text"] if len(comment["text"]) <= 80 else comment["text"][:80] + "…"
    verbs = {"reply": "ตอบความคิดเห็นของคุณ", "mention": "พูดถึงคุณ", "thread": "แสดงความคิดเห็น"}
    url = _comment_link(body)
    for username, kind in recipients.items():
        text = f"{author} {verbs[kind]}ใน {comment['label']}: {snippet}"
        if _add_notification(username, {"type": kind, "target": comment["target"], "text": text, "url": url}):
            webpush.send_to_user(username, {"title": "MeeManga", "body": text, "tag": f"comment-{comment['target']}", "url": url})


@app.route("/api/notifications", methods=["GET"])
def list_notifications():
    username = current_username()
    if not username:
        return jsonify({"items": [], "unread": 0})
    items = storage.load_notifications(username)
    return jsonify({"items": items[:50], "unread": sum(1 for n in items if not n.get("read"))})


@app.route("/api/notifications/read", methods=["POST"])
def read_notifications():
    """{"ids": [...]} อ่านบางอัน / {"all": true} อ่านทั้งหมด"""
    username = current_username()
    if not username:
        return jsonify({"ok": True})
    body = request.get_json(force=True, silent=True) or {}
    ids = set(body.get("ids") or [])
    with storage.state_lock:
        items = storage.load_notifications(username, fresh=True)
        for n in items:
            if body.get("all") or n["id"] in ids:
                n["read"] = True
        storage.save_notifications(username, items)
    return jsonify({"ok": True, "unread": sum(1 for n in items if not n.get("read"))})


# ---------- หมวดคลิป + แก้คลิป (แอดมินเท่านั้น) ----------
@app.route("/api/video-categories", methods=["POST"])
@require_admin
def add_video_category():
    name = " ".join(str((request.get_json(force=True, silent=True) or {}).get("name") or "").split())
    if not name or len(name) > 40:
        return jsonify({"error": "ชื่อหมวดต้องมี 1-40 ตัวอักษร"}), 400
    with storage.state_lock:
        categories = storage.load_video_categories(fresh=True)
        if any(c["name"] == name for c in categories):
            return jsonify({"error": "มีหมวดนี้อยู่แล้ว"}), 400
        category = {"id": secrets.token_hex(4), "name": name}
        categories.append(category)
        storage.save_video_categories(categories)
    return jsonify(category), 201


@app.route("/api/video-categories/<category_id>", methods=["DELETE"])
@require_admin
def delete_video_category(category_id):
    with storage.state_lock:
        categories = storage.load_video_categories(fresh=True)
        storage.save_video_categories([c for c in categories if c["id"] != category_id])
        videos = storage.load_videos(fresh=True)
        changed = False
        for video in videos:
            if video.get("category_id") == category_id:
                video["category_id"] = None  # คลิปในหมวดที่ลบ กลับไปไม่มีหมวด
                changed = True
        if changed:
            storage.save_videos(videos)
        playlists = storage.load_video_playlists(fresh=True)
        if any(p.get("category_id") == category_id for p in playlists):
            for p in playlists:
                if p.get("category_id") == category_id:
                    p["category_id"] = None
            storage.save_video_playlists(playlists)
    return jsonify({"ok": True})


@app.route("/api/videos/<video_id>", methods=["PATCH"])
@require_admin
def update_video(video_id):
    body = request.get_json(force=True, silent=True) or {}
    with storage.state_lock:
        videos = storage.load_videos(fresh=True)
        video = next((v for v in videos if v.get("id") == video_id), None)
        if not video:
            return jsonify({"error": "ไม่พบวิดีโอ"}), 404
        if "title" in body:
            title = " ".join(str(body.get("title") or "").split())
            if not title or len(title) > MAX_VIDEO_TITLE:
                return jsonify({"error": f"ชื่อคลิปต้องมี 1-{MAX_VIDEO_TITLE} ตัวอักษร"}), 400
            video["title"] = title
        if "category_id" in body:
            category_id = body.get("category_id") or None
            if category_id and not any(c["id"] == category_id for c in storage.load_video_categories()):
                return jsonify({"error": "ไม่พบหมวดนี้"}), 400
            video["category_id"] = category_id
        storage.save_videos(videos)
    return jsonify(_public_video(video))


# ---------- playlist (เรื่องยาวหลายตอน นำเข้าทีละเรื่อง แอดมินเท่านั้น) ----------
MAX_PLAYLIST_NAME = 80
MAX_PLAYLIST_IMPORT = 10000
_playlist_thumb_lock = threading.Lock()


def _public_playlists(videos: list[dict]) -> list[dict]:
    episodes: dict[str, list[dict]] = {}
    for video in videos:
        if video.get("playlist_id"):
            episodes.setdefault(video["playlist_id"], []).append(video)
    result = []
    for playlist in storage.load_video_playlists():
        items = sorted(episodes.get(playlist["id"], []), key=lambda v: v.get("episode") or 0)
        if not items:
            continue
        cover = next((v.get("thumbnail_url") for v in items if v.get("thumbnail_url")), None)
        result.append({
            "id": playlist["id"],
            "name": playlist["name"],
            "category_id": playlist.get("category_id"),
            "count": len(items),
            "thumbnail_url": cover,
            "updated_at": max(v.get("created_at", "") for v in items),
        })
    return result


def _fetch_playlist_thumbs(todo: list[tuple[str, str]]):
    """ปกของตอนที่นำเข้า: ลิงก์ fbcdn หมดอายุในไม่กี่วัน จึงดาวน์โหลดเก็บทันทีเป็น thread แยก (ยิงเน็ตนอก lock)
    เขียน videos.json เป็นชุด ๆ ไม่เขียนทีละตอน"""
    with _playlist_thumb_lock:
        done: list[str] = []

        def flush():
            if not done:
                return
            with storage.state_lock:
                videos = storage.load_videos(fresh=True)
                ids = set(done)
                for video in videos:
                    if video.get("id") in ids and not video.get("thumbnail_url"):
                        video["thumbnail_url"] = f"/api/videos/{video['id']}/thumb"
                storage.save_videos(videos)
            done.clear()

        for video_id, image_url in todo:
            if storage.video_thumb_path(video_id).exists() or _fetch_video_thumb(video_id, image_url):
                done.append(video_id)
            if len(done) >= 50:
                flush()
            time.sleep(0.2)
        flush()


@app.route("/api/video-playlists/import", methods=["POST"])
@require_admin
def import_video_playlists():
    """body: {"playlists": [{"name", "items": [{"url", "title", "episode", "image"}]}]}
    เพิ่มตอนที่ยังไม่มี / ตอนที่มีอยู่แล้วย้ายเข้า playlist ให้ (นำเข้าซ้ำได้ เช่น ตอนใหม่ออก)
    ไม่ยิงเน็ตใน request — ลิงก์ /reel/ แปลงเป็น URL มาตรฐานได้เลย ปกโหลดตามหลัง"""
    body = request.get_json(force=True, silent=True) or {}
    category_name = " ".join(str(body.get("category") or "").split())
    if len(category_name) > 40:
        return jsonify({"error": "ชื่อหมวดต้องไม่เกิน 40 ตัวอักษร"}), 400
    groups = body.get("playlists")
    if not isinstance(groups, list) or not groups:
        return jsonify({"error": "ไม่พบรายการ playlist ในไฟล์"}), 400
    parsed: list[tuple[str, list[dict]]] = []
    total = 0
    for group in groups:
        name = " ".join(str((group or {}).get("name") or "").split())
        if not name or len(name) > MAX_PLAYLIST_NAME:
            return jsonify({"error": f"ชื่อ playlist ต้องมี 1-{MAX_PLAYLIST_NAME} ตัวอักษร"}), 400
        items = []
        for raw in group.get("items") or []:
            facebook_url, error = _canonical_facebook_video_url(str((raw or {}).get("url") or "").strip())
            if error:
                return jsonify({"error": f"{name}: {error}"}), 400
            try:
                episode = float(raw.get("episode"))
            except (TypeError, ValueError):
                return jsonify({"error": f"{name}: ตอนต้องเป็นตัวเลข"}), 400
            title = _clean_video_title(str(raw.get("title") or ""))[:MAX_VIDEO_TITLE] or f"{name} ตอนที่ {episode:g}"
            items.append({"url": facebook_url, "title": title, "episode": episode, "image": str(raw.get("image") or "")})
        total += len(items)
        parsed.append((name, items))
    if total > MAX_PLAYLIST_IMPORT:
        return jsonify({"error": f"นำเข้าได้ครั้งละไม่เกิน {MAX_PLAYLIST_IMPORT} ตอน"}), 400

    username = current_username() or "local"
    now = datetime.now(timezone.utc).isoformat()
    added = moved = 0
    thumbs: list[tuple[str, str]] = []
    with storage.state_lock:
        category_id = None
        if category_name:  # หมวดตามชื่อ (เช่น "ซีรีส์จีน") ไม่มีก็สร้างให้
            categories = storage.load_video_categories(fresh=True)
            category = next((c for c in categories if c["name"] == category_name), None)
            if not category:
                category = {"id": secrets.token_hex(4), "name": category_name}
                categories.append(category)
                storage.save_video_categories(categories)
            category_id = category["id"]
        playlists = storage.load_video_playlists(fresh=True)
        videos = storage.load_videos(fresh=True)
        by_key = {v.get("canonical_key"): v for v in videos}
        for name, items in parsed:
            playlist = next((p for p in playlists if p["name"] == name), None)
            if not playlist:
                playlist = {"id": secrets.token_hex(4), "name": name, "created_at": now}
                playlists.append(playlist)
            if category_id:
                playlist["category_id"] = category_id
            for item in items:
                key = hashlib.sha256(item["url"].encode("utf-8")).hexdigest()[:20]
                video = by_key.get(key)
                if video:
                    moved += video.get("playlist_id") != playlist["id"] or video.get("episode") != item["episode"]
                else:
                    video = {
                        "id": key, "canonical_key": key, "title": item["title"], "facebook_url": item["url"],
                        "thumbnail_url": None, "duration_seconds": None, "external": False,
                        "added_by": username, "created_at": now,
                    }
                    videos.append(video)
                    by_key[key] = video
                    added += 1
                video["playlist_id"] = playlist["id"]
                video["episode"] = item["episode"]
                if not video.get("thumbnail_url") and item["image"]:
                    thumbs.append((key, item["image"]))
        storage.save_video_playlists(playlists)
        storage.save_videos(videos)
    if thumbs:
        threading.Thread(target=_fetch_playlist_thumbs, args=(thumbs,), daemon=True).start()
    return jsonify({"ok": True, "added": added, "moved": moved, "thumbs_queued": len(thumbs)})


@app.route("/api/video-playlists/<playlist_id>", methods=["PATCH"])
@require_admin
def update_video_playlist(playlist_id):
    body = request.get_json(force=True, silent=True) or {}
    with storage.state_lock:
        playlists = storage.load_video_playlists(fresh=True)
        playlist = next((p for p in playlists if p["id"] == playlist_id), None)
        if not playlist:
            return jsonify({"error": "ไม่พบ playlist"}), 404
        if "name" in body:
            name = " ".join(str(body.get("name") or "").split())
            if not name or len(name) > MAX_PLAYLIST_NAME:
                return jsonify({"error": f"ชื่อ playlist ต้องมี 1-{MAX_PLAYLIST_NAME} ตัวอักษร"}), 400
            playlist["name"] = name
        if "category_id" in body:
            category_id = body.get("category_id") or None
            if category_id and not any(c["id"] == category_id for c in storage.load_video_categories()):
                return jsonify({"error": "ไม่พบหมวดนี้"}), 400
            playlist["category_id"] = category_id
        storage.save_video_playlists(playlists)
    return jsonify({"ok": True})


@app.route("/api/video-playlists/<playlist_id>", methods=["DELETE"])
@require_admin
def delete_video_playlist(playlist_id):
    """ลบ playlist พร้อมทุกตอนในนั้น (ตอนนำเข้ามาเป็นชุด ปล่อยค้างไว้จะท่วมหน้าหลัก)"""
    with storage.state_lock:
        playlists = storage.load_video_playlists(fresh=True)
        if not any(p["id"] == playlist_id for p in playlists):
            return jsonify({"error": "ไม่พบ playlist"}), 404
        storage.save_video_playlists([p for p in playlists if p["id"] != playlist_id])
        videos = storage.load_videos(fresh=True)
        gone = {v["id"] for v in videos if v.get("playlist_id") == playlist_id}
        storage.save_videos([v for v in videos if v["id"] not in gone])
        for u in [*storage.all_usernames(), "local"]:
            for load, save in ((storage.load_video_progress, storage.save_video_progress),
                               (storage.load_video_saved, storage.save_video_saved)):
                data = load(u, fresh=True)
                if gone & data.keys():
                    save(u, {k: v for k, v in data.items() if k not in gone})
        comments = storage.load_comments(fresh=True)
        removed = [comments.pop(f"video:{vid}") for vid in gone if f"video:{vid}" in comments]
        if removed:
            storage.save_comments(comments)
    for vid in gone:
        storage.video_thumb_path(vid).unlink(missing_ok=True)
    return jsonify({"ok": True, "deleted": len(gone)})


# ---------- หน้าแอดมิน: สถานะระบบ / สถิติ / จัดการเนื้อหา ----------
_LOG_ERROR_RE = re.compile(r"ERROR|Traceback|⚠️|Exception")
_dir_size_cache: dict[str, tuple[float, int, int]] = {}


def _dir_size(path: Path) -> tuple[int, int]:
    """(ไบต์, จำนวนไฟล์) ของโฟลเดอร์แคช — เดินทั้งโฟลเดอร์ช้า จำผลไว้ 10 นาที"""
    cached = _dir_size_cache.get(str(path))
    if cached and cached[0] > time.time():
        return cached[1], cached[2]
    total = count = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
                count += 1
            except OSError:
                pass
    _dir_size_cache[str(path)] = (time.time() + 600, total, count)
    return total, count


def _tail_lines(path: Path, max_bytes: int = 300_000) -> list[str]:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - max_bytes))
            return f.read().decode("utf-8", "replace").splitlines()[1:]
    except OSError:
        return []


@app.route("/api/admin/status", methods=["GET"])
@require_admin
def admin_status():
    """สุขภาพเซิร์ฟเวอร์ + สถานะเว็บต้นทาง + error ล่าสุดจาก log (อ่านไฟล์ในเครื่องอย่างเดียว ไม่ยิงเน็ต)"""
    disk = shutil.disk_usage(storage.DATA_DIR)
    caches = {}
    for name, path in (("chapters", storage.CHAPTERS_DIR), ("covers", storage.COVERS_DIR), ("video_thumbs", storage.VIDEO_THUMBS_DIR)):
        size, files = _dir_size(path)
        caches[name] = {"bytes": size, "files": files}

    hosts: dict[str, dict] = {}
    for manga in storage.load_manga():
        urls = [manga.get("url")] + [s.get("url") for s in manga.get("sources") or []]
        for url in dict.fromkeys(u for u in urls if u):
            host = urlparse(url).netloc.lower()
            info = hosts.setdefault(host, {"host": host, "manga": 0, "last_checked_at": None, "down": False, "stalled": False})
            info["manga"] += 1
            checked = manga.get("last_checked_at")
            if checked and (not info["last_checked_at"] or checked > info["last_checked_at"]):
                info["last_checked_at"] = checked
            info["down"] = info["down"] or scraper.host_is_down(url)
            info["stalled"] = info["stalled"] or scraper.host_is_stalled(url)

    log_dir = storage.DATA_DIR / "logs"
    errors = [line for line in _tail_lines(log_dir / "webapp.log") if _LOG_ERROR_RE.search(line)][-30:]
    restarts = [line for line in _tail_lines(log_dir / "supervisor.log", 100_000) if line.strip()][-8:]
    return jsonify({
        "started_at": datetime.fromtimestamp(_SERVER_STARTED, timezone.utc).isoformat(),
        "uptime_seconds": int(time.time() - _SERVER_STARTED),
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "caches": caches,
        "counts": {"manga": len(storage.load_manga()), "videos": len(storage.load_videos()),
                   "users": len(storage.load_users()), "comments": sum(len(v) for v in storage.load_comments().values())},
        "hosts": sorted(hosts.values(), key=lambda h: (not h["down"], not h["stalled"], h["host"])),
        "errors": errors,
        "supervisor": restarts,
        "has_logs": (log_dir / "webapp.log").exists(),
    })


@app.route("/api/admin/stats", methods=["GET"])
@require_admin
def admin_stats():
    activity = storage.load_activity()
    days = [(datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    today = activity.get(days[0], {})
    week_users, reads, plays = set(), {}, {}
    for day in days:
        entry = activity.get(day, {})
        week_users.update(entry.get("users", []))
        for key, bucket in (("reads", reads), ("plays", plays)):
            for item_id, n in entry.get(key, {}).items():
                bucket[item_id] = bucket.get(item_id, 0) + n
    manga_names = {m["id"]: m["name"] for m in storage.load_manga()}
    video_titles = {v["id"]: _clean_video_title(v["title"]) for v in storage.load_videos()}
    top = lambda bucket, names: [{"name": names.get(k, "(ถูกลบแล้ว)"), "count": n}
                                 for k, n in sorted(bucket.items(), key=lambda kv: -kv[1])[:5]]
    return jsonify({
        "today_users": len(today.get("users", [])),
        "today_reads": sum(today.get("reads", {}).values()),
        "today_plays": sum(today.get("plays", {}).values()),
        "week_users": len(week_users),
        "week_reads": sum(reads.values()),
        "week_plays": sum(plays.values()),
        "daily": [{"day": d, "users": len(activity.get(d, {}).get("users", [])),
                   "reads": sum(activity.get(d, {}).get("reads", {}).values()),
                   "plays": sum(activity.get(d, {}).get("plays", {}).values())} for d in reversed(days)],
        "top_manga": top(reads, manga_names),
        "top_videos": top(plays, video_titles),
    })


@app.route("/api/admin/comments", methods=["GET"])
@require_admin
def admin_comments():
    items = [c for items in storage.load_comments().values() for c in items]
    items.sort(key=lambda c: c["created_at"], reverse=True)
    return jsonify({"items": [_public_comment(c) for c in items[:100]]})


@app.route("/api/admin/videos/check", methods=["POST"])
@require_admin
def admin_check_videos():
    """ไล่หาไฟล์ตรงของทุกคลิปที่เล่นในเว็บ — คืนรายการที่หาไม่ได้ (จะกลับไปใช้ตัวเล่น Facebook)
    ยิงเน็ตนอก lock, ข้ามแคชเพื่อดูสถานะจริงตอนนี้"""
    videos = [v for v in storage.load_videos() if not v.get("external")]
    for video in videos:
        _video_sources_cache.pop(video["facebook_url"], None)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda v: (v, bool(_facebook_video_sources(v["facebook_url"]))), videos))
    return jsonify({"checked": len(videos), "failed": [{"id": v["id"], "title": _clean_video_title(v["title"])} for v, ok in results if not ok]})


# ---------- หมวดหมู่ (admin จัดการ, ทุกคนใช้กรองในหน้าเรื่องทั้งหมด) ----------
# ทุก endpoint ไม่แตะเน็ต แก้แค่ไฟล์ — โหลดแบบ fresh ก่อนแก้เสมอ (ของจากแคชแชร์กันทั้ง process)

def _category_name(body: dict) -> tuple[str | None, str | None]:
    name = " ".join(str(body.get("name") or "").split())
    if not name:
        return None, "ต้องระบุชื่อหมวดหมู่"
    if len(name) > 40:
        return None, "ชื่อหมวดหมู่ยาวเกิน 40 ตัวอักษร"
    return name, None


def _name_taken(categories: list[dict], name: str, except_id: str | None = None) -> bool:
    return any(c["name"].casefold() == name.casefold() and c["id"] != except_id for c in categories)


@app.route("/api/categories", methods=["GET"])
def list_categories():
    return jsonify(storage.load_categories())


@app.route("/api/categories", methods=["POST"])
@require_admin
def add_category():
    body = request.get_json(force=True, silent=True) or {}
    name, error = _category_name(body)
    if error:
        return jsonify({"error": error}), 400
    categories = storage.load_categories(fresh=True)
    if _name_taken(categories, name):
        return jsonify({"error": "มีหมวดหมู่นี้อยู่แล้ว"}), 409
    # special = หมวดพิเศษ: ผู้ใช้จะเห็นก็ต่อเมื่อเปิด "แสดงหมวดพิเศษ" ในหน้าตั้งค่าของตัวเอง
    category = {"id": secrets.token_hex(4), "name": name, "special": bool(body.get("special"))}
    categories.append(category)
    storage.save_categories(categories)
    return jsonify(category), 201


@app.route("/api/categories/<category_id>", methods=["PUT"])
@require_admin
def update_category(category_id):
    """แก้ชื่อ และ/หรือ ตั้งเป็นหมวดพิเศษ (ส่งมาเฉพาะค่าที่จะเปลี่ยน)"""
    body = request.get_json(force=True, silent=True) or {}
    categories = storage.load_categories(fresh=True)
    category = next((c for c in categories if c["id"] == category_id), None)
    if not category:
        return jsonify({"error": "ไม่พบหมวดหมู่นี้"}), 404
    if "name" in body:
        name, error = _category_name(body)
        if error:
            return jsonify({"error": error}), 400
        if _name_taken(categories, name, except_id=category_id):
            return jsonify({"error": "มีหมวดหมู่นี้อยู่แล้ว"}), 409
        category["name"] = name
    if "special" in body:
        category["special"] = bool(body["special"])
    storage.save_categories(categories)
    return jsonify(category)


@app.route("/api/categories/<category_id>", methods=["DELETE"])
@require_admin
def delete_category(category_id):
    categories = storage.load_categories(fresh=True)
    remaining = [c for c in categories if c["id"] != category_id]
    if len(remaining) == len(categories):
        return jsonify({"error": "ไม่พบหมวดหมู่นี้"}), 404
    storage.save_categories(remaining)
    # เอาออกจากทุกเรื่องด้วย กันมี id หมวดที่ไม่มีอยู่จริงค้างใน manga.json
    manga_items = storage.load_manga(fresh=True)
    changed = False
    for m in manga_items:
        if category_id in (m.get("categories") or []):
            m["categories"] = [c for c in m["categories"] if c != category_id]
            changed = True
    if changed:
        storage.save_manga(manga_items)
    return jsonify({"ok": True})


@app.route("/api/categories/order", methods=["PUT"])
@require_admin
def reorder_categories():
    ids = (request.get_json(force=True, silent=True) or {}).get("ids")
    categories = storage.load_categories(fresh=True)
    by_id = {c["id"]: c for c in categories}
    if not isinstance(ids, list) or sorted(ids) != sorted(by_id):
        return jsonify({"error": "ลำดับไม่ครบหรือมีหมวดหมู่ที่ไม่รู้จัก ลองโหลดหน้าใหม่"}), 400
    storage.save_categories([by_id[i] for i in ids])
    return jsonify({"ok": True})


@app.route("/api/categories/<category_id>/manga", methods=["PUT"])
@require_admin
def set_category_manga(category_id):
    """กำหนดว่าหมวดนี้มีเรื่องอะไรบ้าง (ส่งรายการ id เรื่องทั้งหมดของหมวดนี้มา)"""
    manga_ids = (request.get_json(force=True, silent=True) or {}).get("manga_ids")
    if not isinstance(manga_ids, list):
        return jsonify({"error": "ข้อมูลไม่ถูกต้อง"}), 400
    if not any(c["id"] == category_id for c in storage.load_categories()):
        return jsonify({"error": "ไม่พบหมวดหมู่นี้"}), 404
    wanted = set(manga_ids)
    manga_items = storage.load_manga(fresh=True)
    for m in manga_items:
        cats = [c for c in (m.get("categories") or []) if c != category_id]
        if m["id"] in wanted:
            cats.append(category_id)
        m["categories"] = cats
    storage.save_manga(manga_items)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/categories", methods=["PUT"])
@require_admin
def set_manga_categories(manga_id):
    """กำหนดหมวดหมู่ของเรื่องเดียว (จากหน้าแก้ไขเรื่อง) — แยกจากการแก้ชื่อ/แหล่งที่มา เพราะอันนั้นต้องดึง
    ข้อมูลจากเว็บใหม่ทุกครั้ง ช้าหลายวินาที ส่วนเปลี่ยนแค่หมวดหมู่ไม่จำเป็น"""
    ids = (request.get_json(force=True, silent=True) or {}).get("category_ids")
    if not isinstance(ids, list):
        return jsonify({"error": "ข้อมูลไม่ถูกต้อง"}), 400
    known = {c["id"] for c in storage.load_categories()}
    manga_items = storage.load_manga(fresh=True)
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    manga["categories"] = [i for i in dict.fromkeys(ids) if i in known]
    storage.save_manga(manga_items)
    return jsonify({"categories": manga["categories"]})


@app.route("/api/catalog/<manga_id>/subscribe", methods=["POST"])
def subscribe(manga_id):
    username = current_username()
    if not username:
        return jsonify({"error": "unauthorized"}), 401
    if not storage.get_manga(manga_id):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    with storage.state_lock:
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
    with storage.state_lock:
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
    parsed = refresh_from_sources(new_item["sources"], manga_id=mid)
    if parsed:
        parsed.pop("_partial", None)
        parsed.pop("_dropped_keys", None)
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
    parsed = refresh_from_sources(sources, manga_id=manga_id)

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
    with storage.state_lock:
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
        if _is_new_chapter(prev_chapter, parsed.get("latest_chapter")):
            changed.append((manga, prev_chapter))
    storage.save_manga(manga_items)

    for manga, prev_chapter in changed:
        # แจ้งเตือนเฉพาะตอนที่เคยรู้ตอนล่าสุดมาก่อนแล้วเปลี่ยน (ไม่แจ้งตอนเพิ่งเพิ่มเรื่องใหม่)
        if prev_chapter:
            notify_subscribed_admins(manga["id"], manga["name"], manga["latest_chapter"], manga.get("cover_url"))
            webpush.notify_new_chapter(manga["id"], manga["name"], manga["latest_chapter"])
            for username in storage.all_usernames():
                if manga["id"] in storage.load_subscriptions(username):
                    _add_notification(username, {
                        "type": "chapter", "target": f"manga:{manga['id']}",
                        "text": f"{manga['name']} {manga['latest_chapter']} มาแล้ว", "url": f"/?manga={manga['id']}",
                    })
    return [manga["id"] for manga, _ in changed]


@app.route("/api/manga/<manga_id>/refresh", methods=["POST"])
@require_admin
def refresh_manga(manga_id):
    manga = storage.get_manga(manga_id)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    parsed = refresh_from_sources(_sources_of(manga), manga_id=manga_id)
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
            return manga, refresh_from_sources(_sources_of(manga), min_interval=REQUEST_DELAY, manga_id=manga["id"])
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


FAST_FAIL_TIMEOUT = 8  # ยังมีแหล่งสำรองให้ลองต่อ ไม่ต้องรอเว็บที่ล่มจนครบ 20 วิ

# บางเว็บลง "ตอนใหม่" ไว้เรียกยอดเข้าชมทั้งที่ยังไม่มีตอนจริง (หน้าตอนมีแค่แบนเนอร์ของเว็บ 1-2 รูป) —
# หน้าตอนที่มีรูปน้อยกว่านี้ถือเป็นตอนหลอก ตอนจริงของเว็บกลุ่มนี้มีตั้งแต่ราว 10 รูปขึ้นไป
MIN_REAL_IMAGES = 3
MAX_PLACEHOLDER_CHECKS = 5  # ตรวจจากตอนล่าสุดลงมาไม่เกินกี่ตอนต่อรอบ (กันยิงหน้าตอนเยอะเกิน)


def _has_real_images(data: dict) -> bool:
    return sum(1 for src in data.get("images") or [] if not src.startswith("data:")) >= MIN_REAL_IMAGES


def _referer_for(url: str) -> str:
    # ใช้โดเมนจากลิงก์ตอนเอง แทน manga["url"] ตรง ๆ เพราะบางเว็บผู้ใช้กรอกโดเมนภาษาไทย/unicode ไว้ —
    # แต่ต้อง normalize เป็น punycode ก่อนเสมอ เพราะใส่เป็นค่า header (Referer) แบบ unicode ตรง ๆ
    # ไม่ได้ — HTTP header ต้อง encode เป็น latin-1 ได้เท่านั้น
    return f"{urlparse(url).scheme}://{_normalize_host(urlparse(url).netloc)}/"


def _drop_placeholder_chapters(manga_id: str | None, chapters: list[dict], min_interval: float) -> list[dict]:
    """ตรวจตอนบนสุดของรายชื่อ (เรียงใหม่ -> เก่า) ทีละตอนจนเจอตอนจริงตอนแรก ตอนหลอกที่เจอระหว่างทาง
    ตัดออกจากลิสต์ (แก้ list ที่ส่งมาเลย) คืนรายการตอนที่ตัดทิ้ง — ตอนที่ถูกตัดไม่ขึ้นเป็นตอนใหม่ ไม่แจ้ง
    เตือน และจะถูกตรวจซ้ำทุกรอบรีเฟรช พอเว็บอัปโหลดรูปจริงเมื่อไหร่ก็ผ่านและขึ้นเป็นตอนใหม่ตามปกติ

    ตอนที่ผ่านแล้วถูกเก็บลงแคช รอบถัดไปไม่ต้องยิงเน็ตซ้ำ (และผู้ใช้กดอ่านได้ทันทีด้วย)

    ตอนที่ตรวจไม่ได้ (เว็บล่ม/timeout/ค้าง): ถ้าเป็นตอนที่รู้จักอยู่แล้วปล่อยไว้ตามเดิม แต่ถ้าเป็นตอนใหม่
    (เลขเกินตอนล่าสุดที่บันทึกไว้) ต้องรอยืนยันก่อน — เคยประกาศตอนหลอกไปทั้งที่แค่ตรวจไม่ทัน: แจ้งเตือน
    ออกไปแล้ว รอบถัดไปตรวจได้ว่าหลอก ตอนล่าสุดถอยกลับ ป้าย NEW หาย (Magic Emperor 916 ของ manga-lc)"""
    dropped = []
    known = storage.get_manga(manga_id) if manga_id else None
    known_latest = _chapter_key(known.get("latest_chapter")) if known else None
    for chapter in list(chapters[:MAX_PLACEHOLDER_CHECKS]):
        verdict, real_url = _verify_chapter(manga_id, chapter, min_interval)
        is_unconfirmed_new = (
            verdict == "unknown"
            and isinstance(known_latest, float)
            and isinstance(_chapter_key(chapter["text"]), float)
            and _chapter_key(chapter["text"]) > known_latest
        )
        if verdict == "placeholder" or is_unconfirmed_new:
            reason = "หน้าตอนยังไม่มีภาพมังงะจริง (น่าจะเป็นตอนที่ลงไว้เรียกยอด)" if verdict == "placeholder" \
                else "ตอนใหม่แต่เปิดหน้าตอนไม่สำเร็จ รอยืนยันรอบหน้า"
            print(f"⚠️ ข้าม {chapter['text']} — {reason}")
            chapters.remove(chapter)
            dropped.append(chapter)
            continue
        if verdict == "real" and real_url != chapter["url"]:
            # แหล่งหลักเป็นตอนหลอก แต่แหล่งสำรองมีตอนจริง ใช้แหล่งสำรองเป็นลิงก์หลักแทน
            others = [u for u in [chapter["url"], *(chapter.get("alts") or [])] if u != real_url]
            chapter["url"], chapter["alts"] = real_url, others
        break
    return dropped


def _verify_chapter(manga_id: str | None, chapter: dict, min_interval: float) -> tuple[str, str | None]:
    """คืน ("real", ลิงก์ที่มีภาพจริง) / ("placeholder", None) / ("unknown", None) เมื่อตรวจไม่ได้"""
    urls = [chapter["url"], *(chapter.get("alts") or [])]
    if manga_id:
        for url in urls:
            cached = storage.load_chapter_cache(manga_id, url)
            if cached and _has_real_images(cached):
                return "real", url

    saw_placeholder = False
    for url in urls:
        if scraper.host_is_down(url):
            continue
        try:
            html = scraper.fetch(url, referer=_referer_for(url), min_interval=min_interval, timeout=FAST_FAIL_TIMEOUT)
            data = scraper.parse_chapter_page(html, url)
        except Exception:
            continue
        if _has_real_images(data):
            if manga_id:
                storage.save_chapter_cache(manga_id, url, data)
                storage.add_image_domains({urlparse(src).netloc for src in data["images"]})
            return "real", url
        saw_placeholder = True
    return ("placeholder" if saw_placeholder else "unknown"), None


def _load_chapter_from_any(manga_id: str, candidates: list[str]) -> tuple[dict | None, str | None, list[str]]:
    """ลองดึงหน้าตอนจากลิงก์ทีละแหล่งจนกว่าจะได้ คืน (data, ลิงก์ที่ใช้ได้, error ของแหล่งที่พลาด)

    รอบแรกใช้เฉพาะแหล่งที่ยังดีอยู่ (ทั้งตัวเว็บและเซิร์ฟเวอร์รูปของมัน) — เช็คแคชก่อนแล้วค่อยออกเน็ต
    รอบสองค่อยยอมใช้ของเว็บที่เพิ่งล่มเผื่อไม่มีทางเลือกอื่นแล้ว: แคชเก่าของเว็บที่ล่มมักชี้ไปที่รูปบน
    เซิร์ฟเวอร์ที่ล่มตามไปด้วย ถ้าหยิบมาใช้ก่อนจะได้หน้าที่รูปขึ้นไม่ครบ ทั้งที่แหล่งอื่นอ่านได้ปกติ"""
    healthy = [u for u in candidates if not scraper.host_is_down(u)]
    down = [u for u in candidates if scraper.host_is_down(u)]
    network_order = healthy + down
    errors = []

    for url in healthy:
        cached = storage.load_chapter_cache(manga_id, url)
        if cached and _has_real_images(cached) and _images_healthy(cached):
            return cached, url, errors
    for url in healthy:
        data, error = _fetch_chapter(manga_id, url, is_last=url == network_order[-1])
        if data and _images_healthy(data):
            return data, url, errors
        if error:
            errors.append(error)

    for url in candidates:
        cached = storage.load_chapter_cache(manga_id, url)
        if cached and _has_real_images(cached):
            return cached, url, errors
    for url in down:
        data, error = _fetch_chapter(manga_id, url, is_last=url == network_order[-1])
        if data:
            return data, url, errors
        errors.append(error)
    return None, None, errors


def _images_healthy(data: dict) -> bool:
    images = data.get("images") or []
    return not (images and scraper.host_is_down(images[0]))


def _fetch_chapter(manga_id: str, url: str, is_last: bool) -> tuple[dict | None, str | None]:
    """ดึงหน้าตอนจากลิงก์เดียว คืน (data, error) และเก็บแคชไว้ถ้าได้รูปมา"""
    try:
        timeout = scraper.TIMEOUT if is_last else FAST_FAIL_TIMEOUT
        data = scraper.parse_chapter_page(scraper.fetch(url, referer=_referer_for(url), timeout=timeout), url)
    except Exception as e:
        return None, f"{urlparse(url).netloc}: {e}"
    if not _has_real_images(data):
        # ห้ามเก็บลงแคช: พอเว็บอัปโหลดรูปจริงทีหลัง จะได้ดึงของใหม่ ไม่ค้างหน้าว่างไว้ตลอด
        return None, (
            f"{urlparse(url).netloc}: ตอนนี้ยังไม่มีภาพมังงะ (เว็บต้นทางลงตอนไว้ก่อนแต่ยังไม่อัปโหลดรูปจริง)"
        )
    storage.save_chapter_cache(manga_id, url, data)
    storage.add_image_domains({urlparse(src).netloc for src in data["images"]})
    return data, None


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

    chapters = manga.get("chapters") or []
    # หาตอนนี้ในรายชื่อตอน ทั้งจากลิงก์หลักและลิงก์สำรอง (ผู้ใช้อาจมาจากลิงก์ของแหล่งสำรองก็ได้)
    idx = next(
        (i for i, c in enumerate(chapters) if c["url"] == chapter_url or chapter_url in (c.get("alts") or [])),
        None,
    )
    entry = chapters[idx] if idx is not None else {}

    # ตอนเดียวกันจากทุกแหล่งที่รู้จัก เรียงลิงก์ที่ขอมาก่อน แต่เว็บที่เพิ่งล่มไปไว้ท้ายสุด
    candidates = []
    for url in [chapter_url, entry.get("url"), *(entry.get("alts") or [])]:
        if url and url not in candidates:
            candidates.append(url)
    candidates.sort(key=scraper.host_is_down)

    data, served_from, errors = _load_chapter_from_any(manga_id, candidates)
    if data is None:
        return jsonify({"error": "ดึงหน้าตอนไม่สำเร็จจากทุกแหล่งที่มา: " + " | ".join(errors)}), 502
    if served_from != chapter_url:
        # ได้มาจากแหล่งสำรอง เก็บแคชไว้ใต้ลิงก์ที่ขอด้วย รอบหน้าเปิดตอนนี้จะได้ขึ้นทันทีไม่ต้องลองเว็บที่ล่มซ้ำ
        storage.save_chapter_cache(manga_id, chapter_url, data)

    # เว็บกลุ่ม Madara ไม่มีลิงก์ตอนก่อนหน้า/ถัดไปในหน้าอ่าน หาเอาจากลำดับในรายชื่อตอนแทน
    # (ลิสต์เรียงใหม่->เก่า ตอนถัดไปจึงอยู่ก่อนหน้าในลิสต์) — ถ้าได้มาจากแหล่งสำรองก็ใช้ลำดับในลิสต์
    # เหมือนกัน เพราะลิงก์ก่อนหน้า/ถัดไปในหน้านั้นเป็นของเว็บสำรอง ไม่ตรงกับลิงก์ในรายชื่อตอนของเรา
    # ใช้ลำดับจากรายชื่อตอนของเราเสมอเมื่อหาตอนนี้เจอ ไม่ใช่แค่ตอนที่หน้าเว็บไม่มีลิงก์ให้ เพราะหน้าเว็บรู้จัก
    # แค่ตอนของเว็บตัวเอง: ตอนล่าสุดของเว็บแรก (เช่น tanuki ตอน 112) บอกว่าไม่มีตอนถัดไป ทั้งที่แหล่งอื่นมี 113
    # ขึ้นไปแล้ว — รายชื่อของเรารวมทุกแหล่งและตัดตอนหลอกออกแล้ว จึงเป็นลำดับที่ถูกต้องกว่า
    if idx is not None:
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
        with storage.state_lock:
            read_state = storage.load_read_state(current_username(), fresh=True)
            mark_chapter_read(read_state, manga_id, key)
            storage.save_read_state(current_username(), read_state)
        _record_activity(current_username(), "reads", manga_id)

    data["chapter_url"] = chapter_url
    data["manga_name"] = manga["name"]
    return jsonify(data)


@app.route("/api/history", methods=["GET"])
def reading_history():
    """รายการอ่านล่าสุด: ทุกเรื่องที่เคยเปิดอ่าน (ไม่จำกัดเฉพาะที่ติดตาม) เรียงจากอ่านล่าสุดก่อน พร้อมตอนที่อ่าน
    ล่าสุดของแต่ละเรื่อง และตำแหน่งที่อ่านค้างไว้ (ถ้ายังอ่านตอนนั้นไม่จบ) ให้ปุ่ม "อ่านต่อ" เปิดไปจุดเดิม"""
    username = current_username()
    if not username:
        return jsonify({"items": []})
    read_state = storage.load_read_state(username)
    items = []
    for manga_id, entry in read_state.items():
        manga = storage.get_manga(manga_id)
        read_keys = (entry or {}).get("read_keys") or []
        if not manga or not read_keys:
            continue
        last_key = read_keys[-1]
        chapter = next((c for c in manga.get("chapters") or [] if _chapter_key(c["text"]) == last_key), None)
        if not chapter:
            # ตอนที่อ่านไม่อยู่ในรายชื่อแล้ว (เช่นเว็บลบ/เปลี่ยนลิงก์) ยังแสดงเรื่องได้ แต่อ่านต่อจากลิงก์เดิมไม่ได้
            text = f"ตอนที่ {last_key:g}" if isinstance(last_key, float) else None
            chapter = {"text": text, "url": None}
        scroll = entry.get("last_scroll") or {}
        items.append({
            "id": manga_id,
            "name": manga["name"],
            "cover_url": manga.get("cover_url"),
            "categories": manga.get("categories") or [],  # หน้าเว็บใช้ซ่อนเรื่องในหมวดพิเศษตามที่ผู้ใช้ตั้งค่า
            "latest_chapter": manga.get("latest_chapter"),
            "latest_chapter_url": manga.get("latest_chapter_url"),
            "chapter_text": chapter["text"],
            "chapter_url": chapter["url"],
            # ตำแหน่งค้างใช้ได้เฉพาะเมื่อเป็นตอนเดียวกับที่อ่านล่าสุด (ตอนอื่นเปิดจากบนสุดตามปกติ)
            "fraction": scroll.get("fraction") if scroll.get("key") == last_key else None,
            "last_read_at": entry.get("last_read_at"),
            "is_new": is_new(manga, read_state),
        })
    items.sort(key=lambda i: i["last_read_at"] or "", reverse=True)
    return jsonify({"items": items})


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

    with storage.state_lock:
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

    with storage.state_lock:
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

    with storage.state_lock:
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
# (เชื่อมต่อ, รอข้อมูล) วินาที — เชื่อมต่อไม่ได้ใน 5 วิแปลว่าเว็บล่ม ไม่ต้องรอนาน ส่วนรอข้อมูล 10 วิเผื่อ
# CDN ที่ช้าจริง ๆ แต่ไม่รอครบ 20 วิแบบ Cloudflare 522 (ซึ่งจะถูกจำว่าล่มหลังครั้งแรกอยู่แล้ว)
IMAGE_TIMEOUT = (5, 10)
IMAGE_STREAM_MAX_SECONDS = 60
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

    # เซิร์ฟเวอร์รูปที่เพิ่งล่มไป ตอบกลับทันที ไม่ยิงไปรอซ้ำ — ต้นเหตุหลักของอาการเว็บค้างจอขาว:
    # เว็บที่ล่มแบบ Cloudflare 522 ค้างรอเกือบ 20 วิก่อนตอบ ทุกรูป/ปกที่ชี้ไปเว็บนั้นจะยึด thread ของ
    # เซิร์ฟเวอร์ไว้ทีละตัวจนครบทุกตัว แล้วคำขออื่นทั้งหมด (รวมถึงหน้าเว็บเอง) ต้องต่อคิวรอ
    if scraper.host_is_down(src) or scraper.host_is_stalled(src):
        return "source host is down", 502

    try:
        with scraper.awaiting_response(src):
            resp = scraper.session().get(
                src,
                headers={
                    "User-Agent": scraper.HEADERS["User-Agent"],
                    "Referer": f"https://{netloc}/",
                },
                timeout=IMAGE_TIMEOUT,
                stream=not width,
            )
        resp.raise_for_status()
    except Exception as e:
        # จำไว้ว่าเซิร์ฟเวอร์รูปนี้ล่ม หน้าอ่านจะได้ขอรายการรูปใหม่จากแหล่งสำรองแทน (ดู get_chapter)
        if scraper.is_outage(e):
            scraper.mark_host_down(src)
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
        # ส่งต่อทีละก้อน ไม่อ่านทั้งรูปเข้าหน่วยความจำก่อน — มีเพดานเวลารวมด้วย เพราะ timeout ของ
        # requests นับแค่ช่วงรอระหว่างก้อน เว็บที่ส่งมาช้า ๆ ทีละนิดจะยึด thread ไว้ได้ไม่จำกัด
        deadline = time.monotonic() + IMAGE_STREAM_MAX_SECONDS
        try:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                yield chunk
                if time.monotonic() > deadline:
                    print(f"⚠️ ตัดการส่งรูปที่ช้าเกิน {IMAGE_STREAM_MAX_SECONDS} วิ: {src}")
                    break
        finally:
            resp.close()

    return Response(stream(), content_type=content_type, headers=headers, direct_passthrough=True)


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG") == "1"
    port = int(os.environ.get("PORT", "5050"))
    # host default เป็น 127.0.0.1 (ปลอดภัยกว่า); บน VPS ให้รันผ่าน gunicorn
    # แล้ววางหลัง nginx (ดู README) แทนที่จะรัน dev server ตรง ๆ
    app.run(debug=debug, host=os.environ.get("HOST", "127.0.0.1"), port=port)
