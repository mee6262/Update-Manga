"""AnimeRuka (animeruka.com) — เพิ่มตอนอนิเมะเข้าคลังวิดีโอ เล่นโดยฝังตัวเล่นที่เว็บใช้ (iframe)

ตรวจหน้าเว็บจริง (ต.ค. 2026, ธีม WordPress DooPlay):
- หน้าเรื่อง /anime/<slug>/: #seasons .se-c = บล็อกละภาค+ภาษา (หัว .se-q "ภาค1 ..."), ตอนใน ul.episodios li
  (.numerando "ตอนที่ N", .episodiotitle a = ลิงก์ตอน + ชื่อที่ลงท้าย "ซับไทย"/"พากย์ไทย")
  พากย์กับซับเป็นคนละบล็อก คนละลิงก์ตอน (…-ep-N/ กับ …-thai-ep-N/) — ภาษาอ่านจากชื่อตอน
- หน้าตอน /ep/<slug>/: ตัวเลือกตัวเล่น #playeroptionsul li[data-post][data-type][data-nume] (หลัก/สำรอง1/สำรอง2)
  ลิงก์จริงจาก /wp-json/dooplayer/v2/<post>/<type>/<nume> → {"embed_url", "type": "iframe"}
  ทดสอบ Rakudai Kenja พากย์ ตอน 2: หลัก = animemami.xyz (CSP frame-ancestors เฉพาะ animeruka → ฝังที่อื่นไม่ได้),
  สำรอง1 = abyssplayer.com (ฝังได้ เล่นได้ 23:40), สำรอง2 = ok.ru (หน้าบอก "Видео не найдено" = ถูกลบ)
  → เลือกตัวแรกที่ฝังได้: ข้ามโฮสต์ที่ห้ามฝัง, ok.ru เช็คก่อนว่ายังมีวิดีโอ
ลิงก์หน้าเรื่องเลือกภาค/ภาษาด้วย fragment: #dub / #sub / #sub-2 (ภาค 2) — ไม่ระบุ = ภาคล่าสุด พากย์ก่อน
"""
import json
import re
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

import scraper
import streams

