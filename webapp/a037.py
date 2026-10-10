"""037-anime (037-anime.com, WordPress ธีม serie-block) — adapter ของ streams

ตรวจหน้าเว็บจริง (ต.ค. 2026):
- หน้าเรื่อง /serie/<slug>/: og:title / og:image, ตอนทั้งหมดเป็น <span class="episode" episode-id="<post id>">
  แยกซีซั่นด้วย <div id="season-<id>"> + <select id="season-select"> — ตอนไม่มีหน้าของตัวเอง (?p=<id> = 404)
- เลือกตอน: serie.js POST /wp-admin/admin-ajax.php action=mix_get_player&post_id=<episode-id> (ไม่มี nonce, ไม่เช็ค Referer)
  → {"player": {"data": {"th-sound"|"soundtrack": [{"name", "url"}]}}} url = หน้าตัวเล่นของโฮสต์ภายนอก (mycdn-hd.xyz/video/<id>)
- โฮสต์ตัวเล่นตอบ 200 เฉพาะเมื่อ Referer เป็น 037-anime.com — origin อื่น 404 (ยืนยันในเบราว์เซอร์: iframe จาก localhost
  ขึ้น "404 Not Found") → เล่นจากแอปเราไม่ได้ ไม่ปลอม/ตัด Referer เพื่อหลบ: resolve_playback ตรวจด้วย origin จริงของแอป
  แล้วรายงาน PROVIDER_RESTRICTION
"""
import json
import re
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

import scraper
import streams

HOST = "037-anime.com"
HOSTS = {"037-anime.com", "www.037-anime.com"}
AJAX = f"https://{HOST}/wp-admin/admin-ajax.php"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = (5, 15)
MAX_PAGE_BYTES = 3 * 1024 * 1024
LANGS = {"th-sound": "dub", "soundtrack": "sub"}
_SLUG = r"[a-z0-9][a-z0-9-]{0,120}"


def validate_series_url(url: str) -> str | None:
    try:
        parts = urlsplit((url or "").strip())
        port = parts.port
    except ValueError:
        return None
    if (parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in HOSTS
            or port is not None or parts.username is not None or parts.password is not None):
        return None
    match = re.fullmatch(rf"/serie/({_SLUG})/?", parts.path)
    return f"https://{HOST}/serie/{match.group(1)}/" if match else None


def _guard(url: str):
    if scraper.host_is_down(url) or scraper.host_is_stalled(url):
        raise streams.StreamError(streams.STREAM_RESOLUTION_FAILED, f"{urlsplit(url).hostname} ไม่ตอบช่วงนี้", retryable=True)
    scraper.check_public(url)


def _request(method: str, url: str, code: str, read: bool = True, **kwargs) -> tuple[int, bytes]:
    """(status, เนื้อหา) — อ่านแบบ stream มีเพดานขนาด/เวลา (URL ตัวเล่นมาจากเว็บภายนอก ห้ามโหลดทั้งก้อนก่อนเช็ค)
    read=False: ต้องการแค่ status ปิด connection ทันที; ข้อความ error ไม่มี URL (อาจมีโทเคน)"""
    _guard(url)
    try:
        with scraper.awaiting_response(url):
            resp = scraper.session().request(method, url, headers={"User-Agent": UA, **kwargs.pop("headers", {})},
                                             timeout=TIMEOUT, allow_redirects=False, stream=True, **kwargs)
        if not read:
            resp.close()
            return resp.status_code, b""
        return resp.status_code, scraper.read_limited(resp, max_seconds=20, max_bytes=MAX_PAGE_BYTES)
    except requests.RequestException as e:  # รวม PageTooLarge / Timeout จาก read_limited
        if scraper.is_outage(e):
            scraper.mark_host_down(url)
        raise streams.StreamError(code, f"เชื่อมต่อ {urlsplit(url).hostname} ไม่ได้ ({e.__class__.__name__})", retryable=True) from None


def _series_soup(url: str) -> tuple[str, BeautifulSoup]:
    canonical = validate_series_url(url)
    if not canonical:
        raise streams.StreamError(streams.SERIES_PARSE_FAILED, "ไม่ใช่ลิงก์หน้าเรื่องของ 037-anime (/serie/<ชื่อ>/)")
    status, body = _request("GET", canonical, streams.SERIES_PARSE_FAILED)
    if status != 200:
        raise streams.StreamError(streams.SERIES_PARSE_FAILED, f"037-anime ตอบ HTTP {status}")
    return canonical, BeautifulSoup(body.decode("utf-8", errors="replace"), "html.parser")


def get_series_metadata(url: str) -> dict:
    canonical, soup = _series_soup(url)
    og = lambda prop: (soup.find("meta", property=prop) or {}).get("content") or ""
    title = re.sub(r"\s*-\s*037ANIME\s*$", "", og("og:title") or (soup.title.get_text(strip=True) if soup.title else ""))
    if not title:
        raise streams.StreamError(streams.SERIES_PARSE_FAILED, "ไม่พบชื่อเรื่องในหน้า")
    image = og("og:image").replace("http://", "https://", 1)
    name = re.split(r"\s+ตอนที่\s*\d", title, maxsplit=1)[0].strip()
    lang = "dub" if "พากย์ไทย" in title else "sub" if "ซับไทย" in title else None
    return {"url": canonical, "title": title, "name": name or title, "lang": lang,
            "image": image if urlsplit(image).hostname in HOSTS else ""}


