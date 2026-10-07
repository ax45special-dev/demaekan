"""
公式サイト(boatrace.jp)のオッズページのHTMLを読み取る。標準ライブラリだけで動く。

対象: odds3t(3連単) と odds2tf(2連単・2連複)。
表の形(実物で確認済み):
  3連単 : 6艇ぶんのブロックが横に並ぶ。1ブロック=[2着, 3着, オッズ]の3列、全18列×20行=120通り。
          2着の欄は4行ごとに1回だけ書かれ、残りは空欄(HTMLでは rowspan の場合も、空のセルの場合もある)。
  2連単 : 1ブロック=[2着, オッズ]の2列、全12列×5行=30通り。
  2連複 : 同じ12列×5行の三角形。使わないマスは空欄。
  欠場の艇があるマスは、オッズの代わりに「欠場」と書かれる。

安全装置: 読み取った結果は、必ず次の検査を通す(通らなければ ParseError)。
  1) 通り数(3連単120、2連単30、2連複15)と、組み合わせの重複・欠けがない
  2) オッズの逆数の合計が 1.2〜1.5(控除率25%前後なら約1.33になる。実物3ページで 1.336〜1.376 を確認済み)
"""
import re
from html.parser import HTMLParser
from itertools import permutations, combinations

ABSENT = None          # 「欠場」のオッズは None で表す
SUM_MIN, SUM_MAX = 1.20, 1.50


class ParseError(Exception):
    """表は見つかったが、中身が想定と違う(形式が変わった可能性)。"""


class NoOddsTable(ParseError):
    """オッズの表そのものが無い(中止レース・発売なし・まだ公開されていない等)。"""


# ---------------------------------------------------------------- HTML → 表
class _TableExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._stack = []

    @staticmethod
    def _span(v):
        try:
            n = int(v)
            return n if n >= 1 else 1
        except (TypeError, ValueError):
            return 1

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self._stack.append({"rows": [], "row": None, "cell": None})
        elif not self._stack:
            return
        elif tag == "tr":
            self._stack[-1]["row"] = []
        elif tag in ("td", "th") and self._stack[-1]["row"] is not None:
            self._stack[-1]["cell"] = {"text": [], "rs": self._span(a.get("rowspan")), "cs": self._span(a.get("colspan"))}
        elif tag == "br" and self._stack[-1]["cell"] is not None:
            self._stack[-1]["cell"]["text"].append(" ")

    def handle_endtag(self, tag):
        if not self._stack:
            return
        top = self._stack[-1]
        if tag in ("td", "th") and top["cell"] is not None:
            top["row"].append(top["cell"])
            top["cell"] = None
        elif tag == "tr" and top["row"] is not None:
            top["rows"].append(top["row"])
            top["row"] = None
        elif tag == "table":
            self.tables.append(self._stack.pop()["rows"])

    def handle_data(self, data):
        if self._stack and self._stack[-1]["cell"] is not None:
            self._stack[-1]["cell"]["text"].append(data)


def _clean(s):
    s = s.replace("\xa0", " ").replace("\u3000", " ")
    return re.sub(r"\s+", " ", s).strip()


def expand_table(rows):
    """rowspan / colspan を展開して、長方形の表(文字だけ)にする。"""
    grid, carry = [], {}
    for row in rows:
        out, col = [], 0

        def flush():
            nonlocal col
            while col in carry:
                text, rem = carry[col]
                out.append(text)
                if rem <= 1:
                    del carry[col]
                else:
                    carry[col] = (text, rem - 1)
                col += 1

        for cell in row:
            flush()
            text = _clean("".join(cell["text"]))
            for _ in range(cell["cs"]):
                out.append(text)
                if cell["rs"] > 1:
                    carry[col] = (text, cell["rs"] - 1)
                col += 1
        flush()
        grid.append(out)
    return grid


def extract_grids(html):
    p = _TableExtractor()
    p.feed(html)
    p.close()
    return [expand_table(t) for t in p.tables]


# ---------------------------------------------------------------- 表 → オッズ
_DIGIT = re.compile(r"[1-6]")
_NUM = re.compile(r"\d+(\.\d+)?")


def _is_boat(s):
    return bool(_DIGIT.fullmatch(s))


def _is_odds(s):
    return s == "欠場" or bool(_NUM.fullmatch(s.replace(",", "")))


