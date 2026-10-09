"""อ่านข้อมูล YouTube แบบไม่ใช้ API key (playlist/คลิป/ฟีดตอนใหม่) + แยกชื่อเรื่อง/ภาษา/ซีซั่น/ตอนจากชื่อคลิป

- รายชื่อตอนทั้งหมด: หน้า youtube.com/playlist (ytInitialData) + หน้าถัดไปทาง youtubei/v1/browse (ครั้งละ 100)
- ตอนใหม่: อ่าน playlist ทั้งชุดซ้ำ (ฟีด RSS ของ playlist ให้ 15 คลิป "แรก" ไม่ใช่ล่าสุด ใช้หาตอนใหม่ไม่ได้)
- ชื่อ/ปก/ฝังได้ไหม: oEmbed (คลิปที่ปิดการฝังได้ 401)
เล่นผ่านตัวเล่นของ YouTube เท่านั้น — ไม่ดึงไฟล์วิดีโอ (ผิดเงื่อนไข YouTube)

ชื่อคลิปของช่องอนิเมะ (เช่น Muse Thailand) — playlist เดียวรวมทุกซีซั่นของภาษาหนึ่ง เลขตอนนับต่อเนื่องข้ามซีซั่น:
  "[พากย์ไทย] เกิดใหม่ทั้งทีก็เป็นสไลม์ไปซะแล้ว ภาคที่ 2- ตอนที่ 26"
  "เกิดใหม่ทั้งทีก็เป็นสไลม์ไปซะแล้ว ซีซั่น 3 - ตอนที่ 48.5 [ซับไทย]"
"""
import json
import re
from urllib.parse import parse_qs, urlsplit

import requests

import scraper

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
# SOCS/CONSENT: เซิร์ฟเวอร์ในยุโรปโดนหน้า "ยอมรับคุกกี้" แทนหน้า playlist
HEADERS = {"User-Agent": UA, "Accept-Language": "th-TH,th;q=0.9,en;q=0.8", "Cookie": "SOCS=CAI; CONSENT=YES+1"}
TIMEOUT = (5, 15)
MAX_PLAYLIST_ITEMS = 1000
_ID = r"[A-Za-z0-9_-]{11}"
_LIST = r"[A-Za-z0-9_-]{10,64}"
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}


def parse_url(url: str) -> tuple[str, str] | None:
    """("video", id) / ("playlist", list id) / None — ลิงก์ watch ที่มี &list= นับเป็นคลิปเดี่ยว"""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or host not in YOUTUBE_HOSTS:
        return None
    query = parse_qs(parts.query)
    path = parts.path
    if host == "youtu.be":
        match = re.match(rf"^/({_ID})", path)
        return ("video", match.group(1)) if match else None
    if path.rstrip("/") == "/playlist" and re.fullmatch(_LIST, (query.get("list") or [""])[0]):
        return "playlist", query["list"][0]
    # หน้า "รายการ" ของช่อง: /show/VL<list id>
    match = re.match(rf"^/show/VL({_LIST})/?$", path)
    if match:
        return "playlist", match.group(1)
    if path.rstrip("/") == "/watch" and re.fullmatch(_ID, (query.get("v") or [""])[0]):
        return "video", query["v"][0]
    match = re.match(rf"^/(?:shorts|embed|live|v)/({_ID})", path)
    return ("video", match.group(1)) if match else None


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def thumb_url(video_id: str) -> str:
    return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"


def _get(url: str, **kwargs) -> requests.Response:
    resp = scraper.session().get(url, headers=HEADERS, timeout=TIMEOUT, **kwargs)
    resp.raise_for_status()
    return resp


def _duration_seconds(text: str) -> float | None:
    parts = [int(p) for p in re.findall(r"\d+", text or "")]
    if not parts or len(parts) > 3 or ":" not in (text or ""):
        return None
    seconds = 0
    for p in parts:
        seconds = seconds * 60 + p
    return float(seconds)


