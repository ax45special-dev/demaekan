"""公式サイトへのアクセス(1件ずつ・間隔を空けて・エラーなら止まる)と、その日のレース一覧の取得。"""
import json, random, time, urllib.request, urllib.error, urllib.robotparser
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))


def now_jst():
    return datetime.now(JST)


def today_jst():
    return now_jst().date()


class StopRun(Exception):
    """この回の取得を、即座に止める(混雑・拒否・形式変更の疑いなど)。"""


class PageError(Exception):
    """1ページの取得に失敗(再試行しても駄目だった通信エラー等)。"""


class Fetcher:
    def __init__(self, cfg, sleep=time.sleep, clock=time.monotonic, rng=None):
        self.cfg = cfg
        self._sleep, self._clock = sleep, clock
        self._rng = rng or random.Random()
        self._last = None
        self.requests = 0
        self._robots = None

    # ---- 間隔の管理: 前のリクエストから interval ± jitter 秒空ける ----
    def _wait(self):
        iv = self.cfg["interval_sec"]
        wait = iv * (1 + self._rng.uniform(-self.cfg["jitter"], self.cfg["jitter"]))
        wait = max(wait, iv * 0.8, 3.0 * 0.8)
        if self._last is not None:
            rest = wait - (self._clock() - self._last)
            if rest > 0:
                self._sleep(rest)
        self._last = self._clock()

    def _open(self, url, timeout=30):
        req = urllib.request.Request(url, headers={"User-Agent": self.cfg["user_agent"], "Accept-Language": "ja"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            charset = r.headers.get_content_charset() or "utf-8"
            return r.status, body.decode(charset, errors="replace")

    def check_robots(self):
        """robots.txt を読む。禁止されていれば StopRun。"""
        if not self.cfg["respect_robots"]:
            return
        url = self.cfg["base_url"].rstrip("/") + "/robots.txt"
        rp = urllib.robotparser.RobotFileParser()
        try:
            status, text = self._open(url)
            rp.parse(text.splitlines())
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                rp.parse([])                    # robots.txt が無い=制限なし
            else:
                raise StopRun("robots.txt を読めませんでした(HTTP %d)" % e.code)
        except Exception as e:                  # noqa: BLE001
            raise StopRun("robots.txt を読めませんでした(%s)" % e)
        self._robots = rp

    def get(self, path):
        """公式サイトのページを取得。戻り値 (status, text)。404は (404,'')。"""
        url = self.cfg["base_url"].rstrip("/") + path
        if self._robots is not None and not self._robots.can_fetch(self.cfg["user_agent"], url):
            raise StopRun("robots.txt がこのページを禁止しています: %s" % path)
        last = ""
        for attempt in range(3):               # 通信エラー・一時的な5xxは、最大2回まで待って再試行
            self._wait()
            self.requests += 1
            try:
                return self._open(url)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return 404, ""
                if e.code in (403, 429, 503):  # 混雑・拒否の合図。再試行せず、その回を止める
                    raise StopRun("公式サイトが HTTP %d を返しました(混雑または拒否の可能性)。時間を置いてください" % e.code)
                last = "HTTP %d" % e.code
            except Exception as e:             # noqa: BLE001
                last = str(e)
            if attempt < 2:
                self._sleep(30 * (attempt + 1))
        raise PageError("取得に失敗しました(%s): %s" % (last, path))


# ---------------------------------------------------------------- その日のレース一覧
def fetch_races_for_day(cfg, ymd, sleep=time.sleep):
    """
    その日に開催された (場番号, レース番号) の一覧。
    2026/1/1以降は統合API(v1)、それ以前は出走表API(v3)。GitHub上の公開ファイルで、公式サイトへの負荷はない。
    """
    base = cfg["calendar_base_url"].rstrip("/")
    y = ymd[:4]
    url = "%s/api/v1/%s/%s.json" % (base, y, ymd) if ymd >= "20260101" else "%s/programs/v3/%s/%s.json" % (base, y, ymd)
    last = ""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": cfg["user_agent"]})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []                       # 開催なし
            last = "HTTP %d" % e.code
        except Exception as e:                  # noqa: BLE001
            last = str(e)
        if attempt < 2:
            sleep(5 * (attempt + 1))
    else:
        raise PageError("レース一覧を取得できませんでした(%s): %s" % (last, url))
    races = set()
    if ymd >= "20260101":
        stadiums = (data.get("programs") or {}).get("stadiums") or data.get("stadiums") or {}
        for sn, st in stadiums.items():
            for rn in ((st or {}).get("races") or {}):
                races.add((int(sn), int(rn)))
    else:
        for p in data.get("programs") or []:
            races.add((int(p["stadium_number"]), int(p["number"])))
    stad = cfg.get("stadiums")
    out = sorted(r for r in races if not stad or r[0] in stad)
    return out
