import argparse, os, sys
from . import config as C, runner
from .net import Fetcher, today_jst, now_jst
from .state import State, iso


def _fmt_days(days, n=8):
    days = sorted(days)
    s = ", ".join(iso(d) for d in days[:n])
    return s + (" … 他%d日" % (len(days) - n) if len(days) > n else "")


def cmd_status(cfg, args):
    st = State(cfg)
    pend, done, failed = st.pending(), st.done(), st.failed()
    gave = {k: v for k, v in failed.items() if v.get("gave_up")}
    retry = {k: v for k, v in failed.items() if not v.get("gave_up")}
    print("■ まだ取っていない日(未取得リスト): %d日" % len(pend))
    if pend:
        print("   次に取る日: " + _fmt_days(pend))
    print("■ 取れた日(取得済み): %d日" % len(done))
    if done:
        print("   " + _fmt_days(done, 12))
        tot = {"races": 0, "pages": 0, "no_data": 0, "parse_errors": 0}
        for v in done.values():
            for k in tot:
                tot[k] += v.get(k, 0)
        print("   合計: %d レース / %d ページ / データなし %d / 読み取り失敗 %d" % (tot["races"], tot["pages"], tot["no_data"], tot["parse_errors"]))
        review = [k for k, v in done.items() if v.get("parse_errors", 0) > 0]
        if review:
            print("   ⚠ 読み取り失敗を含む日(要確認): " + _fmt_days(review))
    print("■ 取れていない日(失敗・中断): %d日" % len(failed))
    for k, v in sorted(failed.items()):
        print("   %s  %d回目%s  理由: %s" % (iso(k), v.get("attempts", 0), " 【諦め】" if v.get("gave_up") else "(リストに残っています。次回に再試行)", v.get("last_reason", "")))
    if gave:
        print("   → 諦めた日をリストに戻すには: python -m odds_tool requeue")
    return 0


def cmd_init(cfg, args):
    st = State(cfg)
    chosen = st.init(today_jst(), add_random=args.random)
    print("未取得リストに %d 日を追加しました(合計 %d 日)。" % (len(chosen), len(st.pending())))
    print("   " + _fmt_days(chosen, 20))
    return 0


def cmd_run(cfg, args):
    st = State(cfg)
    if args.days is not None and args.days < 1:
        print("--days は1以上にしてください")
        return 2
    s = runner.run(cfg, st, days=args.days, ignore_window=args.ignore_window)
    print("\n今回: 取れた日 %s / ページ数 %d%s" % (", ".join(iso(d) for d in s["done"]) or "なし", s["pages"], " / 中断理由: %s" % s["interrupted"] if s["interrupted"] else ""))
    return 0


def cmd_probe(cfg, args):
    """動作確認用: 1レース(2ページ)だけ取って、読み取り結果を表示する。保存はしない。"""
    day = args.date.replace("-", "")
    f = Fetcher(cfg)
    f.check_robots()
    for kind in cfg["bet_types"]:
        res = runner.fetch_one_page(cfg, f, day, args.jcd, args.rno, kind)
        print("[%s] 状態=%s %s" % (kind, res["status"], res.get("note", "")))
        if res["status"] == "ok" and kind == "3t":
            d = {(a, b, c): o for a, b, c, o in res["odds"]}
            print("   3連単 %d通り / 1-2-3 のオッズ=%s / 逆数の合計=%.3f" % (len(d), d.get((1, 2, 3)), sum(1 / v for v in d.values() if v)))
            print("   最も人気(オッズが最小)の組: %s" % (min((v, k) for k, v in d.items() if v)[1],))
        if res["status"] == "ok" and kind == "2tf":
            t2 = {(a, b): o for a, b, o in res["t2"]}
            print("   2連単 %d通り / 1-2 のオッズ=%s / 2連複 %d通り" % (len(t2), t2.get((1, 2)), len(res["f2"])))
    return 0


def cmd_requeue(cfg, args):
    days = State(cfg).requeue(args.date.replace("-", "") if args.date else None)
    print("未取得リストに戻した日: %s" % (_fmt_days(days) if days else "なし"))
    return 0


def cmd_check(cfg, args):
    print("設定は正しいです。")
    print("  間隔 %.1f 秒 / 取る種類 %s / 1回 %d 日・最大 %d ページ" % (cfg["interval_sec"], cfg["bet_types"], cfg["days_per_run"], cfg["max_pages_per_run"]))
    print("  1日(約150レース)の所要時間の目安: 約 %.0f 分" % (150 * len(cfg["bet_types"]) * cfg["interval_sec"] / 60))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="odds_tool", description="公式サイトの締切時オッズ(3連単・2連単・2連複)を、少しずつ丁寧に集める")
    ap.add_argument("--config", default="config.json")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="取った日・まだの日・取れていない日を表示")
    p = sub.add_parser("init", help="設定に従って、取る日を決めて未取得リストを作る(追加もできる)")
    p.add_argument("--random", type=int, default=None, help="今ある分に加えて、ランダムにN日を追加する")
    p = sub.add_parser("run", help="未取得リストの先頭から取得する")
    p.add_argument("--days", type=int, default=None, help="何日分取るか(省略時は設定の days_per_run)")
    p.add_argument("--ignore-window", action="store_true", help="実行時間帯の制限を無視する")
    p = sub.add_parser("probe", help="1レースだけ取って、読み取りを確認する(保存しない)")
    p.add_argument("--date", required=True)
    p.add_argument("--jcd", type=int, required=True, help="場番号 例: 下関=19, 児島=16")
    p.add_argument("--rno", type=int, required=True)
    p = sub.add_parser("requeue", help="諦めた日を、未取得リストに戻す")
    p.add_argument("--date", default=None)
    sub.add_parser("check-config", help="設定を検査する")
    args = ap.parse_args(argv)
    try:
        cfg = C.load(args.config)
    except ValueError as e:
        print(e)
        return 2
    fn = {"status": cmd_status, "init": cmd_init, "run": cmd_run, "probe": cmd_probe, "requeue": cmd_requeue, "check-config": cmd_check}[args.cmd]
    return fn(cfg, args)
