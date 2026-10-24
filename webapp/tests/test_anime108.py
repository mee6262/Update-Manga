"""anime108: แยกลิงก์เรื่อง/ตอน + ภาษา (#dub/#sub), ชื่อเรื่อง, รายชื่อตอนสองภาษา, ลิงก์ตัวเล่น — ไม่ใช้เน็ต"""
import unittest
from unittest import mock

from sandbox import load

PAGE = """<html><head><meta property="og:title" content="Mushoku Tensei 3 เกิดชาตินี้พี่ต้องเทพ พากย์ไทย ซับไทย EP 9 พากย์ไทย ซับไทย ">
<meta property="og:image" content="https://www.anime108.com/wp-content/uploads/2026/07/x.jpg"></head><body>
<span class="halim-btn" data-post-id="28335" data-server="1"></span>
<select name="Sequel_select2"><option value="https://www.anime108.com/mushoku-tensei-3/">เลือก</option>
<option value="https://www.anime108.com/mushoku-tensei/">ภาค 1</option></select>
<select id="sequel_select_th"><option value="/mushoku-tensei-3-ep-1/"> ตอนที่ 1</option><option value="/mushoku-tensei-3-ep-2/"> ตอนที่ 2</option></select>
<select id="sequel_select_en"><option value="/mushoku-tensei-3-ep-1/"> ตอนที่ 1</option><option value="/mushoku-tensei-3-ep-2/"> ตอนที่ 2</option>
<option value="/mushoku-tensei-3-ep-3/"> ตอนที่ 3</option></select>
<script>halim_cfg.episode = 9</script></body></html>"""


class Resp:
    def __init__(self, text):
        self.text, self.content, self.status_code = text, text.encode(), 200


class Anime108Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = load().app
        cls.a = cls.app.anime108

    def test_parse_url(self):
        a = self.a
        self.assertEqual(a.parse_url("https://www.anime108.com/mushoku-tensei-3-ep-9/"), ("episode", "mushoku-tensei-3-ep-9", None))
        self.assertEqual(a.parse_url("https://anime108.com/da-zhu-zai-2/#sub"), ("series", "da-zhu-zai-2", "sub"))
        for bad in ("https://www.anime108.com/wp-json/", "https://evil.com/x/", "https://www.anime108.com:8080/x/",
                    "https://u:p@www.anime108.com/x/", "ftp://www.anime108.com/x/"):
            self.assertIsNone(a.parse_url(bad), bad)
        # ภาษาอยู่ในลิงก์ → ตอนเดียวกันคนละภาษาเป็นคนละตอนในคลัง
        dub = a.canonical_episode_url("https://www.anime108.com/x-ep-1/#dub")
        sub = a.canonical_episode_url("https://www.anime108.com/x-ep-1/#sub")
        self.assertNotEqual(self.app._anifume_key(dub), self.app._anifume_key(sub))
        self.assertEqual(self.app._ep_site(dub)[0], "anime108")

    def test_series_name(self):
        n = self.a.series_name
        self.assertEqual(n("Mushoku Tensei 3 เกิดชาตินี้พี่ต้องเทพ พากย์ไทย ซับไทย EP 9 พากย์ไทย ซับไทย "), "Mushoku Tensei 3 เกิดชาตินี้พี่ต้องเทพ")
        self.assertEqual(n("เกิดใหม่ทั้งทีก็เป็นสไลม์ไปซะแล้ว ภาค 4 ซับไทย %"), "เกิดใหม่ทั้งทีก็เป็นสไลม์ไปซะแล้ว ภาค 4")

    def test_fetch_series_two_langs(self):
        with mock.patch.object(self.a, "_request", return_value=Resp(PAGE)):
            dub = self.a.fetch_series("https://www.anime108.com/mushoku-tensei-3-ep-9/")
            sub = self.a.fetch_series("https://www.anime108.com/mushoku-tensei-3-ep-9/#sub")
        self.assertEqual(dub["url"], "https://www.anime108.com/mushoku-tensei-3/#dub")
        self.assertEqual(dub["langs"], {"dub": 2, "sub": 3})
        self.assertEqual([i["url"] for i in dub["items"]], ["https://www.anime108.com/mushoku-tensei-3-ep-1/#dub",
                                                            "https://www.anime108.com/mushoku-tensei-3-ep-2/#dub"])
        self.assertEqual(len(sub["items"]), 3)
        self.assertEqual(self.app.youtube.parse_episode(sub["items"][2]["title"]), 3.0)
        self.assertEqual(self.app.youtube.detect_lang(sub["items"][0]["title"]), "sub")
        self.assertTrue(dub["image"])

    def test_player_url_only_known_host(self):
        ok = '<div><iframe src="https://main.108player.com/index_th.php?id=abc"></iframe></div>'
        evil = '<div><iframe src="https://evil.example/x"></iframe></div>'
        for body, expect in ((ok, "https://main.108player.com/index_th.php?id=abc"), (evil, None)):
            with mock.patch.object(self.a, "_request", side_effect=[Resp(PAGE), Resp(body)]) as req:
                if expect:
                    self.assertEqual(self.a.player_url("https://www.anime108.com/mushoku-tensei-3-ep-9/#sub"), expect)
                    sent = req.call_args_list[1].kwargs["data"]
                    self.assertEqual((sent["lang"], sent["postid"], sent["episode"]), ("Sound Track", "28335", "9"))
                else:
                    with self.assertRaises(ValueError):
                        self.a.player_url("https://www.anime108.com/mushoku-tensei-3-ep-9/#sub")


