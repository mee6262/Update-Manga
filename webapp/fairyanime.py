"""FairyAnime (fairyanime.net) — เพิ่มตอนอนิเมะเข้าคลังวิดีโอ เล่นโดยฝังตัวเล่นของเว็บ (iframe)

ตรวจหน้าเว็บจริง (ต.ค. 2026):
- หน้าเรื่อง /<slug>/: og:title / og:image, ตอนทั้งหมดใน table.table-episode a[href=/watch/<id>.html] (ไม่แบ่งหน้า)
  หน้าอื่นระดับเดียวกัน (genre/, search/ ...) ไม่มีตาราง = ไม่ใช่หน้าเรื่อง
- หน้าตอน /watch/<id>.html (หรือ /watch/<id>/): ชื่อตอนใน <title>, ปกใน og:image, ไม่มีลิงก์กลับหน้าเรื่อง
- ตัวเล่น: หน้าตอนโหลด /base/<id>/ (JS) ซึ่งมี webmainapp = 'https://<โฮสต์ตัวเล่น>/' + slug
  → iframe <โฮสต์>/playback/f/<slug>/ = ตัวห่อโฆษณาก่อนเรื่อง 2 ตัว ซึ่งจบแล้วเปิด iframe <โฮสต์>/playback/v/<slug>/
  (ตัวเล่นตอนจริง ซ้อนกรอบ anime.tonytonychopper.net อีกชั้น ที่เช็ค Referer = โฮสต์ตัวเล่น — ได้เองเพราะซ้อนใน playback/v)
  แอปฝัง playback/v ตรง (มี่เลือกข้ามโฆษณา) — ไม่มีตัวเลือกเซิร์ฟเวอร์สำรองแบบใน playback/f
  ทดสอบ Chromium ฝังจาก localhost ใน sandbox แบบเดียวกับแอป: พร้อมใน 1 วิ แตะครั้งเดียวเล่นตอนจริง
  ไม่ดึงไฟล์วิดีโอเอง; slug อ่านใหม่ตอนกดเล่น (แคชใน streams 10 นาที)
"""
import re
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

import scraper
import streams

