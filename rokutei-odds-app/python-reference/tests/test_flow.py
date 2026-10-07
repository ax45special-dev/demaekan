import gzip, json, os, shutil, sys, tempfile, unittest, csv, io
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from odds_tool import config as C, runner
from odds_tool.net import Fetcher, JST
from odds_tool.state import State
from tests.fakeserver import Fake, start

def make_cfg(tmp, base, **over):
    cfg = C.load("/nonexistent")
    cfg.update({"base_url": base, "calendar_base_url": base, "interval_sec": 3.0, "jitter": 0.0,
                "state_dir": os.path.join(tmp, "state"), "data_dir": os.path.join(tmp, "data"), "work_dir": os.path.join(tmp, "work"),
                "respect_robots": True, "user_agent": "test-agent"})
    cfg["date_range"] = {"start": "2026-03-01", "end": "2026-03-31"}
    cfg["sample"] = {"mode": "random", "days": 6, "seed": 1, "balance_months": True}
    cfg.update(over)
    return cfg

class NoSleepFetcher(Fetcher):
    """待ち時間を『実際には待たず』に記録だけする。間隔が守られているかを検査できる。"""
    def __init__(self, cfg):
        self.slept = []; self.t = 0.0
        super().__init__(cfg, sleep=self._sleep, clock=lambda: self.t)
    def _sleep(self, s): self.slept.append(s); self.t += s

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.fake = Fake()
        self.srv, self.base = start(self.fake)
        for d in range(1, 32):
            self.fake.calendar["202603%02d" % d] = [(2, 1), (2, 2), (19, 1), (19, 2), (19, 3)]       # 1日 5レース
        self.cwd = os.getcwd(); os.chdir(self.tmp)
    def tearDown(self):
        os.chdir(self.cwd); self.srv.shutdown(); shutil.rmtree(self.tmp, ignore_errors=True)
    def cfg(self, **o): return make_cfg(self.tmp, self.base, **o)
    NOW = datetime(2026, 10, 7, 3, 0, tzinfo=JST)