LABEL = "AnimeRuka"
HOST = "animeruka.com"
HOSTS = {"animeruka.com", "www.animeruka.com"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = (5, 15)
MAX_PAGE_BYTES = 3 * 1024 * 1024
_SLUG = r"[a-z0-9][a-z0-9-]{0,200}"
NO_EMBED_HOSTS = {"animemami.xyz"}          # ห้ามฝังนอก animeruka (CSP frame-ancestors)
PREFERRED_HOSTS = ("abyssplayer.com", "ok.ru")  # ฝังได้ เรียงตามที่ลองแล้วเล่นได้
LANG_TAG = {"dub": "[พากย์ไทย]", "sub": "[ซับไทย]"}
_VARIANT = re.compile(r"^(dub|sub)(?:-(\d+))?$")


def parse_url(url: str) -> tuple[str, str, str | None] | None:
    """("episode", slug, None) / ("series", slug, "dub"|"sub"|"sub-2"|None) / None — query ทิ้ง"""
    try:
        parts = urlsplit((url or "").strip())
        port = parts.port
    except ValueError:
        return None
    if (parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in HOSTS
            or port is not None or parts.username is not None or parts.password is not None):
        return None
    match = re.fullmatch(rf"/ep/({_SLUG})/?", parts.path)
    if match:
        return "episode", match.group(1), None
    match = re.fullmatch(rf"/anime/({_SLUG})/?", parts.path)
    if match:
        return "series", match.group(1), parts.fragment if _VARIANT.match(parts.fragment or "") else None
    return None


def episode_url(slug: str) -> str:
    return f"https://{HOST}/ep/{slug}/"


def series_url(slug: str, variant: str | None = None) -> str:
    return f"https://{HOST}/anime/{slug}/" + (f"#{variant}" if variant else "")


def canonical_episode_url(url: str) -> str | None:
    parsed = parse_url(url)
    return episode_url(parsed[1]) if parsed and parsed[0] == "episode" else None


def canonical_series_url(url: str) -> str | None:
    parsed = parse_url(url)
    return series_url(parsed[1], parsed[2]) if parsed and parsed[0] == "series" else None


def is_image_url(url: str) -> bool:
    """ปกที่ยอมให้เซิร์ฟเวอร์ดาวน์โหลด: https://animeruka.com/wp-content/uploads/... เท่านั้น"""
    try:
        parts = urlsplit(url or "")
        return (parts.scheme == "https" and (parts.hostname or "").lower() in HOSTS and parts.port is None
                and parts.username is None and parts.path.startswith("/wp-content/uploads/"))
    except ValueError:
        return False


def _get(url: str, host_check: bool = True) -> requests.Response:
    """host_check: ยิงเฉพาะ animeruka (ลิงก์จาก parse_url / wp-json) — ตัวเช็ค ok.ru ปิดไว้แต่จำกัดโฮสต์เอง"""
    if scraper.host_is_down(url) or scraper.host_is_stalled(url):
        raise ValueError("AnimeRuka ไม่ตอบช่วงนี้ ลองใหม่อีกครั้ง")
    try:
        with scraper.awaiting_response(url):
            resp = scraper.session().get(url, headers={"User-Agent": UA, "Accept-Language": "th-TH,th;q=0.9"},
                                         timeout=TIMEOUT, allow_redirects=False)
    except requests.RequestException as e:
        if scraper.is_outage(e):
            scraper.mark_host_down(url)
        raise ValueError(f"เชื่อมต่อ AnimeRuka ไม่ได้: {e.__class__.__name__}") from None
    if resp.status_code == 404:
        raise ValueError("ไม่พบหน้านี้บน AnimeRuka (ลิงก์ผิดหรือถูกลบ)")
    if resp.status_code != 200:
        raise ValueError(f"AnimeRuka ตอบ HTTP {resp.status_code}")
    if len(resp.content) > MAX_PAGE_BYTES:
        raise ValueError("หน้า AnimeRuka ใหญ่ผิดปกติ")
    return resp


def _meta(soup: BeautifulSoup, prop: str) -> str:
    tag = soup.find("meta", property=prop)
    return (tag.get("content") or "").strip() if tag else ""


def _image(soup: BeautifulSoup, base: str) -> str:
    """ปกของเว็บเอง — og:image ตัวแรกบางหน้าเป็นรูปจาก TMDB (โฮสต์อื่น ไม่ยอมดาวน์โหลด) ใช้ตัวที่อยู่บน animeruka"""
    for tag in soup.find_all("meta", property="og:image"):
        url = urljoin(base, (tag.get("content") or "").strip())
        if is_image_url(url):
            return url
    return ""


def series_name(title: str) -> str:
    """"Rakudai … ปราชญ์ตกชั้นขอเกิดใหม่เป็นเทพซ่า ซับไทย และ พากย์ไทย จบแล้ว - AnimeRuka" → "Rakudai … เทพซ่า" """
    name = re.split(r"\s+-\s+AnimeRuka", title or "", flags=re.I)[0]
    name = re.split(r"\s+(?:ตอนที่|ตอน|EP\.?)\s*\d", name, maxsplit=1, flags=re.I)[0]
    while True:
        cut = re.sub(r"\s*(?:จบแล้ว|จบ|และ|ซับไทย|พากย์ไทย|พากษ์ไทย|ซับ|พากย์)\s*$", "", name).strip()
        if cut == name:
            break
        name = cut
    return " ".join(name.split()) or title


def _lang_of(text: str) -> str | None:
    if re.search(r"พากย์ไทย|พากษ์ไทย", text):
        return "dub"
    if re.search(r"ซับไทย|ซับ", text):
        return "sub"
    return None


def _blocks(soup: BeautifulSoup, base: str) -> dict[tuple[int, str], list[tuple[float, str]]]:
    """{(ภาค, ภาษา): [(เลขตอน, ลิงก์ตอน)]} จากบล็อก #seasons — ภาคจากหัวบล็อก ("ภาค1") ไม่มี = ลำดับบล็อกของภาษานั้น"""
    out: dict[tuple[int, str], list[tuple[float, str]]] = {}
    seen_lang: dict[str, int] = {}
    for block in soup.select("#seasons .se-c"):
        head = block.select_one(".se-q")
        head_text = head.get_text(" ", strip=True) if head else ""
        items = []
        lang = None
        for li in block.select("ul.episodios li"):
            a = li.select_one(".episodiotitle a[href]")
            num = re.search(r"(\d+(?:\.\d+)?)", (li.select_one(".numerando") or a or li).get_text(" ", strip=True))
            url = a and canonical_episode_url(urljoin(base, a["href"]))
            if not url or not num:
                continue
            lang = lang or _lang_of(a.get_text(" ", strip=True)) or ("dub" if "-thai-ep-" in url else None)
            items.append((float(num.group(1)), url))
        if not items:
            continue
        lang = lang or _lang_of(head_text) or "sub"
        marked = re.search(r"ภาค\s*(\d+)|season\s*(\d+)", head_text, re.I)
        seen_lang[lang] = seen_lang.get(lang, 0) + 1
        season = int(next(g for g in marked.groups() if g)) if marked else seen_lang[lang]
        out.setdefault((season, lang), []).extend(items)
    return out


def fetch_series(url: str) -> dict:
    """หน้าเรื่อง (+ #dub/#sub/#sub-2) → {"url", "title", "name", "image", "lang", "season", "variants": [{"key",
    "url", "label", "count"}], "langs", "lang_urls", "items": [{"url", "title"}]} — รายการตามภาค+ภาษาที่เลือก"""
    parsed = parse_url(url)
    if not parsed or parsed[0] != "series":
        raise ValueError("ไม่ใช่ลิงก์หน้าเรื่องของ AnimeRuka (animeruka.com/anime/<ชื่อเรื่อง>/)")
    page = series_url(parsed[1])
    soup = BeautifulSoup(_get(page).text, "html.parser")
    blocks = _blocks(soup, page)
    if not blocks:
        raise ValueError("ไม่พบรายชื่อตอนในหน้านี้")
    seasons = sorted({s for s, _ in blocks})
    if parsed[2]:
        lang, num = _VARIANT.match(parsed[2]).groups()
        season = int(num) if num else seasons[-1]
    else:
        season = seasons[-1]
        lang = "dub" if (season, "dub") in blocks else "sub"
    if (season, lang) not in blocks:
        raise ValueError("ภาค/ภาษานี้ไม่มีในหน้าเรื่อง")
    multi = len(seasons) > 1
    key = lambda s, l: f"{l}-{s}" if multi else l  # noqa: E731
    variants = [{"key": key(s, l), "url": series_url(parsed[1], key(s, l)), "count": len(eps),
                 "label": f"{'ภาค ' + str(s) + ' · ' if multi else ''}{'พากย์ไทย' if l == 'dub' else 'ซับไทย'}"}
                for (s, l), eps in sorted(blocks.items())]
    title = _meta(soup, "og:title") or (soup.title.get_text(strip=True) if soup.title else "")
    name = series_name(title) + (f" ภาค {season}" if multi and season > 1 else "")
    image = _image(soup, page)
    items = [{"url": ep_url, "title": f"{name} ตอนที่ {num:g} {LANG_TAG[lang]}"} for num, ep_url in blocks[(season, lang)]]
    langs = {l: len(blocks.get((season, l), [])) for l in ("dub", "sub")}
    return {"url": series_url(parsed[1], key(season, lang)), "title": f"{name} {LANG_TAG[lang]}", "name": name,
            "image": image, "lang": lang, "season": season, "variants": variants,
            "langs": langs, "lang_urls": {l: series_url(parsed[1], key(season, l)) for l in ("dub", "sub")}, "items": items}


def fetch_episode(url: str) -> dict:
    """{"url", "title", "series_url", "image", "embeddable"}"""
    canonical = canonical_episode_url(url)
    if not canonical:
        raise ValueError("ไม่ใช่ลิงก์ตอนของ AnimeRuka")
    soup = BeautifulSoup(_get(canonical).text, "html.parser")
    title = _meta(soup, "og:title") or (soup.title.get_text(strip=True) if soup.title else "")
    title = re.split(r"\s+-\s+AnimeRuka", title, flags=re.I)[0].strip()
    series = next((canonical_series_url(urljoin(canonical, a["href"])) for a in soup.select("a[href*='/anime/']")
                   if canonical_series_url(urljoin(canonical, a["href"]))), None)
    return {"url": canonical, "title": title, "series_url": series, "image": _image(soup, canonical),
            "embeddable": bool(soup.select("#playeroptionsul li[data-post]"))}


def _ok_ru_alive(url: str) -> bool:
    """ok.ru ที่ถูกลบยังตอบ 200 แต่หน้าเขียน "Видео не найдено" — เช็คก่อนเลือก (โฮสต์ ok.ru เท่านั้น)"""
    if (urlsplit(url).hostname or "").lower() not in ("ok.ru", "www.ok.ru"):
        return False
    try:
        resp = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT, allow_redirects=False)
    except requests.RequestException:
        return False
    return resp.status_code == 200 and "не найдено" not in resp.text


