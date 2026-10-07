import unittest, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from odds_tool import parse
from tests import helpers as H


class TestParse(unittest.TestCase):
    def test_3t_rowspan_and_flat_are_identical_and_match_source(self):
        """2着の欄が rowspan でも、空のセルでも、同じ結果になり、実物の表と完全に一致する。"""
        rows = H.fixture_3t()
        exp = H.expected_3t(rows)
        a = parse.parse_page("3t", H.html_3t(rows, rowspan=True))["t3"]
        b = parse.parse_page("3t", H.html_3t(rows, rowspan=False))["t3"]
        self.assertEqual(len(a), 120)
        self.assertEqual(a, exp)
        self.assertEqual(b, exp)

    def test_3t_known_values(self):
        """実物の表(txt)を目で見て確認した値。(1着,2着,3着) → オッズ。"""
        a = parse.parse_page("3t", H.html_3t(H.fixture_3t()))["t3"]
        self.assertEqual(a[(1, 2, 3)], 25.3)     # 1行目、左端のブロック
        self.assertEqual(a[(1, 2, 6)], 18.0)     # 4行目
        self.assertEqual(a[(1, 6, 5)], 84.6)     # 最終行、左端のブロック
        self.assertEqual(a[(6, 1, 2)], 140.1)    # 1行目、右端のブロック
        self.assertEqual(a[(6, 1, 5)], 389.0)    # 4行目、右端のブロック
        self.assertEqual(a[(6, 5, 4)], 454.3)    # 最終行、右端のブロック
        self.assertEqual(a[(3, 4, 1)], 186.2)    # 9行目、3番目のブロック
        self.assertEqual(a[(5, 4, 2)], 580.8)    # 14行目、5番目のブロック
        self.assertEqual(a[(5, 4, 1)], 355.2)    # 13行目、5番目のブロック

    def test_2tf_normal(self):
        t2r, f2r = H.fixture_2tf("odds2tf_2026_mikuni_7R.txt")
        r = parse.parse_page("2tf", H.html_2tf(t2r, f2r))
        self.assertEqual(len(r["t2"]), 30)
        self.assertEqual(len(r["f2"]), 15)
        self.assertEqual(r["t2"], H.expected_2(t2r, False))
        self.assertEqual(r["f2"], H.expected_2(f2r, True))
        self.assertEqual(r["t2"][(1, 2)], 8.9)
        self.assertEqual(r["t2"][(6, 5)], 126.9)
        self.assertEqual(r["f2"][(1, 2)], 6.3)
        self.assertEqual(r["f2"][(5, 6)], 22.8)

    def test_2tf_absent_boat_becomes_none(self):
        """欠場の艇があるマスは None。残りは数値のまま。"""
        t2r, f2r = H.fixture_2tf("odds2tf_2023_absent_8R.txt")
        r = parse.parse_page("2tf", H.html_2tf(t2r, f2r))
        self.assertEqual(len(r["t2"]), 30)
        self.assertIsNone(r["t2"][(1, 5)])
        self.assertIsNone(r["t2"][(5, 1)])
        self.assertEqual(r["t2"][(1, 2)], 4.9)
        self.assertIsNone(r["f2"][(1, 5)])
        self.assertEqual(r["f2"][(1, 2)], 1.4)
        self.assertEqual(sum(1 for v in r["t2"].values() if v is not None), 20)

    def test_no_table(self):
        with self.assertRaises(parse.NoOddsTable):
            parse.parse_page("3t", "<html><body><p>データがありません</p></body></html>")
        with self.assertRaises(parse.NoOddsTable):
            parse.parse_page("2tf", "")

    def test_misread_number_is_caught_by_sum_check(self):
        """小数点の読み違い(25.3→2.5)を、逆数の合計の検査で検出できる。"""
        bad = [list(r) for r in H.fixture_3t()]
        bad[0][2] = "2.5"
        with self.assertRaises(parse.ParseError):
            parse.parse_page("3t", H.html_3t(bad))

    def test_missing_row_is_caught(self):
        with self.assertRaises(parse.ParseError):
            parse.parse_page("3t", H.html_3t(H.fixture_3t()[:-1]))

    def test_duplicate_is_caught(self):
        rows = [list(r) for r in H.fixture_3t()]
        rows[1][1] = "3"                         # (1,2,3) が2回
        with self.assertRaises(parse.ParseError):
            parse.parse_page("3t", H.html_3t(rows))

    def test_wrong_page_kind(self):
        t2r, f2r = H.fixture_2tf("odds2tf_2026_mikuni_7R.txt")
        with self.assertRaises(parse.NoOddsTable):
            parse.parse_page("3t", H.html_2tf(t2r, f2r))
        with self.assertRaises(parse.NoOddsTable):
            parse.parse_page("2tf", H.html_3t(H.fixture_3t()))

    def test_extra_noise_in_html(self):
        """メニューや広告の別の表、コメント、caption等が混ざっても、オッズの表だけを読む。"""
        h = H.html_3t(H.fixture_3t()).replace("<table", '<table summary="x"><!-- c --><caption>表</caption><colgroup><col></colgroup>', 1)
        h = '<nav><table><tr><td>1</td><td>メニュー</td></tr></table></nav>' + h + '<table><tr><td>広告</td></tr></table>'
        self.assertEqual(parse.parse_page("3t", h)["t3"], H.expected_3t(H.fixture_3t()))

    def test_comma_thousands(self):
        rows = [list(r) for r in H.fixture_3t()]
        self.assertEqual(rows[9][14], "1104")     # 実物: 10行目、5番目のブロックの3列目(1着5-2着3-3着2)
        rows[9][14] = "1,104"                     # 桁区切りのカンマがあっても、同じ値になる
        a = parse.parse_page("3t", H.html_3t(rows))["t3"]
        self.assertEqual(a[(5, 3, 2)], 1104.0)


if __name__ == "__main__":
    unittest.main()
