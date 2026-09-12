import hmac
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, Response, session, url_for

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


@app.before_request
def require_login():
    # ถ้าไม่ได้ตั้ง WEB_USERNAME/WEB_PASSWORD ไว้ใน .env (เช่นตอน dev บนเครื่อง) ปล่อยผ่านไม่บังคับ login
    if not WEB_USERNAME or not WEB_PASSWORD:
        return None
    if request.endpoint in ("login", "static"):
        return None
    if (
        request.endpoint == "refresh_all"
        and CRON_TOKEN
        and hmac.compare_digest(request.headers.get("X-Cron-Token", ""), CRON_TOKEN)
    ):
        return None
    if session.get("authenticated"):
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
        ok = hmac.compare_digest(username, WEB_USERNAME or "") and hmac.compare_digest(
            password, WEB_PASSWORD or ""
        )
        if ok:
            session.permanent = True
            session["authenticated"] = True
            return redirect(request.args.get("next") or url_for("index"))
        error = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


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
    entry.setdefault("read_urls", [])
    if chapter_url not in entry["read_urls"]:
        entry["read_urls"].append(chapter_url)
    entry["last_read_at"] = now_iso()


def serialize(manga: dict, read_state: dict) -> dict:
    out = dict(manga)
    out["is_new"] = is_new(manga, read_state)
    return out


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/manga", methods=["GET"])
def list_manga():
    manga_items = storage.load_manga()
    read_state = storage.load_read_state()
    items = [serialize(m, read_state) for m in manga_items]
    # เรื่องที่ยังไม่อ่านขึ้นก่อน แล้วภายในกลุ่มเดียวกันเรียงตามเวลาที่ "เจอตอนใหม่จริง ๆ"
    # ล่าสุดก่อน (last_updated_at เปลี่ยนเฉพาะตอนตอนล่าสุดเปลี่ยนจริง ไม่ใช่ทุกครั้งที่เช็ค)
    items.sort(key=lambda m: m.get("last_updated_at") or "", reverse=True)
    items.sort(key=lambda m: m["is_new"], reverse=True)
    return jsonify(items)


@app.route("/api/manga", methods=["POST"])
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
    return jsonify(new_item), 201


@app.route("/api/manga/<manga_id>", methods=["DELETE"])
def delete_manga(manga_id):
    manga_items = storage.load_manga()
    remaining = [m for m in manga_items if m["id"] != manga_id]
    if len(remaining) == len(manga_items):
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    storage.save_manga(remaining)

    read_state = storage.load_read_state()
    if manga_id in read_state:
        del read_state[manga_id]
        storage.save_read_state(read_state)

    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/refresh", methods=["POST"])
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
        send_telegram(manga["name"], parsed["latest_chapter"], manga.get("cover_url"))

    read_state = storage.load_read_state()
    return jsonify(serialize(manga, read_state))


@app.route("/api/refresh_all", methods=["POST"])
def refresh_all():
    manga_items = storage.load_manga()
    read_state = storage.load_read_state()
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
                    send_telegram(manga["name"], parsed["latest_chapter"], manga.get("cover_url"))
        except Exception as e:
            failed.append({"id": manga["id"], "name": manga["name"], "error": str(e)})

    storage.save_manga(manga_items)
    items = [serialize(m, read_state) for m in manga_items]
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

    # มาร์คเฉพาะ "ตอนที่เปิดดูจริง" ว่าอ่านแล้ว (ไม่กระทบตอนอื่นของเรื่องเดียวกัน)
    read_state = storage.load_read_state()
    mark_chapter_read(read_state, manga_id, chapter_url)
    storage.save_read_state(read_state)

    data["chapter_url"] = chapter_url
    data["manga_name"] = manga["name"]
    return jsonify(data)


@app.route("/api/manga/<manga_id>/chapters", methods=["GET"])
def list_chapters(manga_id):
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    read_state = storage.load_read_state()
    entry = read_state.get(manga_id)
    chapters = manga.get("chapters") or []
    items = [
        {**c, "is_read": is_chapter_read(entry, c["url"], c["text"])}
        for c in chapters
    ]

    # ตอนล่าสุดที่กดอ่าน (ไว้ให้หน้าเว็บเลื่อนไปหาอัตโนมัติ) เอาจากตัวท้ายสุดของ read_urls
    # (append ต่อท้ายทุกครั้งที่อ่าน จึงเป็นตอนล่าสุดที่อ่านจริง) หรือ fallback ข้อมูลเก่า
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
    body = request.get_json(force=True) or {}
    chapter_url = body.get("url")
    fraction = body.get("fraction")
    if not chapter_url or not isinstance(fraction, (int, float)):
        return jsonify({"error": "ข้อมูลไม่ครบ"}), 400
    fraction = max(0.0, min(1.0, float(fraction)))

    read_state = storage.load_read_state()
    entry = read_state.setdefault(manga_id, {"read_urls": [], "last_read_at": None})
    # ถ้าอ่านจบตอนแล้ว (>=95%) ไม่ต้องเก็บตำแหน่งไว้ เปิดใหม่ควรเริ่มจากบนสุดตามปกติ
    entry["last_scroll"] = None if fraction >= 0.95 else {"url": chapter_url, "fraction": fraction}
    storage.save_read_state(read_state)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/mark_read", methods=["POST"])
def mark_read(manga_id):
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404
    if not manga.get("latest_chapter_url"):
        return jsonify({"error": "ยังไม่ทราบลิงก์ตอนล่าสุด ลองรีเฟรชเรื่องนี้ก่อน"}), 400

    read_state = storage.load_read_state()
    mark_chapter_read(read_state, manga_id, manga["latest_chapter_url"])
    storage.save_read_state(read_state)
    return jsonify({"ok": True})


@app.route("/api/manga/<manga_id>/mark_unread", methods=["POST"])
def mark_unread(manga_id):
    manga_items = storage.load_manga()
    manga = next((m for m in manga_items if m["id"] == manga_id), None)
    if not manga:
        return jsonify({"error": "ไม่พบเรื่องนี้"}), 404

    read_state = storage.load_read_state()
    entry = read_state.get(manga_id)
    latest_url = manga.get("latest_chapter_url")
    if entry and latest_url and latest_url in entry.get("read_urls", []):
        entry["read_urls"].remove(latest_url)
        storage.save_read_state(read_state)
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