LABEL = "FairyAnime"
HOST = "fairyanime.net"
HOSTS = {"fairyanime.net", "www.fairyanime.net"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = (5, 15)
MAX_PAGE_BYTES = 3 * 1024 * 1024
_SLUG = r"[a-z0-9][a-z0-9-]{0,150}"
_EP = r"[A-Za-z0-9]{6,20}"
# หน้าระดับเดียวกับหน้าเรื่องที่ไม่ใช่เรื่อง
_RESERVED = {"genre", "search", "member", "blog", "status", "scoretop", "watch", "base", "assets", "uploads",
             "category", "tag", "page", "feed"}


def parse_url(url: str) -> tuple[str, str, None] | None:
    """("episode", id ตอน, None) / ("series", slug, None) / None
    รับเฉพาะ http(s)://fairyanime.net ไม่มี user:pass ไม่ระบุพอร์ต — query/fragment ทิ้ง"""
    try:
        parts = urlsplit((url or "").strip())
        port = parts.port
    except ValueError:
        return None
    if (parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in HOSTS
            or port is not None or parts.username is not None or parts.password is not None):
        return None
    match = re.fullmatch(rf"/watch/({_EP})(?:\.html|/)?", parts.path)
    if match:
        return "episode", match.group(1), None
    match = re.fullmatch(rf"/({_SLUG})/?", parts.path)
    return ("series", match.group(1), None) if match and match.group(1) not in _RESERVED else None


def episode_url(episode_id: str) -> str:
    return f"https://{HOST}/watch/{episode_id}.html"


def series_url(slug: str) -> str:
    return f"https://{HOST}/{slug}/"


def canonical_episode_url(url: str) -> str | None:
    parsed = parse_url(url)
    return episode_url(parsed[1]) if parsed and parsed[0] == "episode" else None


def canonical_series_url(url: str) -> str | None:
    parsed = parse_url(url)
    return series_url(parsed[1]) if parsed and parsed[0] == "series" else None


def is_image_url(url: str) -> bool:
    """ปกที่ยอมให้เซิร์ฟเวอร์ดาวน์โหลด: https://fairyanime.net/uploads/... เท่านั้น"""
    try:
        parts = urlsplit(url or "")
        return (parts.scheme == "https" and (parts.hostname or "").lower() == HOST and parts.port is None
                and parts.username is None and parts.path.startswith("/uploads/"))
    except ValueError:
        return False


def _get(url: str) -> requests.Response:
    """ยิงเฉพาะ URL ที่สร้างจาก parse_url แล้ว (โฮสต์ fairyanime.net) ไม่ตาม redirect"""
    if scraper.host_is_down(url) or scraper.host_is_stalled(url):
        raise ValueError("FairyAnime ไม่ตอบช่วงนี้ ลองใหม่อีกครั้ง")
    try:
        with scraper.awaiting_response(url):
            resp = scraper.session().get(url, headers={"User-Agent": UA, "Accept-Language": "th-TH,th;q=0.9"},
                                         timeout=TIMEOUT, allow_redirects=False)
    except requests.RequestException as e:
        if scraper.is_outage(e):
            scraper.mark_host_down(url)
        raise ValueError(f"เชื่อมต่อ FairyAnime ไม่ได้: {e.__class__.__name__}") from None
    if resp.status_code == 404:
        raise ValueError("ไม่พบหน้านี้บน FairyAnime (ลิงก์ผิดหรือถูกลบ)")
    if resp.status_code != 200:
        raise ValueError(f"FairyAnime ตอบ HTTP {resp.status_code}")
    if len(resp.content) > MAX_PAGE_BYTES:
        raise ValueError("หน้า FairyAnime ใหญ่ผิดปกติ")
    return resp


def _clean(text: str) -> str:
    return " ".join(re.sub(r"\s*-\s*FairyAnime.*$", "", text or "").split())


def _meta(soup: BeautifulSoup, prop: str) -> str:
    tag = soup.find("meta", property=prop)
    return (tag.get("content") or "").strip() if tag else ""


def series_name(title: str) -> str:
    """"Mushen Ji ตำนานเทพกู้จักรวาล เสียงไทย พากย์ไทย" → "Mushen Ji ตำนานเทพกู้จักรวาล" """
    name = re.split(r"\s+(?:ตอนที่|ตอน|EP\.?)\s*\d", title, maxsplit=1, flags=re.I)[0]
    while True:
        cut = re.sub(r"\s*(?:\([^)]*\)|\[[^\]]*\]|ซับไทย|พากย์ไทย|เสียงไทย|บรรยายไทย|\d+\s*-\s*\d+)\s*$", "", name).strip()
        if cut == name:
            break
        name = cut
    return name or title


def fetch_episode(url: str) -> dict:
    """{"url", "title", "series_url" (None — หน้าตอนไม่มีลิงก์กลับหน้าเรื่อง), "image", "embeddable"}"""
    canonical = canonical_episode_url(url)
    if not canonical:
        raise ValueError("ไม่ใช่ลิงก์ตอนของ FairyAnime")
    soup = BeautifulSoup(_get(canonical).text, "html.parser")
    title = _clean(soup.title.get_text(strip=True) if soup.title else "") or _meta(soup, "og:title")
    image = urljoin(canonical, _meta(soup, "og:image"))
    return {"url": canonical, "title": title, "series_url": None, "image": image if is_image_url(image) else "",
            "embeddable": soup.select_one("#video_player") is not None}


def fetch_series(url: str) -> dict:
    """{"url", "title", "name", "image", "items": [{"url", "title"}]} — เรียงตามหน้าเว็บ (ตอนแรกก่อน)"""
    canonical = canonical_series_url(url)
    if not canonical:
        raise ValueError("ไม่ใช่ลิงก์หน้าเรื่องของ FairyAnime (fairyanime.net/<ชื่อเรื่อง>/)")
    soup = BeautifulSoup(_get(canonical).text, "html.parser")
    items, seen = [], set()
    for a in soup.select("table.table-episode a[href]"):
        ep = canonical_episode_url(urljoin(canonical, a["href"]))
        if ep and ep not in seen:
            seen.add(ep)
            items.append({"url": ep, "title": " ".join(a.get_text(" ", strip=True).split())})
    title = _meta(soup, "og:title") or _clean(soup.title.get_text(strip=True) if soup.title else "")
    image = urljoin(canonical, _meta(soup, "og:image"))
    return {"url": canonical, "title": title, "name": series_name(title), "image": image if is_image_url(image) else "",
            "items": items}


def player_url(episode_id: str) -> str:
    """อ่าน /base/<id>/ ของหน้าตอน → https://<โฮสต์ตัวเล่น>/playback/v/<slug>/ (ตัวเล่นตอนจริง ไม่ผ่านตัวห่อโฆษณา)"""
    js = _get(f"https://{HOST}/base/{episode_id}/").text
    host = re.search(r"webmainapp\s*=\s*['\"](https://[A-Za-z0-9.-]+/)['\"]", js)
    slug = re.search(r"var\s+slug\s*=\s*['\"]([A-Za-z0-9_-]{4,40})['\"]", js)
    if not host or not slug or slug.group(1) in ("null", "undefined"):  # id ที่ไม่มีจริง เว็บตอบ 200 + slug = "null"
        raise ValueError("ไม่พบตัวเล่นของตอนนี้บน FairyAnime (ตอนอาจถูกลบ)")
    return f"{host.group(1)}playback/v/{slug.group(1)}/"


class Provider:
    """adapter ของ streams — ข้อมูลเรื่อง/ตอนจากฟังก์ชันข้างบน, เล่นด้วยการฝังตัวเล่นของเว็บ"""
    name = "fairyanime"

    @staticmethod
    def validate_series_url(url: str) -> str | None:
        return canonical_series_url(url)

    @staticmethod
    def get_series_metadata(url: str) -> dict:
        try:
            info = fetch_series(url)
        except ValueError as e:
            raise streams.StreamError(streams.SERIES_PARSE_FAILED, str(e)) from None
        return {k: info[k] for k in ("url", "name", "title", "image")}

    @staticmethod
    def get_episode_list(url: str) -> list[dict]:
        try:
            items = fetch_series(url)["items"]
        except ValueError as e:
            raise streams.StreamError(streams.EPISODE_LIST_FAILED, str(e)) from None
        if not items:
            raise streams.StreamError(streams.EPISODE_LIST_FAILED, "ไม่พบรายชื่อตอนในหน้าเรื่อง")
        return items

    @staticmethod
    def get_episode_metadata(url: str) -> dict:
        try:
            return fetch_episode(url)
        except ValueError as e:
            raise streams.StreamError(streams.PLAYER_INFO_MISSING, str(e)) from None

    @staticmethod
    def resolve_playback(video: dict, ctx: dict) -> dict:
        parsed = parse_url(video.get("source_url") or "")
        if not parsed or parsed[0] != "episode":
            raise streams.StreamError(streams.PLAYER_INFO_MISSING, "ลิงก์ตอนของ FairyAnime ไม่ถูกต้อง")
        try:
            url = player_url(parsed[1])
        except ValueError as e:
            raise streams.StreamError(streams.STREAM_RESOLUTION_FAILED, str(e), retryable=True) from None
        return {"kind": "embed", "url": url, "expires_at": None, "frame": None}


streams.register(Provider())