def _items_from(data) -> tuple[list[dict], str | None]:
    """คลิปในหน้า playlist (รองรับทั้งแบบ lockupViewModel ใหม่ และ playlistVideoRenderer เดิม) + token หน้าถัดไป"""
    items: list[dict] = []
    token = None

    def walk(node):
        nonlocal token
        if isinstance(node, dict):
            lockup = node.get("lockupViewModel")
            if lockup and lockup.get("contentType") == "LOCKUP_CONTENT_TYPE_VIDEO" and lockup.get("contentId"):
                meta = lockup.get("metadata", {}).get("lockupMetadataViewModel", {})
                badge = re.search(r'"thumbnailBadgeViewModel":\s*\{"text":\s*"([\d:]+)"', json.dumps(lockup))
                items.append({"id": lockup["contentId"], "title": (meta.get("title") or {}).get("content", ""),
                              "duration": _duration_seconds(badge.group(1)) if badge else None})
                return
            renderer = node.get("playlistVideoRenderer")
            if renderer and renderer.get("videoId"):
                title = renderer.get("title", {})
                text = title.get("simpleText") or "".join(r.get("text", "") for r in title.get("runs", []))
                seconds = renderer.get("lengthSeconds")
                items.append({"id": renderer["videoId"], "title": text,
                              "duration": float(seconds) if seconds else None})
                return
            for key in ("continuationItemViewModel", "continuationItemRenderer"):
                if key in node:
                    found = re.search(r'"token":\s*"([^"]+)"', json.dumps(node[key]))
                    if found:
                        token = found.group(1)
                    return
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return items, token


def _initial_data(html: str) -> dict:
    match = re.search(r"var ytInitialData = (\{.*?\});</script>", html)
    if not match:
        raise ValueError("อ่านหน้า YouTube ไม่ได้ (YouTube เปลี่ยนหน้า หรือ playlist เป็นส่วนตัว)")
    return json.loads(match.group(1))


def _panel_items(data) -> list[dict]:
    """รายการในแผง playlist ข้างตัวเล่น (หน้า watch) — ได้ราว 200 คลิปรอบ ๆ คลิปที่เปิด"""
    out = []

    def walk(node):
        if isinstance(node, dict):
            renderer = node.get("playlistPanelVideoRenderer")
            if renderer and renderer.get("videoId"):
                title = renderer.get("title", {})
                text = title.get("simpleText") or "".join(r.get("text", "") for r in title.get("runs", []))
                out.append({"id": renderer["videoId"], "title": text,
                            "duration": _duration_seconds((renderer.get("lengthText") or {}).get("simpleText", ""))})
                return
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return out


def fetch_playlist(list_id: str) -> dict:
    """{"title", "channel", "items": [{"id", "title", "duration", "index"}]} ตามลำดับใน playlist
    หน้า playlist ให้ 100 คลิปแรก — ที่เหลืออ่านจากแผง playlist ของหน้า watch โดยเปิดคลิปสุดท้ายที่รู้แล้ว
    (ขอหน้าถัดไปทาง youtubei/v1/browse ตอบว่างเปล่าสำหรับผู้ใช้ที่ไม่ได้ login — ทดสอบ ต.ค. 2026)"""
    html = _get(f"https://www.youtube.com/playlist?list={list_id}").text
    data = _initial_data(html)
    title = (data.get("header", {}).get("pageHeaderRenderer", {}).get("pageTitle")
             or data.get("metadata", {}).get("playlistMetadataRenderer", {}).get("title") or "")
    raw = json.dumps(data, ensure_ascii=False)
    channel = re.search(r'"content":\s*"โดย ([^"]+)"', raw) or re.search(r'"ownerText":\s*\{"runs":\s*\[\{"text":\s*"([^"]+)"', raw)
    items, token = _items_from(data)
    seen = {item["id"] for item in items}
    while token and items and len(items) < MAX_PLAYLIST_ITEMS:
        panel = _panel_items(_initial_data(
            _get(f"https://www.youtube.com/watch?v={items[-1]['id']}&list={list_id}&index={len(items)}").text))
        if items[-1]["id"] not in {p["id"] for p in panel}:
            break
        after = [p for p in panel[[p["id"] for p in panel].index(items[-1]["id"]) + 1:] if p["id"] not in seen]
        if not after:
            break
        items.extend(after)
        seen.update(p["id"] for p in after)
    unique, ids = [], set()
    for item in items:
        if item["id"] not in ids:
            ids.add(item["id"])
            unique.append({**item, "index": len(unique) + 1})
    if not unique:
        raise ValueError("playlist นี้ไม่มีคลิป หรือเป็นส่วนตัว")
    return {"title": title, "channel": channel.group(1) if channel else "", "items": unique}


