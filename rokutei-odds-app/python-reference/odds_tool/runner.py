"""1日分(全場・全レース)を取得して、保存し、状態を更新する。"""
import json, os
from . import parse, storage
from .net import Fetcher, StopRun, PageError, fetch_races_for_day, now_jst

PATHS = {"3t": "/owpc/pc/race/odds3t", "2tf": "/owpc/pc/race/odds2tf"}


class PageBudget(Exception):
    """1回の実行のページ数の上限に達した(異常ではない。次回に続ける)。"""


def _in_window(cfg, now):
    w = cfg.get("run_window_jst")
    if not w:
        return True
    hm = now.strftime("%H:%M")
    a, b = w["start"], w["end"]
    return (a <= hm < b) if a <= b else (hm >= a or hm < b)       # 日をまたぐ時間帯(22:00〜05:00など)にも対応


def _save_raw(cfg, day, jcd, rno, kind, html):
    """読み取りに失敗したページは、原因調査のため生のHTMLを残す(1日あたり最大5件)。"""
    d = os.path.join(cfg["work_dir"], "raw_errors", day)
    os.makedirs(d, exist_ok=True)
    if len(os.listdir(d)) >= 5:
        return
    with open(os.path.join(d, "%02d_%02d_%s.html" % (jcd, rno, kind)), "w", encoding="utf-8") as f:
        f.write(html)


def fetch_one_page(cfg, fetcher, day, jcd, rno, kind):
    """1ページ取得→読み取り。戻り値は work 用の dict。通信拒否・混雑は StopRun を投げる。"""
    path = "%s?rno=%d&jcd=%02d&hd=%s" % (PATHS[kind], rno, jcd, day)
    status, html = fetcher.get(path)
    if status == 404:
        return {"status": "no_data", "note": "%s: HTTP 404" % kind}
    try:
        r = parse.parse_page(kind, html)
    except parse.NoOddsTable as e:
        return {"status": "no_data", "note": "%s: %s" % (kind, e)}
    except parse.ParseError as e:
        _save_raw(cfg, day, jcd, rno, kind, html)
        return {"status": "parse_error", "note": "%s: %s" % (kind, e)}
    if "締切時オッズ" not in html:
        return {"status": "parse_error", "note": "%s: 『締切時オッズ』の表示がありません(確定前のオッズの可能性)" % kind}
    if kind == "3t":
        return {"status": "ok", "odds": [[f, s, t, o] for (f, s, t), o in sorted(r["t3"].items())]}
    return {"status": "ok",
            "t2": [[f, s, o] for (f, s), o in sorted(r["t2"].items())],
            "f2": [[a, b, o] for (a, b), o in sorted(r["f2"].items())]}


def process_day(cfg, state, fetcher, day, budget, log=print):
    """
    day: 'YYYYMMDD'。budget: {'pages': 残りページ数}。
    戻り値: 完了なら dict(統計)。途中で止める時は、例外(StopRun / PageBudget / PageError)を投げる。
    """
    races = fetch_races_for_day(cfg, day)
    if not races:
        log("  %s: 開催なし(レース一覧が空)。取得済みとして扱います" % day)
        return {"races": 0, "pages": 0, "note": "no races", "no_data": 0, "parse_errors": 0}
    work = state.load_work(day)
    todo = [r for r in races if r not in work]
    log("  %s: %d レース(再開: すでに %d レース取得済み)" % (day, len(races), len(races) - len(todo)))
    consec_err = pages = 0
    consec_parse = {k: 0 for k in cfg["bet_types"]}      # 読み取り失敗の連続回数は、ページの種類ごとに数える
    for (jcd, rno) in todo:
        rec = {"jcd": jcd, "rno": rno}
        for kind in cfg["bet_types"]:
            if budget["pages"] <= 0:
                raise PageBudget("この回のページ数の上限(%d)に達しました" % cfg["max_pages_per_run"])
            try:
                res = fetch_one_page(cfg, fetcher, day, jcd, rno, kind)
                consec_err = 0
            except PageError as e:
                consec_err += 1
                res = {"status": "error", "note": str(e)}
                if consec_err >= cfg["max_consecutive_errors"]:
                    raise StopRun("通信エラーが %d 回続いたため止めます(%s)" % (consec_err, e))
            budget["pages"] -= 1
            pages += 1
            if res["status"] == "parse_error":
                consec_parse[kind] += 1
            elif res["status"] == "ok":
                consec_parse[kind] = 0
            rec["r" + kind] = res
            if consec_parse[kind] >= cfg["max_consecutive_parse_errors"]:
                state.append_work(day, rec)
                raise StopRun("%s の読み取り失敗が %d 回続きました。公式サイトの形式が変わった可能性があります(work/raw_errors/ に生のHTMLを保存)" % (kind, consec_parse[kind]))
        # 通信エラー(error)のレースは保存しない=次回また取り直す。それ以外は保存
        if any(rec.get("r" + k, {}).get("status") == "error" for k in cfg["bet_types"]):
            continue
        state.append_work(day, rec)
    work = state.load_work(day)
    missing = [r for r in races if r not in work]
    if missing:
        raise PageError("取れていないレースが %d 件あります(通信エラー)" % len(missing))
    stats = {"races": len(races), "pages": sum(1 for w in work.values() for k in cfg["bet_types"] if ("r" + k) in w),
             "no_data": 0, "parse_errors": 0, "parse_error_races": []}
    for (jcd, rno), w in work.items():
        for k in cfg["bet_types"]:
            st = w.get("r" + k, {}).get("status")
            if st == "no_data":
                stats["no_data"] += 1
            elif st == "parse_error":
                stats["parse_errors"] += 1
                stats["parse_error_races"].append("%02d-%02d-%s" % (jcd, rno, k))
    stats["fetched_at"] = now_jst().isoformat(timespec="seconds")
    stats["bet_types"] = list(cfg["bet_types"])
    out = storage.write_day(cfg["data_dir"], day, work, cfg["bet_types"], stats)
    stats["path"] = out
    return stats


