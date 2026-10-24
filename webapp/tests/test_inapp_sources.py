"""เล่นในตัวเล่นแอปแทนการฝัง: Anifume (MP4 720p/360p), FairyAnime (HLS), ตัวช่วย streams.hls_playlist — ไม่ใช้เน็ต"""
import unittest
from unittest import mock

from sandbox import load

AF_EP = "https://anifume.com/41390/D-cbMjn5OpzlsFXvRynVsA"
AF_PAGE = """<div id="vpfi"></div><script>
function mainv() { $.ajax({ url: "/k49dF65fkfl2X0So2lFB06?u=MAIN%2Babc123456789", success: function(r) {} }); }
function mirp2() { $.ajax({ url: "/k49dF65fkfl2X0So2lFB06?u=MIRROR%2Bxyz987654321", success: function(r) {} }); }
</script>"""
AF_FRAG = ('<iframe src="https://anifume.com/player/s=a15&f=AbC&m=Xy&e=1792888624&q=1" allowfullscreen="" '
           'frameborder="0"></iframe>')
AF_PLAYER = """jwplayer("vpl").setup({ "playlist": [{ "sources": [{
  "file": "https://a15.rukoluo.com/f/X/X-04.mp4?m=zwt&e=1792889895", "label": "720p" }, {
  "file": "https://a15.rukoluo.com/f/X/X-04-q360.mp4?m=1kh&e=1792889000", "label": "360p", "default": "true" }] }] });"""

