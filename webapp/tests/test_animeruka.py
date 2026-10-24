"""animeruka: ลิงก์เรื่อง/ตอน, บล็อกภาค+ภาษา, เลือกตัวเล่นที่ฝังได้ — ไม่ใช้เน็ต"""
import json
import unittest
from unittest import mock

from sandbox import load

SERIES = """<html><head><meta property='og:image' content='https://image.tmdb.org/t/p/w780/x.jpg'/>
<meta property="og:image" content="https://animeruka.com/wp-content/uploads/2026/06/x.jpg" />
<meta property="og:title" content="Rakudai Kenja ปราชญ์ตกชั้น ซับไทย และ พากย์ไทย จบแล้ว - AnimeRuka" /></head><body><div id="seasons">
<div class="se-c"><div class="se-q">ภาค1 Sage</div><ul class="episodios">
<li><div class="numerando">ตอนที่ 1</div><div class="episodiotitle"><a href="https://animeruka.com/ep/rk-ep-1/">Rakudai ตอนที่ 1 ซับไทย</a></div></li>
<li><div class="numerando">ตอนที่ 2</div><div class="episodiotitle"><a href="https://animeruka.com/ep/rk-ep-2/">Rakudai ตอนที่ 2 ซับไทย จบ</a></div></li></ul></div>
<div class="se-c"><div class="se-q">ภาค1 Sage</div><ul class="episodios">
<li><div class="numerando">ตอนที่ 1</div><div class="episodiotitle"><a href="https://animeruka.com/ep/rk-thai-ep-1/">Rakudai ตอนที่ 1 พากย์ไทย</a></div></li></ul></div>
<div class="se-c"><div class="se-q">ภาค2 Sage</div><ul class="episodios">
<li><div class="numerando">ตอนที่ 1</div><div class="episodiotitle"><a href="https://animeruka.com/ep/rk-2-ep-1/">Rakudai 2 ตอนที่ 1 ซับไทย</a></div></li></ul></div>
</div></body></html>"""
EP = """<ul id="playeroptionsul"><li data-post="44761" data-type="tv" data-nume="1">หลัก</li>
<li data-post="44761" data-type="tv" data-nume="2">สำรอง1</li><li data-post="44761" data-type="tv" data-nume="3">สำรอง2</li></ul>"""


class Resp:
    def __init__(self, text, status=200):
        self.text, self.content, self.status_code = text, text.encode(), status


class AnimeRukaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = load().app
        cls.a = cls.app.animeruka

    def test_parse_url(self):
        a = self.a
        self.assertEqual(a.parse_url("https://animeruka.com/anime/rk/#sub-2"), ("series", "rk", "sub-2"))
        self.assertEqual(a.parse_url("https://animeruka.com/ep/rk-thai-ep-2/"), ("episode", "rk-thai-ep-2", None))
        for bad in ("https://animeruka.com/tag/rk/", "https://evil.com/anime/rk/", "https://animeruka.com:81/anime/rk/"):
            self.assertIsNone(a.parse_url(bad), bad)
        self.assertEqual(self.app._ep_site("https://animeruka.com/ep/rk-ep-1/")[0], "animeruka")

    def test_series_blocks(self):
        with mock.patch.object(self.a, "_get", return_value=Resp(SERIES)):
            latest = self.a.fetch_series("https://animeruka.com/anime/rk/")
            s1dub = self.a.fetch_series("https://animeruka.com/anime/rk/#dub-1")
        self.assertEqual((latest["season"], latest["lang"], len(latest["items"])), (2, "sub", 1))  # ภาคล่าสุด ไม่มีพากย์ = ซับ
        self.assertEqual([v["key"] for v in latest["variants"]], ["dub-1", "sub-1", "sub-2"])
        self.assertEqual(s1dub["items"][0]["url"], "https://animeruka.com/ep/rk-thai-ep-1/")
        self.assertEqual(self.app.youtube.detect_lang(s1dub["items"][0]["title"]), "dub")
        self.assertEqual(latest["image"], "https://animeruka.com/wp-content/uploads/2026/06/x.jpg")  # ไม่ใช้รูป TMDB
        self.assertEqual(self.a.series_name("Rakudai Kenja ปราชญ์ตกชั้น ซับไทย และ พากย์ไทย จบแล้ว - AnimeRuka"),
                         "Rakudai Kenja ปราชญ์ตกชั้น")

    def test_player_skips_unembeddable_and_dead(self):
        api = {"1": "https://animemami.xyz/v/a", "2": "https://ok.ru/videoembed/1", "3": "https://abyssplayer.com/b"}

        def get(url, host_check=True):
            if "/wp-json/" in url:
                return Resp(json.dumps({"embed_url": api[url.rstrip("/").rsplit("/", 1)[1]], "type": "iframe"}))
            return Resp(EP)
        with mock.patch.object(self.a, "_get", side_effect=get),                 mock.patch.object(self.a, "mami_playlist_url", side_effect=ValueError("ปิด")):
            self.assertEqual(self.a.player_url("https://animeruka.com/ep/rk-ep-1/"), "https://abyssplayer.com/b")
            api["3"] = "https://animemami.xyz/v/c"
            with mock.patch.object(self.a, "_ok_ru_alive", return_value=False):
                with self.assertRaises(ValueError):
                    self.a.player_url("https://animeruka.com/ep/rk-ep-1/")
            with mock.patch.object(self.a, "_ok_ru_alive", return_value=True):
                self.assertEqual(self.a.player_url("https://animeruka.com/ep/rk-ep-1/"), "https://ok.ru/videoembed/1")


    def test_primary_hls_and_playlist_rewrite(self):
        api = {"1": "https://animemami.xyz/v/a", "2": "https://abyssplayer.com/b", "3": "https://abyssplayer.com/c"}

        def get(url, host_check=True):
            if "/wp-json/" in url:
                return Resp(json.dumps({"embed_url": api[url.rstrip("/").rsplit("/", 1)[1]], "type": "iframe"}))
            return Resp(EP)
        page = Resp('<div id="app" data-page="{&quot;props&quot;:{&quot;video&quot;:{&quot;url&quot;:'
                    '&quot;https://cdn2.maimeorder.com/hls/abc.txt&quot;}}}"></div>')
        with mock.patch.object(self.a, "_get", side_effect=get), mock.patch.object(self.a, "_fetch_ext", return_value=page):
            self.assertEqual(self.a._choose_player("https://animeruka.com/ep/rk-ep-1/"),
                             ("hls", "https://cdn2.maimeorder.com/hls/abc.txt", "https://abyssplayer.com/b"))
            pb = self.a.Provider.resolve_playback({"id": "v1", "source_url": "https://animeruka.com/ep/rk-ep-1/"}, {})
        self.assertEqual((pb["kind"], pb["url"], pb["alt"]["url"]), ("hls", "/api/videos/v1/stream.m3u8", "https://abyssplayer.com/b"))
        self.assertEqual(self.app.streams._normalize(pb, "animeruka")["alt"]["referrer"], "none")
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nlow.txt\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhigh.txt\n"
        media = "#EXTM3U\n#EXTINF:10,\nblob/x-000.webp\n#EXT-X-ENDLIST\n"
        with mock.patch.object(self.a, "_fetch_ext", side_effect=[Resp(master), Resp(media)]) as fx:
            out = self.a.playlist_text("https://cdn2.maimeorder.com/hls/abc.txt")
        self.assertEqual(fx.call_args_list[1].args[0], "https://cdn2.maimeorder.com/hls/high.txt")  # ความละเอียดสูงสุด
        self.assertIn("https://cdn2.maimeorder.com/hls/blob/x-000.webp", out)
        with mock.patch.object(self.a, "_fetch_ext", return_value=Resp("#EXTM3U\n#EXTINF:10,\nhttps://evil.example/x.ts\n")):
            with self.assertRaises(ValueError):
                self.a.playlist_text("https://cdn2.maimeorder.com/hls/abc.txt")


if __name__ == "__main__":
    unittest.main()