def _to_odds(s):
    return None if s == "欠場" else float(s.replace(",", ""))


def _try_3t(grid):
    """18列の表から、3連単(1着,2着,3着)→オッズ を作る。"""
    data = []
    for row in grid:
        if len(row) != 18:
            continue
        if all((_is_boat(row[3 * g]) or row[3 * g] == "") and _is_boat(row[3 * g + 1]) and _is_odds(row[3 * g + 2]) for g in range(6)):
            data.append(row)
    if len(data) < 10:
        return None
    cur = [None] * 6
    result = {}
    for row in data:
        for g in range(6):
            if row[3 * g] != "":
                cur[g] = int(row[3 * g])           # 2着の欄: 空なら、上の行と同じ(4行ごとに1回だけ書かれる)
            if cur[g] is None:
                raise ParseError("3連単: 最初の行に2着の艇番がありません")
            key = (g + 1, cur[g], int(row[3 * g + 1]))
            if key in result:
                raise ParseError("3連単: 同じ組み合わせが2回出ました %s" % (key,))
            result[key] = _to_odds(row[3 * g + 2])
    return result


def _try_2(grid):
    """12列の表から、2連単または2連複を作る。戻り値: ('t2'|'f2', {組: オッズ})"""
    data, blanks = [], 0
    for row in grid:
        if len(row) != 12:
            continue
        ok = True
        nb = 0
        for g in range(6):
            s, o = row[2 * g], row[2 * g + 1]
            if s == "" and o == "":
                nb += 1
            elif not (_is_boat(s) and _is_odds(o)):
                ok = False
                break
        if ok and nb < 6:
            data.append(row)
            blanks += nb
    if len(data) < 5:
        return None
    result = {}
    for row in data:
        for g in range(6):
            s, o = row[2 * g], row[2 * g + 1]
            if s == "":
                continue
            key = (g + 1, int(s))
            if key in result:
                raise ParseError("2連: 同じ組み合わせが2回出ました %s" % (key,))
            result[key] = _to_odds(o)
    if blanks == 0:
        return "t2", result
    return "f2", result


def _check(kind, mapping):
    all_boats = range(1, 7)
    if kind == "t3":
        expect = set(permutations(all_boats, 3))
    elif kind == "t2":
        expect = set(permutations(all_boats, 2))
    else:
        expect = set(combinations(all_boats, 2))
    keys = set(mapping)
    if keys != expect:
        raise ParseError("%s: 組み合わせが合いません(欠け %d / 余り %d)" % (kind, len(expect - keys), len(keys - expect)))
    nums = [v for v in mapping.values() if v is not None]
    if not nums:
        raise NoOddsTable("%s: オッズが1つもありません(全艇欠場など)" % kind)
    if any(v <= 0 for v in nums):
        raise ParseError("%s: 0以下のオッズがあります" % kind)
    s = sum(1.0 / v for v in nums)
    if not (SUM_MIN <= s <= SUM_MAX):
        raise ParseError("%s: オッズの逆数の合計が %.3f で、想定の範囲(%.2f〜%.2f)外です。数字の読み違いの可能性" % (kind, s, SUM_MIN, SUM_MAX))
    return s


def parse_page(kind, html):
    """
    kind='3t'  : 戻り値 {'t3': {(1着,2着,3着): オッズ}}
    kind='2tf' : 戻り値 {'t2': {(1着,2着): オッズ}, 'f2': {(小,大): オッズ}}
    表が無ければ NoOddsTable、中身が変なら ParseError。
    """
    grids = extract_grids(html)
    found = {}
    for g in grids:
        r3 = _try_3t(g)
        if r3 is not None:
            found.setdefault("t3", r3)
            continue
        r2 = _try_2(g)
        if r2 is not None:
            found.setdefault(r2[0], r2[1])
    want = ["t3"] if kind == "3t" else ["t2", "f2"]
    out = {}
    for k in want:
        if k not in found:
            if not found and not any(len(g) > 5 for g in grids):
                raise NoOddsTable("オッズの表が見つかりません")
            raise NoOddsTable("%s の表が見つかりません" % k)
        _check(k, found[k])
        out[k] = found[k]
    return out


def implied_sum(mapping):
    return sum(1.0 / v for v in mapping.values() if v)
