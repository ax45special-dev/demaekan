"""
取得状況の管理。3つのファイルで、「取った日」「まだの日」「取れていない日」を把握する。

  state/pending.json  まだ取っていない日のリスト。取れた日は、ここから消える。
  state/done.json     取れた日と、その結果(レース数・ページ数・エラー数など)。
  state/failed.json   中断・失敗した日と、その理由・回数。回数が上限を超えたら gave_up=true(=取れていない日)。
  work/YYYYMMDD.jsonl 取得の途中経過(1レース取るたびに1行追記)。止まっても、続きから再開できる。
"""
import json, os, random
from datetime import date, timedelta


def _atomic_write(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def _read(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def ymd(d):
    return d.strftime("%Y%m%d")


def iso(s):
    return "%s-%s-%s" % (s[:4], s[4:6], s[6:8])


def daterange(start, end):
    d = date.fromisoformat(start)
    e = date.fromisoformat(end)
    while d <= e:
        yield d
        d += timedelta(days=1)


class State:
    def __init__(self, cfg):
        self.cfg = cfg
        sd = cfg["state_dir"]
        self.p_pending = os.path.join(sd, "pending.json")
        self.p_done = os.path.join(sd, "done.json")
        self.p_failed = os.path.join(sd, "failed.json")
        self.work_dir = cfg["work_dir"]

    # ---- 読み書き ----
    def pending(self):
        return list(_read(self.p_pending, {"days": []})["days"])

    def done(self):
        return _read(self.p_done, {"days": {}})["days"]

    def failed(self):
        return _read(self.p_failed, {"days": {}})["days"]

    def _save_pending(self, days, extra=None):
        old = _read(self.p_pending, {})
        old.update(extra or {})
        old["days"] = sorted(set(days))
        _atomic_write(self.p_pending, old)

    # ---- 取る日を決める ----
    def init(self, today, add_random=None):
        """設定に従って、未取得リストを作る(すでに取った日・取れていない日・今日以降は入れない)。"""
        cfg = self.cfg
        s = cfg["sample"]
        lo, hi = cfg["date_range"]["start"], cfg["date_range"]["end"]
        cand = [ymd(d) for d in daterange(lo, hi) if d < today]
        taken = set(self.done()) | set(self.pending()) | {k for k, v in self.failed().items() if v.get("gave_up")}
        cand = [c for c in cand if c not in taken]
        mode, n = s["mode"], (add_random if add_random is not None else s["days"])
        if mode == "list" and add_random is None:
            chosen = [ymd(date.fromisoformat(x)) for x in cfg["dates"] if ymd(date.fromisoformat(x)) in set(cand)]
        elif mode == "range" and add_random is None:
            chosen = cand
        else:
            rng = random.Random(s["seed"] if s.get("seed") is not None else None)
            if s.get("balance_months", True):
                by_month = {}
                for c in cand:
                    by_month.setdefault(c[:6], []).append(c)
                for v in by_month.values():
                    rng.shuffle(v)
                months = sorted(by_month)
                chosen = []
                while len(chosen) < n and any(by_month[m] for m in months):
                    for m in months:
                        if by_month[m] and len(chosen) < n:
                            chosen.append(by_month[m].pop())
            else:
                chosen = rng.sample(cand, min(n, len(cand)))
        new = sorted(set(self.pending()) | set(chosen))
        self._save_pending(new, {"seed": s.get("seed"), "mode": mode})
        return sorted(chosen)

    def next_day(self):
        p = self.pending()
        return p[0] if p else None

    # ---- 結果の記録 ----
    def mark_done(self, day, info):
        done = _read(self.p_done, {"days": {}})
        done["days"][day] = info
        _atomic_write(self.p_done, done)
        self._save_pending([d for d in self.pending() if d != day])     # ← 取れた日は、未取得リストから消える
        failed = _read(self.p_failed, {"days": {}})
        if day in failed["days"]:
            del failed["days"][day]
            _atomic_write(self.p_failed, failed)

    def mark_interrupted(self, day, reason, now_iso, count_attempt=True):
        """中断・失敗。回数が上限に達したら、未取得リストから外して『取れていない日』にする。"""
        failed = _read(self.p_failed, {"days": {}})
        rec = failed["days"].get(day, {"attempts": 0})
        if count_attempt:
            rec["attempts"] = rec.get("attempts", 0) + 1
        rec["last_reason"], rec["last_at"] = reason, now_iso
        rec["gave_up"] = rec["attempts"] >= self.cfg["max_attempts_per_day"]
        failed["days"][day] = rec
        _atomic_write(self.p_failed, failed)
        if rec["gave_up"]:
            self._save_pending([d for d in self.pending() if d != day])
        return rec

    def requeue(self, day=None):
        failed = _read(self.p_failed, {"days": {}})
        days = [day] if day else [k for k, v in failed["days"].items() if v.get("gave_up")]
        for d in days:
            failed["days"].pop(d, None)
        _atomic_write(self.p_failed, failed)
        self._save_pending(self.pending() + days)
        return days

    # ---- 途中経過(再開用) ----
    def work_path(self, day):
        return os.path.join(self.work_dir, day + ".jsonl")

    def load_work(self, day):
        path, rec = self.work_path(day), {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        r = json.loads(line)
                        rec[(r["jcd"], r["rno"])] = r
        return rec

    def append_work(self, day, record):
        os.makedirs(self.work_dir, exist_ok=True)
        with open(self.work_path(day), "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    def clear_work(self, day):
        p = self.work_path(day)
        if os.path.exists(p):
            os.remove(p)