def get_episode_list(url: str) -> list[dict]:
    canonical, soup = _series_soup(url)
    seasons = {o.get("value"): o.get_text(strip=True) for o in soup.select("#season-select option")}
    items = []
    for box in soup.select('div[id^="season-"]'):
        season_name = seasons.get(box["id"].removeprefix("season-"), "")
        season = int(m.group(1)) if (m := re.search(r"(\d+)", season_name)) else 1
        for span in box.select("span.episode[episode-id]"):
            ep_id = span["episode-id"]
            text = span.get("title") or span.get_text(" ", strip=True)
            number = re.search(r"ตอนที่\s*(\d+(?:\.\d+)?)", text)
            if not ep_id.isdigit():
                continue
            items.append({"id": ep_id, "title": " ".join(text.split()), "season": season,
                          "episode": float(number.group(1)) if number else None, "series_url": canonical})
    if not items:
        raise streams.StreamError(streams.EPISODE_LIST_FAILED, "ไม่พบรายชื่อตอนในหน้าเรื่อง")
    return items


def get_episode_metadata(series_url: str, episode_id: str) -> dict:
    """ตอนไม่มีหน้าของตัวเอง — ข้อมูลตอนมาจากรายชื่อตอนในหน้าเรื่อง"""
    for item in get_episode_list(series_url):
        if item["id"] == str(episode_id):
            return item
    raise streams.StreamError(streams.EPISODE_LIST_FAILED, "ไม่พบตอนนี้ในหน้าเรื่องแล้ว")


def get_player_servers(episode_id: str) -> list[dict]:
    """[{"lang", "name", "url"}] จาก endpoint สาธารณะที่หน้าเว็บเขาเรียกตอนกดตอน (ไม่ต้องมี Referer/nonce)"""
    if not str(episode_id).isdigit():
        raise streams.StreamError(streams.PLAYER_INFO_MISSING, "รหัสตอนไม่ถูกต้อง")
    status, body = _request("POST", AJAX, streams.PLAYER_INFO_MISSING, data={"action": "mix_get_player", "post_id": str(episode_id)})
    try:
        data = json.loads(body) if status == 200 else None
    except ValueError:
        raise streams.StreamError(streams.PLAYER_INFO_MISSING, "037-anime ไม่ได้ตอบข้อมูลตัวเล่น") from None
    langs = ((data or {}).get("player") or {}).get("data") if (data or {}).get("success") else None
    servers = [{"lang": LANGS.get(lang), "name": s.get("name") or "", "url": s.get("url") or ""}
               for lang, items in (langs.items() if isinstance(langs, dict) else []) for s in (items or [])
               if isinstance(s, dict) and str(s.get("url") or "").startswith("https://")]
    if not servers:
        raise streams.StreamError(streams.PLAYER_INFO_MISSING, "ตอนนี้ไม่มีตัวเล่น")
    return servers


def check_origin(player_url: str, origin: str) -> bool:
    """โฮสต์ตัวเล่นยอมเล่นเมื่อเปิดจากแอปเราไหม — ส่ง Referer เป็น origin จริงของแอป (ค่าที่เบราว์เซอร์จะส่งเอง
    ตามนโยบาย strict-origin-when-cross-origin) ไม่ใช่การปลอม; ไม่ตาม redirect"""
    status, _ = _request("GET", player_url, streams.STREAM_RESOLUTION_FAILED, read=False,
                         headers={"Referer": origin.rstrip("/") + "/"})
    return status == 200


class Provider:
    name = "a037"
    validate_series_url = staticmethod(validate_series_url)
    get_series_metadata = staticmethod(get_series_metadata)
    get_episode_list = staticmethod(get_episode_list)
    get_episode_metadata = staticmethod(get_episode_metadata)

    def resolve_playback(self, video: dict, ctx: dict) -> dict:
        servers = get_player_servers(video.get("episode_ref") or "")
        want = video.get("lang")
        servers.sort(key=lambda s: s["lang"] != want)
        # origin = PUBLIC_ORIGIN ที่ตั้งฝั่งเซิร์ฟเวอร์ (ไม่ใช่ Host ของ request — client กำหนดเองได้ = ใช้ปลอม Referer ได้)
        origin = ctx.get("origin") or ""
        try:
            origin_parts = urlsplit(origin)
        except ValueError:
            origin_parts = None
        host = ((origin_parts and origin_parts.hostname) or "").lower()
        if not host or origin_parts.scheme not in ("http", "https"):
            raise streams.StreamError(streams.PROVIDER_RESTRICTION,
                                      "ยังไม่ได้ตั้ง PUBLIC_ORIGIN ในไฟล์ .env ของเซิร์ฟเวอร์ — ตรวจไม่ได้ว่าตัวเล่นของ 037-anime "
                                      "ยอมเล่นจากเว็บนี้ไหม (ที่ทดสอบไว้: เปิดจากเว็บอื่นได้ 404)")
        if host in HOSTS or host.endswith(".037-anime.com"):
            raise streams.StreamError(streams.PROVIDER_RESTRICTION, "origin เป็นโดเมนของ 037-anime เอง — ไม่ส่ง Referer ของแหล่ง")
        blocked = []
        for server in servers:
            if check_origin(server["url"], origin):
                return {"kind": "embed", "url": server["url"], "expires_at": None, "frame": None}
            blocked.append(urlsplit(server["url"]).hostname)
        raise streams.StreamError(
            streams.PROVIDER_RESTRICTION,
            f"ตัวเล่นของ 037-anime ({', '.join(sorted(set(blocked)))}) ยอมเล่นเฉพาะบนเว็บ 037-anime.com — "
            "เปิดจากแอปนี้ได้ 404 จึงเล่นในแอปไม่ได้")


streams.register(Provider())
