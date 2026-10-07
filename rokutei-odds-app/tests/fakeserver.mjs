// テスト用の偽の公式サイト+偽のカレンダーAPI。404・503・形式の崩れを再現できる。
import http from "node:http";
import fs from "node:fs";
const fx = (n) => fs.readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
export class Fake {
  constructor() {
    this.calendar = {}; this.requests = []; this.failAfter = null; this.failStatus = 503; this.dayStatus = new Map(); this.statusFor = new Map(); this.broken = new Set(); this.empty = new Set();
    this.robots = "User-agent: *\nAllow: /\n"; this.robotsHits = 0;
    this.h3 = [fx("3t_rowspan.html"), fx("3t_flat.html")]; this.h2 = fx("2tf_normal.html"); this.hBroken = fx("3t_broken.html");
  }
}
export function start(fake) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), send = (code, body, type = "text/html; charset=utf-8") => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
    if (u.pathname === "/robots.txt") { fake.robotsHits++; return send(200, fake.robots, "text/plain"); }
    let m = u.pathname.match(/^\/api\/v1\/(\d{4})\/(\d{8})\.json$/);
    if (m) {
      const races = fake.calendar[m[2]]; if (!races) return send(404, "");
      const st = {}; for (const [j, r] of races) (st[j] ??= { races: {} }).races[r] = {};
      return send(200, JSON.stringify({ programs: { stadiums: st } }), "application/json");
    }
    m = u.pathname.match(/^\/programs\/v3\/(\d{4})\/(\d{8})\.json$/);
    if (m) { const races = fake.calendar[m[2]]; if (!races) return send(404, ""); return send(200, JSON.stringify({ programs: races.map(([j, r]) => ({ stadium_number: j, number: r, boats: [] })) }), "application/json"); }
    m = u.pathname.match(/^\/owpc\/pc\/race\/(odds3t|odds2tf)$/);
    if (!m) return send(404, "");
    const kind = m[1] === "odds3t" ? "3t" : "2tf", rno = +u.searchParams.get("rno"), jcd = +u.searchParams.get("jcd"), hd = u.searchParams.get("hd");
    fake.requests.push([hd, jcd, rno, kind]);
    if (fake.failAfter !== null && fake.requests.length > fake.failAfter) return send(fake.failStatus, "busy");
    if (fake.dayStatus.has(hd)) return send(fake.dayStatus.get(hd), "");   // その日の全ページを、この状態で返す
    const key = `${jcd}-${rno}-${kind}`;
    if (fake.statusFor.has(key)) return send(fake.statusFor.get(key), "");
    if (fake.empty.has(key)) return send(200, "<html><body><p>データがありません</p></body></html>");
    const marker = (100 + jcd + rno / 100).toFixed(1); // レースごとの印(取り違えの検出用)
    if (kind === "3t") {
      const base = fake.broken.has(key) ? fake.hBroken : fake.h3[rno % 2];                // rowspan形式と空セル形式を交互に
      return send(200, base.replace(">25.3<", ">" + marker + "<"));
    }
    return send(200, fake.h2.replace(">8.9<", ">" + marker + "<"));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
