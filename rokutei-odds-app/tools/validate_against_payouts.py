#!/usr/bin/env python3
"""
集めたオッズが、列・行のずれや桁違いなく読めているかを、払戻金と照合して検査する。

原理: 100円あたりの払戻金は、当たった組の「締切時オッズ × 100」と一致する(返還・同着を除く)。
      当たった組は、レースごとに違うマスなので、全マスの位置の正しさと、桁違いまで検出できる。
      (日常の検査=逆数の合計では、単独の組の桁違いは、ほとんど検出できないための、補い。)

使い方:
  python3 tools/validate_against_payouts.py odds_20260305_20260309.zip --results-dir results/
  results/ には、YYYYMMDD.json(Boatrace Open API の、その日のファイル)を置く。
  --fetch を付けると、足りない日を Open API から取る(1日1ファイル・間隔を空けて。公式サイトではない)。

出力: 3連単・2連単ごとの一致率と、不一致の一覧(場・R・オッズ・払戻金・理由)。
"""
import argparse, csv, gzip, io, json, os, sys, time, urllib.request, urllib.error, zipfile

# 許容誤差(円)。オッズは小数1桁、払戻金は100円あたり10円単位なので、通常は ぴったり一致する(例: 6.8倍 → 680円)。
# 実データで確認するまでは、丸めの差を考えて ±5円まで許す。実データで常にぴったり一致すると分かったら、0に締めること。
TOL_YEN = 5.0


def load_odds(zf, day):
    """ZIPの中の YYYY-MM-DD/odds_3t.csv, odds_2t.csv, races.csv を読む。"""
    out = {"3t": {}, "2t": {}, "status": {}}
    base = "%s-%s-%s" % (day[:4], day[4:6], day[6:])
    def rd(name):
        p = "%s/%s" % (base, name)
        if p not in zf.namelist():
            return None
        return list(csv.DictReader(io.StringIO(zf.read(p).decode("utf-8"))))
    for r in rd("odds_3t.csv") or []:
        out["3t"][(int(r["stadium"]), int(r["race"]), int(r["first"]), int(r["second"]), int(r["third"]))] = float(r["odds"]) if r["odds"] != "" else None
    for r in rd("odds_2t.csv") or []:
        out["2t"][(int(r["stadium"]), int(r["race"]), int(r["first"]), int(r["second"]))] = float(r["odds"]) if r["odds"] != "" else None
    for r in rd("races.csv") or []:
        out["status"][(int(r["stadium"]), int(r["race"]))] = (r["status_3t"], r["status_2tf"])
    return out


def payouts_from_openapi(day_json, ymd):
    """Open API の1日分のJSONから {(場,R): {'3t': [(組, 払戻)], '2t': [...]}} を作る。
    2026/1/1以降は統合API(v1)。それ以前の results/v3 は、キー名の一部が未確認のため、実物を見て調整すること。"""
    res = {}
    if ymd >= "20260101":
        for sn, st in ((day_json.get("programs") or {}).get("stadiums") or {}).items():
            for rn, race in ((st or {}).get("races") or {}).items():
                pay = ((race or {}).get("result") or {}).get("payouts") or {}
                def conv(lst):
                    out = []
                    for p in lst or []:
                        try:
                            out.append((tuple(int(x) for x in str(p["combination"]).split("-")), float(p["amount"])))
                        except (KeyError, ValueError):
                            pass
                    return out
                res[(int(sn), int(rn))] = {"3t": conv(pay.get("trifecta")), "2t": conv(pay.get("exacta"))}
    else:
        raise NotImplementedError("2026年より前(results/v3)は、実物のキー名を確認してから実装してください")
    return res


def check_day(odds, pay):
    """戻り値: {'3t': {'ok':n,'ng':[...], 'skip':n}, '2t': {...}}"""
    out = {k: {"ok": 0, "ng": [], "skip": 0} for k in ("3t", "2t")}
    for (jcd, rno), p in sorted(pay.items()):
        st = odds["status"].get((jcd, rno))
        for kind, st_idx in (("3t", 0), ("2t", 1)):
            o = out[kind]
            if st is None or st[st_idx] != "ok":
                o["skip"] += 1           # 取れていない/読み取り失敗/データなし → 照合の対象外(別に集計)
                continue
            wins = p[kind]
            if len(wins) != 1:
                o["skip"] += 1           # 払戻なし(不成立・全額返還)、同着で複数 → 対象外
                continue
            combo, amount = wins[0]
            key = (jcd, rno) + combo
            val = odds[kind].get(key)
            if val is None:
                o["ng"].append((jcd, rno, combo, None, amount, "オッズが空欄/無い"))
            elif abs(val * 100 - amount) > TOL_YEN:
                o["ng"].append((jcd, rno, combo, val, amount, "不一致(オッズ×100=%.1f)" % (val * 100)))
            else:
                o["ok"] += 1
    return out


def fetch_day(ymd, cache_dir, sleep=3.0):
    p = os.path.join(cache_dir, ymd + ".json")
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    url = "https://boatraceopenapi.github.io/api/v1/%s/%s.json" % (ymd[:4], ymd)
    req = urllib.request.Request(url, headers={"User-Agent": "rokutei-lab-odds-validate/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    os.makedirs(cache_dir, exist_ok=True)
    json.dump(data, open(p, "w", encoding="utf-8"))
    time.sleep(sleep)
    return data


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("zip")
    ap.add_argument("--results-dir", default="results")
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--min-rate", type=float, default=0.99)
    a = ap.parse_args(argv)
    zf = zipfile.ZipFile(a.zip)
    days = sorted({n.split("/")[0] for n in zf.namelist() if "/" in n and n.split("/")[0][:2] == "20"})
    tot = {k: {"ok": 0, "ng": [], "skip": 0} for k in ("3t", "2t")}
    for d in days:
        ymd = d.replace("-", "")
        p = os.path.join(a.results_dir, ymd + ".json")
        if os.path.exists(p):
            data = json.load(open(p, encoding="utf-8"))
        elif a.fetch:
            data = fetch_day(ymd, a.results_dir)
        else:
            print("結果ファイルがありません: %s(--fetch で取得できます)" % p)
            continue
        r = check_day(load_odds(zf, ymd), payouts_from_openapi(data, ymd))
        for k in tot:
            tot[k]["ok"] += r[k]["ok"]; tot[k]["ng"] += [(d,) + x for x in r[k]["ng"]]; tot[k]["skip"] += r[k]["skip"]
    fail = False
    for k, name in (("3t", "3連単"), ("2t", "2連単")):
        n = tot[k]["ok"] + len(tot[k]["ng"])
        rate = tot[k]["ok"] / n if n else float("nan")
        print("%s: 照合 %d レース / 一致 %d (%.2f%%) / 不一致 %d / 対象外 %d" % (name, n, tot[k]["ok"], rate * 100, len(tot[k]["ng"]), tot[k]["skip"]))
        for x in tot[k]["ng"][:20]:
            print("   不一致:", x)
        if n and rate < a.min_rate:
            fail = True
    print("判定: %s(一致率の基準 %.0f%%)" % ("不合格" if fail else "合格", a.min_rate * 100))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
