"""テスト用の偽の公式サイト+偽のカレンダーAPI。実際の挙動(404・503・形式の崩れ)を再現できる。"""
import json, threading, re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from tests import helpers as H

class Fake:
    def __init__(self):
        self.calendar = {}          # 'YYYYMMDD' -> [(jcd, rno), ...]
        self.requests = []          # 受けたリクエストのパス(公式サイト側のみ)
        self.fail_after = None      # N件目以降の公式サイトへのリクエストを 503 にする
        self.status_for = {}        # (jcd,rno,kind) -> HTTP status
        self.broken = set()         # (jcd,rno,kind) -> 数字を壊したHTMLを返す
        self.empty = set()          # (jcd,rno,kind) -> 表の無いHTMLを返す
        self.robots = "User-agent: *\nAllow: /\n"
        self.rows3 = H.fixture_3t()
        self.t2, self.f2 = H.fixture_2tf("odds2tf_2026_mikuni_7R.txt")

def make_handler(fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _send(self, code, body, ctype="text/html; charset=utf-8"):
            b = body.encode("utf-8"); self.send_response(code); self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_GET(self):
            u = urlparse(self.path); q = parse_qs(u.query)
            if u.path == "/robots.txt": return self._send(200, fake.robots, "text/plain")
            m = re.match(r"^/api/v1/(\d{4})/(\d{8})\.json$", u.path)
            if m:
                races = fake.calendar.get(m.group(2))
                if races is None: return self._send(404, "")
                st = {}
                for j, r in races: st.setdefault(str(j), {"races": {}})["races"][str(r)] = {}
                return self._send(200, json.dumps({"programs": {"stadiums": st}}), "application/json")
            m = re.match(r"^/programs/v3/(\d{4})/(\d{8})\.json$", u.path)
            if m:
                races = fake.calendar.get(m.group(2))
                if races is None: return self._send(404, "")
                return self._send(200, json.dumps({"programs": [{"stadium_number": j, "number": r, "boats": []} for j, r in races]}), "application/json")
            m = re.match(r"^/owpc/pc/race/(odds3t|odds2tf)$", u.path)
            if not m: return self._send(404, "")
            kind = "3t" if m.group(1) == "odds3t" else "2tf"
            rno, jcd, hd = int(q["rno"][0]), int(q["jcd"][0]), q["hd"][0]
            fake.requests.append((hd, jcd, rno, kind))
            if fake.fail_after is not None and len(fake.requests) > fake.fail_after:
                return self._send(503, "busy")
            key = (jcd, rno, kind)
            if key in fake.status_for: return self._send(fake.status_for[key], "")
            if key in fake.empty: return self._send(200, "<html><body><p>データがありません</p></body></html>")
            marker = 100.0 + jcd + rno / 100.0                       # レースごとの印(取り違えの検出用)
            if kind == "3t":
                rows = [list(r) for r in fake.rows3]
                if key in fake.broken:                                 # 構造の崩れ(同じ組が2回出る=行の取り違え)を再現
                    rows[1][1] = "3"
                return self._send(200, H.html_3t(rows, rowspan=(rno % 2 == 0), marker=marker))
            return self._send(200, H.html_2tf(fake.t2, fake.f2, marker=marker))
    return Handler

def start(fake):
    srv = HTTPServer(("127.0.0.1", 0), make_handler(fake))
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]
