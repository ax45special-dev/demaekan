"""テスト用: 実物の表(txt)から、本物に近いHTMLを作る。"""
import os, re
FIX = os.path.join(os.path.dirname(__file__), "fixtures")

def load_blocks(name):
    blocks, cur = {}, "T"
    for line in open(os.path.join(FIX, name), encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("#"):
            cur = line[1:]; blocks[cur] = []; continue
        if line.startswith("|"):
            blocks.setdefault(cur, []).append([c.strip() for c in line.strip().strip("|").split("|")])
    return blocks

NAMES = ["選手A", "選手B", "選手C", "選手D", "選手E", "選手F"]

def _td(t, cls="", extra=""):
    return '<td class="%s"%s>%s</td>' % (cls, extra, t)

def html_3t(rows, rowspan=True, marker=None):
    """rows: 20行×18列(2着欄は4行ごとに1回)。rowspan=Trueなら 2着欄を rowspan=4 で結合、Falseなら空のセル。"""
    rows = [list(r) for r in rows]
    if marker is not None:                        # (1-2-3)のオッズだけを書き換える(レースごとの印)
        rows[0][2] = ("%.1f" % marker)
    head = "<tr>" + "".join('<th>%d</th><th colspan="2">%s</th>' % (g + 1, NAMES[g]) for g in range(6)) + "</tr>"
    body = []
    for i, r in enumerate(rows):
        tds = []
        for g in range(6):
            s, t, o = r[3 * g], r[3 * g + 1], r[3 * g + 2]
            if rowspan:
                if i % 4 == 0:
                    tds.append('<td class="is-boatColor%s" rowspan="4">%s</td>' % (s, s))
            else:
                tds.append('<td class="is-boatColor%s">%s</td>' % (s or "x", s))
            tds.append('<td class="is-boatColor%s">%s</td>' % (t, t))
            tds.append('<td class="oddsPoint">%s</td>' % o)
        body.append("<tr>" + "".join(tds) + "</tr>")
    return ('<html><body><div class="title">3連単オッズ</div>'
            '<table class="is-w495"><thead>%s</thead><tbody>%s</tbody></table>'
            '<p>締切時オッズは、発売票数の集計が完了した時点でのオッズを表示しています。</p></body></html>') % (head, "".join(body))

def html_2tf(t2_rows, f2_rows, marker=None):
    t2_rows = [list(r) for r in t2_rows]
    if marker is not None:
        t2_rows[0][1] = "%.1f" % marker
    def table(rows, title):
        head = "<tr>" + "".join('<th>%d</th><th>%s</th>' % (g + 1, NAMES[g]) for g in range(6)) + "</tr>"
        body = "".join("<tr>" + "".join('<td class="is-boatColor1">%s</td><td class="oddsPoint">%s</td>' % (r[2 * g], r[2 * g + 1]) for g in range(6)) + "</tr>" for r in rows)
        return '<h3>%s</h3><table class="is-w495"><thead>%s</thead><tbody>%s</tbody></table>' % (title, head, body)
    return "<html><body>%s%s<p>締切時オッズ</p></body></html>" % (table(t2_rows, "2連単オッズ"), table(f2_rows, "2連複オッズ"))

def fixture_3t():
    return load_blocks("odds3t_2017_kojima_1R.txt")["T"]

def fixture_2tf(name):
    b = load_blocks(name)
    return b["2T"], b["2F"]

def expected_3t(rows):
    cur = [None] * 6; d = {}
    for r in rows:
        for g in range(6):
            if r[3 * g]: cur[g] = int(r[3 * g])
            d[(g + 1, cur[g], int(r[3 * g + 1]))] = float(r[3 * g + 2])
    return d

def expected_2(rows, tri):
    d = {}
    for r in rows:
        for g in range(6):
            s, o = r[2 * g], r[2 * g + 1]
            if s == "": continue
            d[(g + 1, int(s))] = None if o == "欠場" else float(o)
    return d