PID = "883d7a602a0fb04d7345c3f8"
MASTER = f"""#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=480x360
/m3u8/{PID}/{PID}168.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
/m3u8/{PID}/{PID}438.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1
https://evil.example/x.m3u8
"""
VARIANT = """#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5.0,
https://www.data26092026.online/file/hls2/a_1080/a-0.webp?s=m01
#EXTINF:5.0,
https://www.data26092026.online/file/hls2/a_1080/a-1.webp?s=m01
#EXT-X-ENDLIST
"""


class Anime108ProxyTest(unittest.TestCase):
    """ตั้ง Worker (VIDEO_PROXY_URL/KEY) แล้วเล่นในตัวเล่นแอป: ไฟล์รายการผ่านเซิร์ฟเวอร์ ท่อนผ่าน Worker ที่เซ็นลิงก์"""
    VIDEO = {"id": "v1", "provider": "anime108", "source_url": "https://www.anime108.com/mushoku-tensei-3-ep-9/#dub"}
    ENV = {"VIDEO_PROXY_URL": "https://p.example.workers.dev/", "VIDEO_PROXY_KEY": "k3y"}

    @classmethod
    def setUpClass(cls):
        cls.a = load().app.anime108

    def setUp(self):
        self.a._streams.clear()

    def test_no_proxy_stays_embed(self):
        with mock.patch.dict("os.environ", {"VIDEO_PROXY_URL": "", "VIDEO_PROXY_KEY": ""}), \
             mock.patch.object(self.a, "player_url", return_value=f"https://main.108player.com/index_th.php?id={PID}"):
            pb = self.a.Provider.resolve_playback(self.VIDEO, {})
        self.assertEqual(pb["kind"], "embed")

    def test_proxy_hls_with_embed_alt(self):
        with mock.patch.dict("os.environ", self.ENV), \
             mock.patch.object(self.a, "player_url", return_value=f"https://main.108player.com/index_th.php?id={PID}"):
            pb = self.a.Provider.resolve_playback(self.VIDEO, {})
        self.assertEqual((pb["kind"], pb["url"]), ("hls", "/api/videos/v1/stream.m3u8"))
        self.assertEqual(pb["alt"]["kind"], "embed")
        self.assertEqual(self.a._streams["v1"][1], PID)

    def test_master_points_back_to_server_known_host_only(self):
        self.a._streams["v1"] = (9e12, PID)
        with mock.patch.dict("os.environ", self.ENV), mock.patch.object(self.a, "_request", return_value=Resp(MASTER)):
            text = self.a.stream_playlist(self.VIDEO, None)
        self.assertIn("/api/videos/v1/stream.m3u8?v=0", text)
        self.assertIn("/api/videos/v1/stream.m3u8?v=1", text)
        self.assertNotIn("evil", text)  # ความละเอียดนอก main.108player.com ทิ้ง
        self.assertNotIn("?v=2", text)

    def test_variant_segments_signed_for_worker(self):
        import hashlib, hmac
        from urllib.parse import parse_qs, urlsplit
        self.a._streams["v1"] = (9e12, PID)
        with mock.patch.dict("os.environ", self.ENV), \
             mock.patch.object(self.a, "_request", side_effect=[Resp(MASTER), Resp(VARIANT)]) as req:
            text = self.a.stream_playlist(self.VIDEO, "1")
        self.assertTrue(req.call_args_list[1].args[1].endswith(f"{PID}438.m3u8"))  # ?v=1 = 1080p
        segs = [l for l in text.splitlines() if l and not l.startswith("#")]
        self.assertEqual(len(segs), 2)
        self.assertIn("#EXT-X-ENDLIST", text)
        for i, seg in enumerate(segs):
            parts = urlsplit(seg)
            self.assertEqual((parts.scheme, parts.hostname, parts.path), ("https", "p.example.workers.dev", "/s"))
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}
            self.assertEqual(q["u"], f"https://www.data26092026.online/file/hls2/a_1080/a-{i}.webp?s=m01")
            want = hmac.new(b"k3y", f"{q['e']}\n{q['u']}".encode(), hashlib.sha256).hexdigest()[:32]
            self.assertEqual(q["k"], want)  # สูตรเดียวกับ tools/video-proxy-worker.js

    def test_bad_variant_and_empty_playlist(self):
        self.a._streams["v1"] = (9e12, PID)
        with mock.patch.dict("os.environ", self.ENV):
            for v in ("9", "x", "-1"):
                with mock.patch.object(self.a, "_request", return_value=Resp(MASTER)), self.assertRaises(ValueError):
                    self.a.stream_playlist(self.VIDEO, v)
            # User-Agent iPhone ได้ไฟล์ว่าง / เว็บเปลี่ยนวิธี → error ให้หน้าเว็บสลับไปตัวฝัง
            with mock.patch.object(self.a, "_request", side_effect=[Resp(MASTER), Resp("")]), self.assertRaises(ValueError):
                self.a.stream_playlist(self.VIDEO, "0")


if __name__ == "__main__":
    unittest.main()
