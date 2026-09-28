"""แจ้งเตือนตอนใหม่ผ่าน Web Push (แจ้งเตือนของมือถือ/เบราว์เซอร์) — ใช้ได้กับผู้ใช้ทุกคน ต่างจาก Telegram
ที่ผูกกับแชทเดียวของ admin แต่ละคนได้แจ้งเตือนเฉพาะเรื่องที่ตัวเองติดตาม ส่งถึงทุกเครื่องที่เปิดไว้

กุญแจ VAPID (ใช้ยืนยันกับบริการ push ของ Google/Apple/Mozilla ว่าเป็นเซิร์ฟเวอร์เราจริง) สร้างให้เองครั้งแรก
เก็บที่ data/vapid_private.pem — ห้ามลบหรือเปลี่ยน ไม่งั้นทุกเครื่องที่เปิดแจ้งเตือนไว้ต้องกดเปิดใหม่หมด
(ย้ายเครื่องต้องเอาไฟล์นี้ไปด้วย)
"""
import base64
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import storage

try:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
except ImportError:  # ยังไม่ได้ pip install — ปิดฟีเจอร์นี้ไป ส่วนอื่นของเว็บใช้งานได้ปกติ
    webpush = None

VAPID_KEY_FILE = storage.DATA_DIR / "vapid_private.pem"
PUSH_TIMEOUT = (5, 10)
TTL_SECONDS = 24 * 3600  # เครื่องปิดอยู่ บริการ push เก็บไว้ส่งทีหลังได้ไม่เกิน 1 วัน

# รับเฉพาะ endpoint ของบริการ push จริง — endpoint มาจากเบราว์เซอร์ผู้ใช้ และเซิร์ฟเวอร์จะยิงไปหามัน
# ถ้าไม่จำกัด ผู้ใช้ที่ login ได้จะสั่งให้เซิร์ฟเวอร์ยิงไปที่อยู่ไหนก็ได้ (รวมถึงเครื่องในเครือข่ายภายใน)
ALLOWED_PUSH_HOST_SUFFIXES = (
    ".googleapis.com",        # Chrome / Android / Edge บน Android / Samsung Internet
    ".push.apple.com",        # Safari บน iPhone/iPad/Mac
    ".mozilla.com",           # Firefox
    ".notify.windows.com",    # Edge บน Windows
)

_key_lock = threading.Lock()
_vapid = None
_public_key = None
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="webpush")


def available() -> bool:
    return webpush is not None


def _load_vapid():
    """โหลดกุญแจ (สร้างใหม่ถ้ายังไม่มี) คืน (Vapid, public key แบบ base64url สำหรับหน้าเว็บ)"""
    global _vapid, _public_key
    if _vapid is not None:
        return _vapid, _public_key
    with _key_lock:
        if _vapid is None:
            if VAPID_KEY_FILE.exists():
                vapid = Vapid.from_file(str(VAPID_KEY_FILE))
            else:
                vapid = Vapid()
                vapid.generate_keys()
                tmp = VAPID_KEY_FILE.with_suffix(".tmp")
                vapid.save_key(str(tmp))
                tmp.replace(VAPID_KEY_FILE)
            raw = vapid.public_key.public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
            _public_key = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
            _vapid = vapid
    return _vapid, _public_key


def public_key() -> str | None:
    if not available():
        return None
    return _load_vapid()[1]


def valid_subscription(sub) -> bool:
    if not isinstance(sub, dict):
        return False
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    if not isinstance(endpoint, str) or not keys.get("p256dh") or not keys.get("auth"):
        return False
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and any(host.endswith(s) for s in ALLOWED_PUSH_HOST_SUFFIXES)


