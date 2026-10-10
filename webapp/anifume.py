"""Anifume (anifume.com) — เพิ่มตอนอนิเมะเข้าคลังวิดีโอ เล่นโดยฝังหน้าตอนต้นฉบับทั้งหน้า (iframe)

ตรวจหน้าเว็บจริง (ต.ค. 2026):
- หน้าตอน /<เลขเรื่อง>/<โทเคน>: ตัวเล่นโหลดด้วย ajax ไปปลายทางที่เข้ารหัส + ต้องมี Referer ของหน้าตอน
  + ลิงก์ตัวเล่นมีวันหมดอายุ (e=...) — ไม่ใช่ embed ที่เว็บเปิดให้ใช้ จึงไม่ดึงลิงก์ตัวเล่นเอง
  แต่หน้าตอนไม่ส่ง X-Frame-Options / CSP frame-ancestors = ฝังทั้งหน้าใน iframe ได้ (ทดสอบแล้วเล่นได้)
- หน้ารวมตอน /<เลขเรื่อง>: ชื่อเรื่อง (h1.post-title), ปก (.post-content-img img), ลิงก์ทุกตอน (.eplink a)
- ไม่ต้องใช้คุกกี้; ไม่มี og:image ในหน้าตอน (ปกเอาจากหน้ารวมตอน)
"""
import re
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

import scraper

HOST = "anifume.com"
HOSTS = {"anifume.com", "www.anifume.com"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = (5, 15)
MAX_PAGE_BYTES = 2 * 1024 * 1024
_SERIES = r"\d{1,9}"
_TOKEN = r"[A-Za-z0-9_-]{8,64}"


def parse_url(url: str) -> tuple[str, str, str | None] | None:
    """("episode", เลขเรื่อง, โทเคน) / ("series", เลขเรื่อง, None) / None
    รับเฉพาะ http(s)://anifume.com ไม่มี user:pass ไม่ระบุพอร์ต — query/fragment ทิ้ง"""
    try:
        parts = urlsplit((url or "").strip())
        port = parts.port
    except ValueError:
        return None
    if (parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in HOSTS
            or port is not None or parts.username is not None or parts.password is not None):
        return None
    match = re.fullmatch(rf"/({_SERIES})/({_TOKEN})/?", parts.path)
    if match:
        return "episode", match.group(1), match.group(2)
    match = re.fullmatch(rf"/({_SERIES})/?", parts.path)
    return ("series", match.group(1), None) if match else None


def episode_url(series_id: str, token: str) -> str:
    return f"https://{HOST}/{series_id}/{token}"


def series_url(series_id: str) -> str:
    return f"https://{HOST}/{series_id}"


def canonical_episode_url(url: str) -> str | None:
    parsed = parse_url(url)
    return episode_url(parsed[1], parsed[2]) if parsed and parsed[0] == "episode" else None


def is_image_url(url: str) -> bool:
    """ปกที่ยอมให้เซิร์ฟเวอร์ดาวน์โหลด: https://anifume.com/... เท่านั้น (กันใช้เซิร์ฟเวอร์ยิงที่อยู่อื่น)"""
    try:
        parts = urlsplit(url or "")
        return (parts.scheme == "https" and (parts.hostname or "").lower() == HOST and parts.port is None
                and parts.username is None)
    except ValueError:
        return False


def _framable(headers) -> bool:
    if (headers.get("X-Frame-Options") or "").strip():
        return False
    csp = (headers.get("Content-Security-Policy") or "").lower()
    return "frame-ancestors" not in csp


def _get(url: str) -> requests.Response:
    """ยิงเฉพาะ URL ที่สร้างจาก parse_url แล้ว (โฮสต์ anifume.com) ไม่ตาม redirect"""
    if scraper.host_is_down(url) or scraper.host_is_stalled(url):
        raise ValueError("Anifume ไม่ตอบช่วงนี้ ลองใหม่อีกครั้ง")
    try:
        with scraper.awaiting_response(url):
            resp = scraper.session().get(url, headers={"User-Agent": UA, "Accept-Language": "th-TH,th;q=0.9"},
                                         timeout=TIMEOUT, allow_redirects=False)
    except requests.RequestException as e:
        if scraper.is_outage(e):
            scraper.mark_host_down(url)
        raise ValueError(f"เชื่อมต่อ Anifume ไม่ได้: {e.__class__.__name__}") from None
    if resp.status_code == 404:
        raise ValueError("ไม่พบหน้านี้บน Anifume (ลิงก์ผิดหรือถูกลบ)")
    if resp.status_code != 200:
        raise ValueError(f"Anifume ตอบ HTTP {resp.status_code}")
    if len(resp.content) > MAX_PAGE_BYTES:
        raise ValueError("หน้า Anifume ใหญ่ผิดปกติ")
    return resp


def _page_title(soup: BeautifulSoup) -> str:
    h1 = soup.select_one("h1.post-title")
    text = h1.get_text(" ", strip=True) if h1 else (soup.title.get_text(strip=True) if soup.title else "")
    return " ".join(re.sub(r"\s*-\s*Anifume\s*$", "", text).split())


def fetch_episode(url: str) -> dict:
    """{"url", "title", "series_url" (None = ไม่พบ), "embeddable"}"""
    canonical = canonical_episode_url(url)
    if not canonical:
        raise ValueError("ไม่ใช่ลิงก์ตอนของ Anifume")
    resp = _get(canonical)
    soup = BeautifulSoup(resp.text, "html.parser")
    series = None
    for a in soup.select(".content a[href]"):
        parsed = parse_url(urljoin(canonical, a["href"]))
        if parsed and parsed[0] == "series" and canonical.startswith(series_url(parsed[1]) + "/"):
            series = series_url(parsed[1])
            break
    return {"url": canonical, "title": _page_title(soup), "series_url": series, "embeddable": _framable(resp.headers)}


def series_name(title: str) -> str:
    """"จีโนเซีย ตอนที่ 1-21 ซับไทย [จบ]" → "จีโนเซีย" """
    name = re.split(r"\s+(?:ตอนที่|ตอน|EP\.?)\s*\d", title, maxsplit=1, flags=re.I)[0]
    name = re.sub(r"\s*(?:\[[^\]]*\]|ซับไทย|พากย์ไทย)\s*$", "", name).strip()
    return name or title


def fetch_series(url: str) -> dict:
    """{"url", "title", "name", "image", "items": [{"url", "title"}]} — เรียงตามหน้าเว็บ"""
    parsed = parse_url(url)
    if not parsed:
        raise ValueError("ไม่ใช่ลิงก์ Anifume")
    canonical = series_url(parsed[1])
    soup = BeautifulSoup(_get(canonical).text, "html.parser")
    items, seen = [], set()
    for a in soup.select(".eplink a[href]"):
        ep = canonical_episode_url(urljoin(canonical, a["href"]))
        if ep and ep.startswith(canonical + "/") and ep not in seen:
            seen.add(ep)
            items.append({"url": ep, "title": " ".join(a.get_text(" ", strip=True).split())})
    img = soup.select_one(".post-content-img img[src]")
    image = urljoin(canonical, img["src"]) if img else ""
    title = _page_title(soup)
    return {"url": canonical, "title": title, "name": series_name(title), "image": image if is_image_url(image) else "",
            "items": items}
