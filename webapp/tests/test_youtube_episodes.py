"""youtube.episode_numbers: แก้เลขตอนรวมที่ช่องพิมพ์ผิด โดยเทียบกับเลขในซีซั่นของตอนอื่น"""
import unittest

from sandbox import load


def spy(n_total, n_season):
    return f"[พากย์ไทย] SPY×FAMILY - ตอนที่ {n_total} (S3 ตอนที่ {n_season:02d})"


class EpisodeNumbersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.yt = load().app.youtube

    def test_typo_in_total_fixed_from_season_number(self):
        # เจอจริง: S3 ตอนที่ 13 ช่องเขียน "ตอนที่ 49" ซ้ำกับตอน 12
        titles = [spy(37 + k, k) for k in range(1, 13)] + [spy(49, 13)]
        nums = self.yt.episode_numbers(titles)
        self.assertEqual(nums[-1], 50)
        self.assertEqual(nums[:12], [float(37 + k) for k in range(1, 13)])

    def test_plain_titles_unchanged(self):
        titles = [f"เรื่อง - ตอนที่ {k}" for k in range(1, 6)]
        self.assertEqual(self.yt.episode_numbers(titles), [1.0, 2.0, 3.0, 4.0, 5.0])

    def test_too_few_to_trust(self):
        # มีแค่ 2 ตอนที่บอกเลขในซีซั่น ยังไม่พอจะเชื่อว่าเป็นรูปแบบ — ไม่แก้
        titles = [spy(38, 1), spy(40, 2)]
        self.assertEqual(self.yt.episode_numbers(titles), [38.0, 40.0])

    def test_season_only_numbering_untouched(self):
        # ชื่อมีแต่ "S2 ตอนที่ n" (เลขรวม = เลขในซีซั่น) ไม่ใช่กรณีพิมพ์ผิด
        titles = [f"เรื่อง S2 ตอนที่ {k}" for k in range(1, 6)]
        self.assertEqual(self.yt.episode_numbers(titles), [1.0, 2.0, 3.0, 4.0, 5.0])


if __name__ == "__main__":
    unittest.main()