def run(cfg, state, days=None, ignore_window=False, fetcher=None, log=print, now=None, stop_file="STOP"):
    """未取得リストの先頭から順に、days 日ぶん取る。戻り値: 概要 dict。"""
    from .net import today_jst
    n_days = days or cfg["days_per_run"]
    now = now or now_jst()
    summary = {"done": [], "interrupted": None, "pages": 0}
    if os.path.exists(stop_file):
        log("STOP ファイルがあるため、何もせず終了します(%s を消すと再開できます)" % stop_file)
        summary["interrupted"] = "STOP file"
        return summary
    if not ignore_window and not _in_window(cfg, now):
        log("実行時間帯(%s〜%s JST)の外です。何もせず終了します(--ignore-window で無視できます)" % (cfg["run_window_jst"]["start"], cfg["run_window_jst"]["end"]))
        summary["interrupted"] = "outside window"
        return summary
    fetcher = fetcher or Fetcher(cfg)
    budget = {"pages": cfg["max_pages_per_run"]}
    try:
        fetcher.check_robots()
        for _ in range(n_days):
            day = state.next_day()
            if day is None:
                log("未取得の日がありません。`python -m odds_tool init` か `add-days` で追加してください")
                break
            if day >= today_jst().strftime("%Y%m%d"):
                log("  %s は今日以降のため取得しません(確定前のオッズになるため)" % day)
                state.mark_interrupted(day, "未来日", now.isoformat(timespec="seconds"), count_attempt=False)
                state._save_pending([d for d in state.pending() if d != day])
                continue
            if os.path.exists(stop_file):
                summary["interrupted"] = "STOP file"
                break
            log("▶ %s を取得します(残り %d 日)" % (day, len(state.pending())))
            try:
                stats = process_day(cfg, state, fetcher, day, budget, log=log)
            except PageBudget as e:
                log("  ■ %s" % e)
                summary["interrupted"] = str(e)       # 異常ではないので、失敗回数は増やさない
                break
            except (StopRun, PageError) as e:
                rec = state.mark_interrupted(day, str(e), now.isoformat(timespec="seconds"))
                log("  ■ 中断: %s (この日の失敗 %d/%d回%s)" % (e, rec["attempts"], cfg["max_attempts_per_day"], "→ 取れていない日に回しました" if rec["gave_up"] else ""))
                summary["interrupted"] = str(e)
                break
            state.mark_done(day, stats)
            state.clear_work(day)
            summary["done"].append(day)
            log("  ✔ %s 完了: %d レース / %d ページ / データなし %d / 読み取り失敗 %d" % (day, stats["races"], stats["pages"], stats["no_data"], stats["parse_errors"]))
    except StopRun as e:
        log("■ 中止: %s" % e)
        summary["interrupted"] = str(e)
    summary["pages"] = cfg["max_pages_per_run"] - budget["pages"]
    state_dir = cfg["state_dir"]
    os.makedirs(state_dir, exist_ok=True)
    with open(os.path.join(state_dir, "last_run.json"), "w", encoding="utf-8") as f:
        json.dump({"at": now.isoformat(timespec="seconds"), **summary}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return summary
