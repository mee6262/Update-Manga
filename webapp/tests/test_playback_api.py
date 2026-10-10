"""/api/videos/<id>/playback + PUBLIC_ORIGIN + adapter ของ Anifume/037-anime (ไม่ใช้เน็ต) + ความเข้ากันได้กับคลิปเดิม"""
import unittest

from sandbox import client, load

EP = "https://anifume.com/41390/D-cbMjn5OpzlsFXvRynVsA"
S037 = "https://037-anime.com/serie/black-clover/"
BASE = {"external": False, "added_by": "boss", "created_at": "2026-01-01T00:00:00+00:00"}
VIDEOS = [
    {**BASE, "id": "af1", "canonical_key": "af1", "title": "af", "provider": "anifume", "source_url": EP},
    {**BASE, "id": "af2", "canonical_key": "af2", "title": "blocked", "provider": "anifume", "source_url": EP, "external": True},
    {**BASE, "id": "afbad", "canonical_key": "afbad", "title": "<img src=x onerror=alert(1)>", "provider": "anifume",
     "source_url": "https://evil.example/41390/AAAAAAAAAA"},
    {**BASE, "id": "a037", "canonical_key": "a037", "title": "bc", "provider": "a037", "source_url": S037, "episode_ref": "8307"},
    # คลิปเดิมก่อนมีฟิลด์ใหม่ (ไม่มี provider / source_url / resolver)
    {**BASE, "id": "fb1", "canonical_key": "fb1", "title": "fb", "facebook_url": "https://www.facebook.com/reel/1"},
    {**BASE, "id": "yt1", "canonical_key": "yt1", "title": "yt", "facebook_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
     "provider": "youtube", "youtube_id": "dQw4w9WgXcQ"},
]


class PlaybackApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()
        cls.m.storage.save_videos(VIDEOS)
        cls.admin = client(cls.m)
        cls.member = client(cls.m, "member", "pw-member-1")
        cls.anon = client(cls.m, None)

    def setUp(self):
        self.m.streams.clear()
        self.m.app.PUBLIC_ORIGIN = ""
        self.seen = []
        a037 = self.m.a037
        self._orig = (a037.get_player_servers, a037.check_origin)
        a037.get_player_servers = lambda ep: [{"lang": "dub", "name": "main", "url": "https://player.example/video/abc"}]
        a037.check_origin = lambda url, origin: self.seen.append(origin) or "037-anime.com" in origin

    def tearDown(self):
        self.m.a037.get_player_servers, self.m.a037.check_origin = self._orig

    def play(self, vid, c=None, **kw):
        r = (c or self.admin).get(f"/api/videos/{vid}/playback", **kw)
        return r.status_code, r.get_json()

    # ---------- สัญญา API ----------
    def test_anifume_page_embed(self):
        status, d = self.play("af1")
        self.assertEqual(status, 200)
        self.assertEqual((d["kind"], d["url"], d["frame"], d["fallback_url"]), ("page_embed", EP + "#vpfi", {"pad": 12, "max": 854}, EP))
        self.assertEqual(self.play("af1", self.member)[0], 200)

    def test_error_shape(self):
        for vid, c, status, code in [("af2", None, 422, "PROVIDER_RESTRICTION"), ("afbad", None, 502, "PLAYER_INFO_MISSING"),
                                     ("fb1", None, 400, "PLAYBACK_UNSUPPORTED"), ("nope", None, 404, "VIDEO_NOT_FOUND"),
                                     ("af1", self.anon, 401, "UNAUTHORIZED")]:
            got, d = self.play(vid, c)
            self.assertEqual((got, d.get("code")), (status, code), vid)
            self.assertIn("error", d)
        self.assertIsNone(self.play("afbad")[1]["fallback_url"])  # ลิงก์ที่ถูกแก้ชี้โดเมนอื่น → ไม่ให้ลิงก์

    # ---------- PUBLIC_ORIGIN ----------
    def test_parse_public_origin(self):
        p = self.m.app.parse_public_origin
        self.assertEqual(p(" https://Manga.Example.com/ "), "https://manga.example.com")
        self.assertEqual(p("http://localhost:5050"), "http://localhost:5050")
        for bad in ["", None, "manga.example.com", "ftp://x.com", "https://x.com/path", "https://u:p@x.com",
                    "https://x.com?a=1", "https://x.com#f", "https://x.com:99999", "javascript:alert(1)"]:
            self.assertEqual(p(bad), "", bad)

    def test_no_origin_no_probe(self):
        status, d = self.play("a037")
        self.assertEqual((status, d["code"]), (422, "PROVIDER_RESTRICTION"))
        self.assertIn("PUBLIC_ORIGIN", d["error"])
        self.assertEqual(self.seen, [])

    def test_request_host_never_used_as_origin(self):
        m = self.m
        with m.app.app.test_request_context("/api/videos/a037/playback", headers={"Host": "037-anime.com"}):
            m.app.session["user"] = "boss"
            resp, status = m.app.get_video_playback("a037")
        self.assertEqual((status, self.seen), (422, []))
        m.streams.clear()
        m.app.PUBLIC_ORIGIN = "https://manga.example.com"
        with m.app.app.test_request_context("/api/videos/a037/playback", headers={"Host": "037-anime.com"}):
            m.app.session["user"] = "boss"
            resp, status = m.app.get_video_playback("a037")
        self.assertEqual((status, self.seen), (422, ["https://manga.example.com"]))

    def test_provider_own_domain_refused(self):
        self.m.app.PUBLIC_ORIGIN = "https://www.037-anime.com"
        status, d = self.play("a037")
        self.assertEqual((status, d["code"], self.seen), (422, "PROVIDER_RESTRICTION", []))

    def test_refresh_limit_via_api(self):
        for _ in range(self.m.streams.MAX_REFRESHES):
            self.assertEqual(self.play("af1", query_string={"refresh": "1"})[0], 200)
        status, d = self.play("af1", query_string={"refresh": "1"})
        self.assertEqual((status, d["code"]), (502, "STREAM_EXPIRED"))
        self.assertEqual(self.play("af1", self.member, query_string={"refresh": "1"})[0], 200)  # คนอื่นไม่โดน

    # ---------- URL ของแหล่ง ----------
    def test_provider_url_validation(self):
        a, v = self.m.anifume.parse_url, self.m.a037.validate_series_url
        self.assertEqual(a(EP), ("episode", "41390", "D-cbMjn5OpzlsFXvRynVsA"))
        self.assertEqual(v("http://www.037-anime.com/serie/black-clover?x=1"), S037)
        for bad in ["https://anifume.com.evil.com/41390/D-cbMjn5OpzlsFXvRynVsA", "https://anifume.com:8443/41390/D-cbMjn5OpzlsFXvRynVsA",
                    "https://u:p@anifume.com/41390/D-cbMjn5OpzlsFXvRynVsA", "http://[::1", None]:
            self.assertIsNone(a(bad), bad)
        for bad in ["https://037-anime.com.evil.com/serie/x/", "https://037-anime.com:8443/serie/x/", "https://u:p@037-anime.com/serie/x/",
                    "https://037-anime.com/serie/../x/", "https://037-anime.com/category/x/", None]:
            self.assertIsNone(v(bad), bad)
        with self.assertRaises(self.m.streams.StreamError):  # รหัสตอนไม่ใช่ตัวเลข → ไม่ยิงเน็ต
            self._orig[0]("8306; DROP")

    # ---------- ความเข้ากันได้ ----------
    def test_backward_compat(self):
        items = {v["id"]: v for v in self.admin.get("/api/videos").get_json()["items"]}
        self.assertEqual((items["fb1"]["provider"], items["fb1"]["resolver"], items["fb1"]["source_url"]),
                         ("facebook", False, "https://www.facebook.com/reel/1"))
        self.assertEqual((items["yt1"]["resolver"], items["yt1"]["youtube_id"]), (False, "dQw4w9WgXcQ"))
        self.assertTrue(items["af1"]["resolver"])
        self.assertNotIn("embed_url", items["af1"])
        self.assertEqual(self.admin.get("/api/videos/af1/sources").get_json(), {})
        self.assertEqual(self.admin.get("/api/videos/yt1/sources").get_json(), {})


if __name__ == "__main__":
    unittest.main()
