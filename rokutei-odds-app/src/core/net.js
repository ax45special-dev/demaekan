// 公式サイトへのアクセス(1件ずつ・間隔を空けて・拒否されたら止まる)と、その日のレース一覧の取得。
export class StopRun extends Error {} // この回の取得を、即座に止める(混雑・拒否・形式変更の疑い等)
export class PageError extends Error {} // 1ページの取得に失敗(再試行しても駄目だった通信エラー等)

export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(fetchFn, url, headers, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers, signal: ctl.signal });
    const text = res.status === 404 ? "" : await res.text(); // 本文の読み取りも、タイムアウトの内側で行う
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(t);
  }
}

// robots.txt の簡易解釈(User-agent の該当グループ、無ければ * 。Allow/Disallow は最長一致、同じ長さなら Allow)
export function parseRobots(text, ua) {
  const token = ua.split("/")[0].toLowerCase();
  const groups = []; let cur = null, lastWasAgent = false;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === "allow" || k === "disallow")) cur.rules.push({ allow: k === "allow", path: v });
  }
  const g = groups.find((x) => x.agents.some((a) => a !== "*" && token.includes(a))) || groups.find((x) => x.agents.includes("*"));
  return { rules: g ? g.rules : [] };
}
export function canFetch(robots, path) {
  let best = null;
  for (const r of robots.rules) {
    if (r.path === "") continue; // Disallow: (空) = 制限なし
    if (path.startsWith(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

export class Fetcher {
  constructor(cfg, { fetchFn = globalThis.fetch, sleep = realSleep, now = () => Date.now(), rng = Math.random } = {}) {
    this.cfg = cfg; this.fetchFn = fetchFn; this._sleep = sleep; this._now = now; this._rng = rng;
    this._last = null; this.requests = 0; this._robots = null;
  }
  async _wait() {
    const iv = this.cfg.interval_sec * 1000;
    let wait = iv * (1 + (this._rng() * 2 - 1) * this.cfg.jitter);
    wait = Math.max(wait, iv * 0.8, 3000 * 0.8); // 何があっても、前のリクエストから2.4秒未満にはしない
    if (this._last !== null) {
      const rest = wait - (this._now() - this._last);
      if (rest > 0) await this._sleep(rest);
    }
    this._last = this._now();
  }
  async checkRobots() {
    if (!this.cfg.respect_robots) return;
    const url = this.cfg.base_url.replace(/\/$/, "") + "/robots.txt";
    let r;
    try { r = await httpGet(this.fetchFn, url, { "User-Agent": this.cfg.user_agent }, 30000); }
    catch (e) { throw new StopRun("robots.txt を読めませんでした(" + (e.message || e) + ")"); }
    if (r.status === 404 || r.status === 410) this._robots = { rules: [] };
    else if (!r.ok) throw new StopRun(`robots.txt を読めませんでした(HTTP ${r.status})`);
    else this._robots = parseRobots(r.text, this.cfg.user_agent);
  }
  async get(path) {
    const url = this.cfg.base_url.replace(/\/$/, "") + path;
    if (this._robots && !canFetch(this._robots, path.split("?")[0])) throw new StopRun("robots.txt がこのページを禁止しています: " + path);
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      await this._wait();
      this.requests++;
      try {
        const r = await httpGet(this.fetchFn, url, { "User-Agent": this.cfg.user_agent, "Accept-Language": "ja" }, 30000);
        if (r.status === 404) return { status: 404, text: "" };
        if ([403, 429, 503].includes(r.status)) throw new StopRun(`公式サイトが HTTP ${r.status} を返しました(混雑または拒否の可能性)。時間を置いてください`);
        if (r.ok) return { status: r.status, text: r.text };
        last = "HTTP " + r.status;
      } catch (e) {
        if (e instanceof StopRun) throw e;
        last = String(e.message || e);
      }
      if (attempt < 2) await this._sleep(30000 * (attempt + 1)); // 通信エラー・一時的な5xxは、最大2回まで待って再試行
    }
    throw new PageError(`取得に失敗しました(${last}): ${path}`);
  }
}

// その日に開催された [場番号, レース番号] の一覧。2026/1/1以降は統合API(v1)、それ以前は出走表API(v3)。
// GitHub上の公開ファイルを読むだけなので、公式サイトへの負荷はない。
export async function fetchRacesForDay(cfg, ymd, { fetchFn = globalThis.fetch, sleep = realSleep } = {}) {
  const base = cfg.calendar_base_url.replace(/\/$/, ""), y = ymd.slice(0, 4);
  const url = ymd >= "20260101" ? `${base}/api/v1/${y}/${ymd}.json` : `${base}/programs/v3/${y}/${ymd}.json`;
  let data = null, last = "";
  for (let attempt = 0; attempt < 3 && data === null; attempt++) {
    try {
      const r = await httpGet(fetchFn, url, { "User-Agent": cfg.user_agent }, 60000);
      if (r.status === 404) return []; // 開催なし
      if (r.ok) { data = JSON.parse(r.text); break; }
      last = "HTTP " + r.status;
    } catch (e) { last = String(e.message || e); }
    if (attempt < 2) await sleep(5000 * (attempt + 1));
  }
  if (data === null) throw new PageError(`レース一覧を取得できませんでした(${last}): ${url}`);
  const races = new Set();
  if (ymd >= "20260101") {
    const st = (data.programs && data.programs.stadiums) || data.stadiums || {};
    for (const [sn, s] of Object.entries(st)) for (const rn of Object.keys((s && s.races) || {})) races.add(`${+sn}-${+rn}`);
  } else for (const p of data.programs || []) races.add(`${+p.stadium_number}-${+p.number}`);
  const stad = cfg.stadiums;
  return [...races].map((k) => k.split("-").map(Number)).filter(([j]) => !stad || stad.includes(j)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