def subscribe(username: str, sub: dict, user_agent: str = ""):
    """ผูกเครื่องนี้กับผู้ใช้ — ถ้า endpoint เดียวกันเคยผูกกับบัญชีอื่น (เครื่องเดียวกันเปลี่ยนคน login)
    ย้ายมาอยู่บัญชีนี้แทน ไม่งั้นคนใหม่จะได้แจ้งเตือนเรื่องที่คนเก่าติดตามไปด้วย"""
    entry = {
        "endpoint": sub["endpoint"],
        "keys": {"p256dh": sub["keys"]["p256dh"], "auth": sub["keys"]["auth"]},
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ua": user_agent[:200],
    }
    with storage.state_lock:
        for other in storage.all_usernames():
            if other != username:
                _remove_endpoint(other, entry["endpoint"])
        subs = [s for s in storage.load_push(username, fresh=True) if s.get("endpoint") != entry["endpoint"]]
        subs.append(entry)
        storage.save_push(username, subs)


def unsubscribe(username: str, endpoint: str):
    with storage.state_lock:
        _remove_endpoint(username, endpoint)


def _remove_endpoint(username: str, endpoint: str):
    subs = storage.load_push(username, fresh=True)
    kept = [s for s in subs if s.get("endpoint") != endpoint]
    if len(kept) != len(subs):
        storage.save_push(username, kept)


def send_to_user(username: str, payload: dict, wait: bool = False) -> int:
    """ส่งถึงทุกเครื่องของผู้ใช้ คืนจำนวนเครื่องที่ส่ง — ปกติส่งเบื้องหลัง (ไม่ให้การรีเฟรชต้องรอบริการ push)
    wait=True ใช้ตอนกดทดสอบ จะได้รู้ผลจริง"""
    if not available():
        return 0
    subs = storage.load_push(username)
    if not subs:
        return 0
    data = json.dumps(payload, ensure_ascii=False)
    futures = [_pool.submit(_send_one, username, sub, data) for sub in subs]
    if wait:
        return sum(1 for f in futures if f.result())
    return len(futures)


def _send_one(username: str, sub: dict, data: str) -> bool:
    vapid, _ = _load_vapid()
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
            data=data,
            vapid_private_key=vapid,
            # Apple ปฏิเสธ sub ที่ดูไม่เป็นอีเมล/เว็บจริง (เช่น @localhost) ตั้งเป็นอีเมลตัวเองใน .env ได้
            # (อ่านตอนส่ง ไม่ใช่ตอน import เพราะ app.py โหลด .env หลัง import โมดูลนี้)
            vapid_claims={"sub": os.environ.get("VAPID_SUBJECT") or "mailto:update-manga@example.com"},
            timeout=PUSH_TIMEOUT,
            ttl=TTL_SECONDS,
        )
        return True
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            # เครื่องนั้นปิดแจ้งเตือน/ลบแอป/ล้างข้อมูลเว็บไปแล้ว บริการ push บอกว่าใช้ไม่ได้ถาวร — ลบทิ้ง
            with storage.state_lock:
                _remove_endpoint(username, sub["endpoint"])
            print(f"🔕 ลบเครื่องที่เลิกรับแจ้งเตือนแล้วของ {username} ({status})")
        else:
            print(f"⚠️ ส่ง Web Push ถึง {username} ไม่สำเร็จ ({status}): {e}")
    except Exception as e:
        print(f"⚠️ ส่ง Web Push ถึง {username} ไม่สำเร็จ: {e}")
    return False


def notify_new_chapter(manga_id: str, name: str, chapter: str):
    """แจ้งทุกคนที่ติดตามเรื่องนี้ — tag = id เรื่อง: ตอนใหม่ของเรื่องเดิมแทนที่แจ้งเตือนอันเก่า ไม่กองซ้อนกัน"""
    if not available():
        return
    payload = {
        "title": name,
        "body": f"{chapter} มาแล้ว",
        "tag": f"manga-{manga_id}",
        "url": f"/?manga={manga_id}",
    }
    for username in storage.all_usernames():
        if manga_id in storage.load_subscriptions(username):
            send_to_user(username, payload)
