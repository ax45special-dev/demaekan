"""1日分の結果を、CSV(gzip)で保存する。同じ入力から、いつも同じバイト列になる(gitの差分が安定する)。"""
import csv, gzip, io, json, os


def _gz(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as g:
            g.write(text.encode("utf-8"))


def _csv(header, rows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def write_day(data_dir, day, work, bet_types, meta):
    """
    work: {(場,R): {'jcd','rno','r3t':{'status','odds':[[1着,2着,3着,オッズ],...]}, 'r2tf':{'status','t2':[...], 'f2':[...]}}}
    出力(data_dir/YYYY-MM-DD/):
      odds_3t.csv.gz  stadium,race,first,second,third,odds       (欠場のオッズは空欄)
      odds_2t.csv.gz  stadium,race,first,second,odds
      odds_2f.csv.gz  stadium,race,a,b,odds
      races.csv       stadium,race,status_3t,status_2tf,note     (どのレースが取れた/取れなかったか)
      meta.json
    """
    out = os.path.join(data_dir, "%s-%s-%s" % (day[:4], day[4:6], day[6:8]))
    r3, r2, rf, rs = [], [], [], []
    for (jcd, rno) in sorted(work):
        w = work[(jcd, rno)]
        a, b = w.get("r3t"), w.get("r2tf")
        if a and a.get("status") == "ok":
            r3 += [[jcd, rno, f, s, t, "" if o is None else o] for f, s, t, o in a["odds"]]
        if b and b.get("status") == "ok":
            r2 += [[jcd, rno, f, s, "" if o is None else o] for f, s, o in b["t2"]]
            rf += [[jcd, rno, x, y, "" if o is None else o] for x, y, o in b["f2"]]
        note = "; ".join(x.get("note", "") for x in (a, b) if x and x.get("note"))
        rs.append([jcd, rno, (a or {}).get("status", "-"), (b or {}).get("status", "-"), note])
    if "3t" in bet_types:
        _gz(os.path.join(out, "odds_3t.csv.gz"), _csv(["stadium", "race", "first", "second", "third", "odds"], r3))
    if "2tf" in bet_types:
        _gz(os.path.join(out, "odds_2t.csv.gz"), _csv(["stadium", "race", "first", "second", "odds"], r2))
        _gz(os.path.join(out, "odds_2f.csv.gz"), _csv(["stadium", "race", "a", "b", "odds"], rf))
    with open(os.path.join(out, "races.csv"), "w", encoding="utf-8", newline="") as f:
        f.write(_csv(["stadium", "race", "status_3t", "status_2tf", "note"], rs))
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    return out
