"""validate_against_payouts.py の単体テスト。合成データ(実在しない値)だけを使う。"""
import io, json, os, sys, tempfile, unittest, zipfile
sys.path.insert(0, os.path.dirname(__file__))
import validate_against_payouts as V

def make_zip(path, day, odds3, odds2, status):
    base = "%s-%s-%s" % (day[:4], day[4:6], day[6:])
    z = zipfile.ZipFile(path, "w")
    z.writestr(base + "/odds_3t.csv", "stadium,race,first,second,third,odds\n" + "".join("%d,%d,%d,%d,%d,%s\n" % (k + (("" if v is None else v),)) for k, v in odds3.items()))
    z.writestr(base + "/odds_2t.csv", "stadium,race,first,second,odds\n" + "".join("%d,%d,%d,%d,%s\n" % (k + (("" if v is None else v),)) for k, v in odds2.items()))
    z.writestr(base + "/races.csv", "stadium,race,status_3t,status_2tf,note\n" + "".join("%d,%d,%s,%s,\n" % (j, r, a, b) for (j, r), (a, b) in status.items()))
    z.close()

def api_json(races):
    st = {}
    for (j, r), (t3, x2) in races.items():
        st.setdefault(str(j), {"races": {}})["races"][str(r)] = {"result": {"payouts": {
            "trifecta": [{"combination": "-".join(map(str, c)), "amount": a} for c, a in t3],
            "exacta": [{"combination": "-".join(map(str, c)), "amount": a} for c, a in x2]}}}
    return {"programs": {"stadiums": st}}

class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.day = "20260305"
    def run_check(self, odds3, odds2, status, races):
        zp = os.path.join(self.d, "x.zip"); make_zip(zp, self.day, odds3, odds2, status)
        zf = zipfile.ZipFile(zp)
        return V.check_day(V.load_odds(zf, self.day), V.payouts_from_openapi(api_json(races), self.day))

    def test_match_and_detects_order_of_magnitude_and_swap(self):
        """3レース: ①正しい ②当たった組のオッズが桁違い(25.3→2.53) ③行の取り違え(当たった組 4-1-3 に、隣の組 4-3-1 の値が入っている)"""
        odds3 = {(19, 8, 1, 3, 2): 6.8,                       # ① 6.8倍 = 680円 ✓
                 (19, 9, 1, 2, 3): 2.53,                      # ② 実際は 25.3倍(2530円)なのに 2.53 と読んだ
                 (2, 1, 4, 1, 3): 30.4, (2, 1, 4, 3, 1): 9.9}  # ③ 当たりは 4-1-3(9.9倍=990円)なのに、4-1-3 に 30.4 が入り、4-3-1 に 9.9 が入っている
        odds2 = {(19, 8, 1, 3): 3.8, (19, 9, 1, 2): 25.3, (2, 1, 4, 3): 12.9}
        status = {(19, 8): ("ok", "ok"), (19, 9): ("ok", "ok"), (2, 1): ("ok", "ok")}
        races = {(19, 8): ([((1, 3, 2), 680)], [((1, 3), 380)]),
                 (19, 9): ([((1, 2, 3), 2530)], [((1, 2), 2530)]),
                 (2, 1): ([((4, 1, 3), 990)], [((4, 3), 1290)])}
        r = self.run_check(odds3, odds2, status, races)
        self.assertEqual(r["3t"]["ok"], 1)                                                                   # ①だけ一致
        self.assertEqual(sorted((x[0], x[1]) for x in r["3t"]["ng"]), [(2, 1), (19, 9)])                     # ②桁違い と ③取り違え を、両方検出
        self.assertEqual(r["2t"]["ok"], 3); self.assertEqual(len(r["2t"]["ng"]), 0)                          # 2連単は3つとも正しい

    def test_skips_unreadable_refund_and_dead_heat(self):
        odds3 = {(19, 8, 1, 3, 2): 6.8}
        status = {(19, 8): ("ok", "ok"), (19, 9): ("parse_error", "no_data"), (19, 10): ("ok", "ok"), (19, 11): ("ok", "ok")}
        races = {(19, 8): ([((1, 3, 2), 680)], []), (19, 9): ([((1, 2, 3), 500)], [((1, 2), 300)]),
                 (19, 10): ([], []),                                                           # 払戻なし(不成立・全額返還)
                 (19, 11): ([((1, 2, 3), 500), ((1, 3, 2), 600)], [])}                          # 同着で複数
        r = self.run_check(odds3, {}, status, races)
        self.assertEqual((r["3t"]["ok"], len(r["3t"]["ng"]), r["3t"]["skip"]), (1, 0, 3))

    def test_empty_cell_is_reported(self):
        odds3 = {(19, 8, 1, 3, 2): None}                                                       # 欠場で空欄のはずなのに、当たった組が空欄=異常
        r = self.run_check(odds3, {}, {(19, 8): ("ok", "ok")}, {(19, 8): ([((1, 3, 2), 680)], [])})
        self.assertEqual(len(r["3t"]["ng"]), 1); self.assertIn("空欄", r["3t"]["ng"][0][-1])

    def test_tolerance(self):
        odds3 = {(19, 8, 1, 3, 2): 6.8, (19, 9, 1, 2, 3): 6.8}
        races = {(19, 8): ([((1, 3, 2), 685)], []), (19, 9): ([((1, 2, 3), 700)], [])}         # 差5円は許容 / 差20円は不一致
        r = self.run_check(odds3, {}, {(19, 8): ("ok", "ok"), (19, 9): ("ok", "ok")}, races)
        self.assertEqual((r["3t"]["ok"], len(r["3t"]["ng"])), (1, 1))

    def test_main_exit_code(self):
        odds3 = {(19, 8, 1, 3, 2): 6.8}; zp = os.path.join(self.d, "x.zip"); make_zip(zp, self.day, odds3, {}, {(19, 8): ("ok", "ok")})
        os.makedirs(os.path.join(self.d, "res")); json.dump(api_json({(19, 8): ([((1, 3, 2), 680)], [])}), open(os.path.join(self.d, "res", self.day + ".json"), "w"))
        self.assertEqual(V.main([zp, "--results-dir", os.path.join(self.d, "res")]), 0)
        json.dump(api_json({(19, 8): ([((1, 3, 2), 999)], [])}), open(os.path.join(self.d, "res", self.day + ".json"), "w"))
        self.assertEqual(V.main([zp, "--results-dir", os.path.join(self.d, "res")]), 1)         # 不一致なら、終了コード1(不合格)

if __name__ == "__main__":
    unittest.main()