def player_url(url: str) -> str:
    """ลิงก์ตัวเล่นที่ฝังในแอปได้ของตอนนี้ — ถามทุกตัวเลือก (หลัก/สำรอง) แล้วเลือกตามโฮสต์ที่ฝังได้"""
    canonical = canonical_episode_url(url)
    if not canonical:
        raise ValueError("ลิงก์ตอนของ AnimeRuka ไม่ถูกต้อง")
    soup = BeautifulSoup(_get(canonical).text, "html.parser")
    found = []
    for li in soup.select("#playeroptionsul li[data-post]")[:6]:
        post, kind, nume = li.get("data-post", ""), li.get("data-type", ""), li.get("data-nume", "")
        if not (post.isdigit() and re.fullmatch(r"[a-z]{2,10}", kind) and nume.isdigit()):
            continue
        try:
            data = json.loads(_get(f"https://{HOST}/wp-json/dooplayer/v2/{post}/{kind}/{nume}").text)
        except (ValueError, json.JSONDecodeError):
            continue
        embed = str(data.get("embed_url") or "")
        host = (urlsplit(embed).hostname or "").lower() if embed.startswith("https://") else ""
        if host and host not in NO_EMBED_HOSTS:
            found.append((host, embed))
    rank = {h: i for i, h in enumerate(PREFERRED_HOSTS)}
    for host, embed in sorted(found, key=lambda x: rank.get(x[0].removeprefix("www."), len(rank))):
        if host.removeprefix("www.") == "ok.ru" and not _ok_ru_alive(embed):
            continue
        return embed
    raise ValueError("ตอนนี้ไม่มีตัวเล่นที่ฝังในแอปได้ (ตัวหลักของเว็บห้ามฝัง ตัวสำรองไม่มีวิดีโอ)")


class Provider:
    """adapter ของ streams — ข้อมูลเรื่อง/ตอนจากฟังก์ชันข้างบน, เล่นด้วยการฝังตัวเล่นสำรองที่ฝังได้"""
    name = "animeruka"

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
            raise streams.StreamError(streams.EPISODE_LIST_FAILED, "ไม่พบรายชื่อตอน")
        return items

    @staticmethod
    def get_episode_metadata(url: str) -> dict:
        try:
            return fetch_episode(url)
        except ValueError as e:
            raise streams.StreamError(streams.PLAYER_INFO_MISSING, str(e)) from None

    @staticmethod
    def resolve_playback(video: dict, ctx: dict) -> dict:
        url = canonical_episode_url(video.get("source_url") or "")
        if not url:
            raise streams.StreamError(streams.PLAYER_INFO_MISSING, "ลิงก์ตอนของ AnimeRuka ไม่ถูกต้อง")
        try:
            src = player_url(url)
        except ValueError as e:
            raise streams.StreamError(streams.STREAM_RESOLUTION_FAILED, str(e), retryable=True) from None
        return {"kind": "embed", "url": src, "expires_at": None, "frame": None, "referrer": "none"}


streams.register(Provider())
