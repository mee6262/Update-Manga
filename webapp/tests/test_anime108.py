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


if __name__ == "__main__":
    unittest.main()