class TestFlow(Base):
    def test_init_is_reproducible_balanced_and_excludes_future(self):
        cfg = self.cfg(); cfg["date_range"] = {"start": "2026-01-01", "end": "2026-12-31"}; cfg["sample"]["days"] = 12
        a = State(cfg).init(datetime(2026, 10, 7).date())
        shutil.rmtree(cfg["state_dir"]); b = State(cfg).init(datetime(2026, 10, 7).date())
        self.assertEqual(a, b)                                       # 同じ設定・同じ種 → 同じ日
        self.assertEqual(len(a), 12); self.assertTrue(all(d < "20261007" for d in a))   # 今日以降は選ばない
        self.assertEqual(len({d[:6] for d in a}), 10)                # 1〜10月(今日より前の10か月)に、1日以上ずつ(月ごとのバランス)
        shutil.rmtree(cfg["state_dir"]); cfg["sample"]["seed"] = 2
        self.assertNotEqual(a, State(cfg).init(datetime(2026, 10, 7).date()))   # 種を変えれば別の日

    def test_done_day_disappears_from_pending_and_data_is_correct(self):
        cfg = self.cfg(); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        before = st.pending(); self.assertEqual(len(before), 6)
        f = NoSleepFetcher(cfg)
        s = runner.run(cfg, st, days=2, fetcher=f, log=lambda *_: None, now=self.NOW)
        self.assertEqual(len(s["done"]), 2)
        after = st.pending(); self.assertEqual(len(after), 4)
        for d in s["done"]: self.assertNotIn(d, after); self.assertIn(d, st.done())     # ← 取れた日は、未取得リストから消える
        self.assertEqual(sorted(before)[:2], s["done"])
        # 保存されたデータを読み戻して、元のオッズと比べる
        d = s["done"][0]; out = os.path.join(cfg["data_dir"], "%s-%s-%s" % (d[:4], d[4:6], d[6:]))
        rows = list(csv.DictReader(io.StringIO(gzip.open(os.path.join(out, "odds_3t.csv.gz"), "rt", encoding="utf-8").read())))
        self.assertEqual(len(rows), 5 * 120)
        mk = {(int(r["stadium"]), int(r["race"])): r for r in rows if (r["first"], r["second"], r["third"]) == ("1", "2", "3")}
        self.assertEqual(len(mk), 5)
        self.assertEqual(float(mk[(19, 2)]["odds"]), round(100.0 + 19 + 2 / 100.0, 1))      # (19場2R)の印=119.0 が、19場2Rの行に入っている
        self.assertEqual(float(mk[(2, 1)]["odds"]), round(100.0 + 2 + 1 / 100.0, 1))        # (2場1R)の印=102.0
        t2 = list(csv.DictReader(io.StringIO(gzip.open(os.path.join(out, "odds_2t.csv.gz"), "rt", encoding="utf-8").read())))
        f2 = list(csv.DictReader(io.StringIO(gzip.open(os.path.join(out, "odds_2f.csv.gz"), "rt", encoding="utf-8").read())))
        self.assertEqual((len(t2), len(f2)), (5 * 30, 5 * 15))
        meta = json.load(open(os.path.join(out, "meta.json"))); self.assertEqual(meta["races"], 5); self.assertEqual(meta["pages"], 10)
        self.assertFalse(os.path.exists(os.path.join(cfg["work_dir"], d + ".jsonl")))      # 途中経過ファイルは消える

    def test_interval_is_respected(self):
        cfg = self.cfg(); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        f = NoSleepFetcher(cfg); runner.run(cfg, st, days=1, fetcher=f, log=lambda *_: None, now=self.NOW)
        self.assertEqual(f.requests, 10)                                      # 10ページ(5レース×2種)。robots.txt は別に取る
        self.assertTrue(all(s >= 3.0 * 0.8 - 1e-9 for s in f.slept))          # どのリクエストの前にも、3秒(の0.8倍)以上待つ
        self.assertGreaterEqual(f.t, 3.0 * 9 * 0.8)

    def test_interval_below_floor_is_rejected(self):
        cfg = C.load("/nonexistent"); cfg["interval_sec"] = 1.0
        with self.assertRaises(ValueError): C.validate(cfg)

    def test_resume_after_503_fetches_only_missing_races(self):
        cfg = self.cfg(); st = State(cfg); st.init(datetime(2026, 10, 7).date()); first = st.next_day()
        self.fake.fail_after = 5                                              # 5ページ目まで成功、その後は503
        s = runner.run(cfg, st, days=1, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertEqual(s["done"], []); self.assertIn("503", s["interrupted"])
        self.assertIn(first, st.pending()); self.assertEqual(st.failed()[first]["attempts"], 1)
        self.assertFalse(st.failed()[first]["gave_up"])
        self.assertEqual(len(st.load_work(first)), 2)                         # 5ページ=2レース分(2種×2)+1ページ → 完了したのは2レース
        got = len(self.fake.requests); self.fake.fail_after = None
        s2 = runner.run(cfg, st, days=1, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertEqual(s2["done"], [first])
        newreq = self.fake.requests[got:]
        self.assertEqual(len(newreq), 6)                                      # 残り3レース×2種=6ページだけ(取得済みの2レースは取り直さない)
        self.assertNotIn(first, st.failed())                                  # 成功したので、失敗の記録は消える

    def test_gives_up_after_repeated_failures_and_requeue(self):
        cfg = self.cfg(max_attempts_per_day=2); st = State(cfg); st.init(datetime(2026, 10, 7).date()); first = st.next_day()
        self.fake.fail_after = 0
        for i in range(2): runner.run(cfg, st, days=1, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertTrue(st.failed()[first]["gave_up"]); self.assertNotIn(first, st.pending())     # 取れていない日になり、リストから外れる
        self.assertEqual(len(st.pending()), 5)
        self.fake.fail_after = None
        self.assertEqual(State(cfg).requeue(), [first]); self.assertIn(first, st.pending())

    def test_page_budget_stops_cleanly_without_counting_as_failure(self):
        cfg = self.cfg(max_pages_per_run=4); st = State(cfg); st.init(datetime(2026, 10, 7).date()); first = st.next_day()
        s = runner.run(cfg, st, days=1, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertEqual(s["done"], []); self.assertEqual(s["pages"], 4)
        self.assertNotIn(first, st.failed())                                  # 上限での停止は失敗ではない
        cfg2 = self.cfg(max_pages_per_run=100); s2 = runner.run(cfg2, State(cfg2), days=1, fetcher=NoSleepFetcher(cfg2), log=lambda *_: None, now=self.NOW)
        self.assertEqual(s2["done"], [first])

    def test_no_data_and_parse_error_races_are_recorded(self):
        cfg = self.cfg(); st = State(cfg); st.init(datetime(2026, 10, 7).date()); first = st.next_day()
        self.fake.status_for[(2, 1, "3t")] = 404; self.fake.empty.add((2, 2, "2tf")); self.fake.broken.add((19, 1, "3t"))
        runner.run(cfg, st, days=1, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        d = st.done()[first]; self.assertEqual(d["no_data"], 2); self.assertEqual(d["parse_errors"], 1); self.assertEqual(d["parse_error_races"], ["19-01-3t"])
        out = os.path.join(cfg["data_dir"], "%s-%s-%s" % (first[:4], first[4:6], first[6:]))
        rs = {(int(r["stadium"]), int(r["race"])): r for r in csv.DictReader(open(os.path.join(out, "races.csv"), encoding="utf-8"))}
        self.assertEqual(rs[(2, 1)]["status_3t"], "no_data"); self.assertEqual(rs[(19, 1)]["status_3t"], "parse_error"); self.assertEqual(rs[(2, 2)]["status_2tf"], "no_data")
        self.assertTrue(os.path.exists(os.path.join(cfg["work_dir"], "raw_errors", first, "19_01_3t.html")))   # 生のHTMLが残る

    def test_stops_when_parse_errors_continue(self):
        cfg = self.cfg(max_consecutive_parse_errors=3); st = State(cfg); st.init(datetime(2026, 10, 7).date()); first = st.next_day()
        for j, r in [(2, 1), (2, 2), (19, 1), (19, 2), (19, 3)]: self.fake.broken.add((j, r, "3t"))
        s = runner.run(cfg, st, days=1, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertIn("形式が変わった", s["interrupted"]); self.assertIn(first, st.pending())

    def test_stop_file_and_window(self):
        cfg = self.cfg(run_window_jst={"start": "01:00", "end": "07:00"}); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        noon = datetime(2026, 10, 7, 12, 0, tzinfo=JST)
        s = runner.run(cfg, st, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=noon)
        self.assertEqual(s["interrupted"], "outside window"); self.assertEqual(self.fake.requests, [])      # 時間帯の外では、1件もアクセスしない
        s = runner.run(cfg, st, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)           # 03:00は時間帯の中
        self.assertEqual(len(s["done"]), 1)
        open("STOP", "w").close(); n = len(self.fake.requests)
        s = runner.run(cfg, st, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertEqual(s["interrupted"], "STOP file"); self.assertEqual(len(self.fake.requests), n)
        os.remove("STOP")

    def test_window_crossing_midnight(self):
        cfg = self.cfg(run_window_jst={"start": "22:00", "end": "05:00"})
        for h, ok in [(23, True), (2, True), (5, False), (12, False), (22, True), (21, False)]:
            self.assertEqual(runner._in_window(cfg, datetime(2026, 10, 7, h, 30 if h == 22 else 0, tzinfo=JST)), ok, h)

    def test_robots_disallow_blocks_everything(self):
        self.fake.robots = "User-agent: *\nDisallow: /owpc/\n"
        cfg = self.cfg(); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        s = runner.run(cfg, st, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertIn("robots", s["interrupted"]); self.assertEqual(self.fake.requests, [])

    def test_never_fetches_today_or_future(self):
        cfg = self.cfg(); st = State(cfg); st._save_pending(["20261007", "20261008", "20260305"])
        s = runner.run(cfg, st, days=3, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        import odds_tool.net as net
        self.assertTrue(all(h != "20261007" for h, *_ in self.fake.requests))    # 今日(10/7)のオッズは確定前なので取らない

    def test_stadium_filter(self):
        cfg = self.cfg(stadiums=[19]); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        runner.run(cfg, st, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertEqual({j for _, j, _, _ in self.fake.requests}, {19})

    def test_only_3t_when_configured(self):
        cfg = self.cfg(bet_types=["3t"]); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        runner.run(cfg, st, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        self.assertEqual({k for *_, k in self.fake.requests}, {"3t"}); self.assertEqual(len(self.fake.requests), 5)

    def test_add_random_does_not_duplicate_done_days(self):
        cfg = self.cfg(); st = State(cfg); st.init(datetime(2026, 10, 7).date())
        runner.run(cfg, st, days=2, fetcher=NoSleepFetcher(cfg), log=lambda *_: None, now=self.NOW)
        done = set(st.done()); added = st.init(datetime(2026, 10, 7).date(), add_random=5)
        self.assertEqual(len(added), 5); self.assertTrue(done.isdisjoint(added)); self.assertTrue(set(added).isdisjoint(set(st.pending()) - set(added)))

if __name__ == "__main__":
    unittest.main()