def video_meta(video_id: str) -> dict:
    """{"title", "channel", "embeddable"} — oEmbed ตอบ 401/403 เมื่อเจ้าของปิดการฝัง"""
    try:
        resp = scraper.session().get("https://www.youtube.com/oembed",
                                     params={"url": watch_url(video_id), "format": "json"},
                                     headers=HEADERS, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise ValueError(f"เชื่อมต่อ YouTube ไม่ได้: {e}") from None
    if resp.status_code in (401, 403):
        return {"title": "", "channel": "", "embeddable": False}
    if resp.status_code == 404:
        raise ValueError("ไม่พบคลิปนี้ (ถูกลบหรือเป็นส่วนตัว)")
    resp.raise_for_status()
    data = resp.json()
    return {"title": data.get("title") or "", "channel": data.get("author_name") or "", "embeddable": True}


# ---------- แยกชื่อเรื่อง / ภาษา / ซีซั่น / ตอน จากชื่อ ----------
_LANG_PATTERNS = (
    ("dub", re.compile(r"[\[\(【]?\s*(?:พากย์ไทย|พากษ์ไทย|thai\s*dub(?:bed)?)\s*[\]\)】]?", re.I)),
    ("sub", re.compile(r"[\[\(【]?\s*(?:ซับไทย|ซับ\s*ไทย|thai\s*sub(?:titles?)?)\s*[\]\)】]?", re.I)),
)
_SEASON = re.compile(
    r"(?:ภาค(?:ที่)?|ซีซั่น|ซีซัน|season|ss\.?)\s*(\d+)|(\d+)(?:st|nd|rd|th)\s+season|\bS(\d+)\b", re.I)
_EPISODE = re.compile(r"(?:ตอนที่|ตอน|ep\.?|episode|#)\s*(\d+(?:\.\d+)?)", re.I)


def detect_lang(title: str) -> str | None:
    for lang, pattern in _LANG_PATTERNS:
        if pattern.search(title or ""):
            return lang
    return None


def detect_season(title: str) -> int | None:
    match = _SEASON.search(title or "")
    if not match:
        return None
    return int(next(g for g in match.groups() if g))


def parse_episode(title: str) -> float | None:
    match = _EPISODE.search(title or "")
    if match:
        return float(match.group(1))
    # ไม่มีคำว่า "ตอน": เลขท้ายสุดหลังขีด เช่น "ชื่อเรื่อง - 12"
    match = re.search(r"[-–|]\s*(\d+(?:\.\d+)?)\s*$", strip_lang(title or ""))
    return float(match.group(1)) if match else None


def strip_lang(title: str) -> str:
    for _, pattern in _LANG_PATTERNS:
        title = pattern.sub(" ", title)
    return " ".join(title.split())


def series_name(title: str) -> str:
    """ชื่อเรื่องล้วน ๆ จากชื่อ playlist/คลิป: ตัด [พากย์ไทย]/[ซับไทย], ซีซั่น, ตอน, ขีดท้าย"""
    name = strip_lang(title)
    name = _EPISODE.split(name)[0]
    name = _SEASON.split(name)[0] if _SEASON.search(name) else name
    return " ".join(name.strip(" -–|:[]()").split())


def norm_name(name: str) -> str:
    """เทียบชื่อเรื่องแบบหลวม — ไม่สนวรรณยุกต์/เว้นวรรค/ตัวพิมพ์/วงเล็บ"""
    name = re.sub(r"[ัิ-ฺ็-๎\s\W_]+", "", (name or "").casefold())
    return name