FA_BASE_NEW = """var webmainapp = 'https://streaming.tonytonychopper.com/';
function switch_play(v) {
    if (v == 0) { var url = webmainapp + "playback/f/FaxrFFDv/";} else {var url = webmainapp + "playback/v/FaxrFFDv/";}
}"""
FA_PLAYER = '<iframe src="https://anime.tonytonychopper.net/v2/jsAbeDWv" allowfullscreen></iframe>'
FA_MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
https://anime.tonytonychopper.net/quality2/jsAbeDWv/1080/
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1
https://evil.example/q.m3u8
"""
FA_VARIANT = """#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:3.0,
https://fa-new06.top/v1/segment/abc/1080p/1080p0.webp
#EXTINF:2.0,
1080p1.webp
#EXT-X-ENDLIST
"""


class Resp:
    def __init__(self, text):
        self.text, self.content, self.status_code = text, text.encode(), 200


class InAppSourcesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()
        cls.af = cls.m.anifume
        cls.fa = cls.m.app.fairyanime

    def setUp(self):
        self.fa._streams.clear()

    # ---------- Anifume ----------
    def test_anifume_file_sources(self):
        with mock.patch.object(self.af, "_get", side_effect=[Resp(AF_PAGE), Resp(AF_FRAG), Resp(AF_PLAYER)]) as get:
            src = self.af.file_sources(AF_EP)
        self.assertEqual(src["hd"], "https://a15.rukoluo.com/f/X/X-04.mp4?m=zwt&e=1792889895")
        self.assertEqual(src["sd"], "https://a15.rukoluo.com/f/X/X-04-q360.mp4?m=1kh&e=1792889000")
        self.assertEqual(src["expires_at"], 1792889000 - 300)  # หมดอายุตัวที่เร็วสุด เผื่อ 5 นาที
        ajax = get.call_args_list[1]
        self.assertIn("?u=MAIN", ajax.args[0])  # ตัวหลัก (mainv) ก่อนตัวสำรอง
        self.assertEqual(ajax.kwargs["headers"], {"Referer": AF_EP, "X-Requested-With": "XMLHttpRequest"})
        self.assertTrue(get.call_args_list[2].args[0].startswith("https://anifume.com/player/s=a15&f=AbC"))

    def test_anifume_single_quality_and_failures(self):
        one = '"file": "https://a.example/x.mp4?e=1792889000", "label": "720p"'
        with mock.patch.object(self.af, "_get", side_effect=[Resp(AF_PAGE), Resp(AF_FRAG), Resp(one)]):
            self.assertEqual(self.af.file_sources(AF_EP)["hd"], None)  # ไฟล์เดียว = sd ตัวเดียว (ปุ่มโชว์ความสูงจริง)
        for pages in ([Resp("<html></html>")], [Resp(AF_PAGE), Resp("")],
                      [Resp(AF_PAGE), Resp('<iframe src="https://evil.example/player/x"></iframe>')],
                      [Resp(AF_PAGE), Resp(AF_FRAG), Resp("no sources")]):
            with mock.patch.object(self.af, "_get", side_effect=pages), self.assertRaises(ValueError):
                self.af.file_sources(AF_EP)

    def test_anifume_get_only_own_host(self):
        with self.assertRaises(ValueError):
            self.af._get("https://evil.example/player/x")

    # ---------- FairyAnime ----------
    def test_fairyanime_player_url_new_base_page(self):
        with mock.patch.object(self.fa, "_get", return_value=Resp(FA_BASE_NEW)):
            self.assertEqual(self.fa.player_url("JsTY0pczKZ"), "https://streaming.tonytonychopper.com/playback/v/FaxrFFDv/")
        old = "var webmainapp = 'https://s.example/'; var slug = 'AbCd1234';"
        with mock.patch.object(self.fa, "_get", return_value=Resp(old)):
            self.assertEqual(self.fa.player_url("JsTY0pczKZ"), "https://s.example/playback/v/AbCd1234/")
        with mock.patch.object(self.fa, "_get", return_value=Resp("var webmainapp = 'https://s.example/'; var slug = 'null';")), \
             self.assertRaises(ValueError):
            self.fa.player_url("JsTY0pczKZ")

    def test_fairyanime_hls_with_embed_alt(self):
        video = {"id": "fa1", "provider": "fairyanime", "source_url": "https://fairyanime.net/watch/JsTY0pczKZ.html"}
        with mock.patch.object(self.fa, "_get", side_effect=[Resp(FA_BASE_NEW), Resp(FA_PLAYER)]):
            pb = self.fa.Provider.resolve_playback(video, {})
        self.assertEqual((pb["kind"], pb["url"]), ("hls", "/api/videos/fa1/stream.m3u8"))
        self.assertEqual(pb["alt"], {"kind": "embed", "url": "https://streaming.tonytonychopper.com/playback/v/FaxrFFDv/",
                                     "expires_at": None, "frame": None})
        self.assertEqual(self.fa._streams["fa1"][1], "https://anime.tonytonychopper.net/file2/jsAbeDWv/")
        # master: ความละเอียดชี้กลับมาที่เซิร์ฟเวอร์ ตัดโฮสต์แปลก; ไฟล์ย่อย: ท่อนเป็นลิงก์เต็มของ CDN (โหลดตรง CORS *)
        with mock.patch.object(self.fa, "_get", return_value=Resp(FA_MASTER)):
            master = self.fa.stream_playlist(video, None)
        self.assertIn("/api/videos/fa1/stream.m3u8?v=0", master)
        self.assertNotIn("?v=1", master)
        with mock.patch.object(self.fa, "_get", side_effect=[Resp(FA_MASTER), Resp(FA_VARIANT)]):
            text = self.fa.stream_playlist(video, "0")
        segs = [l for l in text.splitlines() if l and not l.startswith("#")]
        self.assertEqual(segs, ["https://fa-new06.top/v1/segment/abc/1080p/1080p0.webp",
                                "https://anime.tonytonychopper.net/quality2/jsAbeDWv/1080/1080p1.webp"])

    def test_fairyanime_no_hls_stays_embed(self):
        video = {"id": "fa2", "provider": "fairyanime", "source_url": "https://fairyanime.net/watch/JsTY0pczKZ.html"}
        with mock.patch.object(self.fa, "_get", side_effect=[Resp(FA_BASE_NEW), Resp("<html>no iframe</html>")]):
            self.assertEqual(self.fa.Provider.resolve_playback(video, {})["kind"], "embed")

    def test_fairyanime_unknown_player_host_not_fetched(self):
        video = {"id": "fa3", "provider": "fairyanime", "source_url": "https://fairyanime.net/watch/JsTY0pczKZ.html"}
        moved = FA_BASE_NEW.replace("streaming.tonytonychopper.com", "evil.example")
        with mock.patch.object(self.fa, "_get", side_effect=[Resp(moved)]) as get:
            self.assertEqual(self.fa.Provider.resolve_playback(video, {})["kind"], "embed")
        self.assertEqual(get.call_count, 1)  # ไม่ยิงหน้าตัวเล่นบนโฮสต์แปลก
        evil_v2 = '<iframe src="https://evil.example/v2/jsAbeDWv"></iframe>'
        with mock.patch.object(self.fa, "_get", side_effect=[Resp(FA_BASE_NEW), Resp(evil_v2)]):
            self.assertEqual(self.fa.Provider.resolve_playback(video, {})["kind"], "embed")

    def test_anifume_external_plays_file_without_embed(self):
        video = {"id": "afx", "provider": "anifume", "source_url": AF_EP, "external": True}
        with mock.patch.object(self.af, "file_sources", return_value={"hd": None, "sd": "https://a.example/x.mp4", "expires_at": None}):
            pb = self.af.Provider.resolve_playback(video, {})
        self.assertEqual((pb["kind"], pb["alt"]), ("file", None))
        with mock.patch.object(self.af, "file_sources", side_effect=ValueError("x")), \
             self.assertRaises(self.m.streams.StreamError):
            self.af.Provider.resolve_playback(video, {})

    # ---------- streams.hls_playlist ----------
    def test_hls_playlist_single_variant_and_rejects(self):
        hls = self.m.streams.hls_playlist
        fetch = {"https://h.example/m.m3u8": FA_VARIANT}.__getitem__
        self.assertIn("/own?v=0", hls("https://h.example/m.m3u8", fetch, "/own", None))  # ไม่มี STREAM-INF = ความละเอียดเดียว
        self.assertIn("https://h.example/1080p1.webp", hls("https://h.example/m.m3u8", fetch, "/own", "0"))
        for bad in ("<html>", "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:1,\na.ts\n",
                    "#EXTM3U\n#EXTINF:1,\nhttp://plain.example/a.ts\n"):
            with self.assertRaises(ValueError):
                hls("https://h.example/m.m3u8", lambda u, b=bad: b, "/own", "0")


if __name__ == "__main__":
    unittest.main()
