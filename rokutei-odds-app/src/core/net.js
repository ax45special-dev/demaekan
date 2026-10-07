// 公式サイトへのアクセス(1件ずつ・間隔を空けて・拒否されたら止まる)と、その日のレース一覧の取得。
export class StopRun extends Error {} // この回の取得を、即座に止める(公式サイトの拒否 403/429、robots.txt の禁止)
export class PageError extends Error {} // 1ページの取得に失敗(再試行しても駄目だった通信エラー等)。busy=true は 503 が続いた時

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
  constructor(cfg, { fetchFn = globalThis.fetch, sleep = realSleep, now = () => Date.now(), rng = Math.random, onNotice = null } = {}) {
    this.cfg = cfg; this.fetchFn = fetchFn; this._sleep = sleep; this._now = now; this._rng = rng; this.onNotice = onNotice;
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
  // robots.txt を読む。通信エラー・5xx は、間隔を広げて最大3回まで試す(一時的な不調で、その回を止めないため)。
  async checkRobots() {
    if (!this.cfg.respect_robots) return;
    const url = this.cfg.base_url.replace(/\/$/, "") + "/robots.txt";
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this._sleep(60000 * attempt);
      let r;
      try { r = await httpGet(this.fetchFn, url, { "User-Agent": this.cfg.user_agent }, 30000); }
      catch (e) { last = String(e.message || e); continue; }
      if (r.status === 404 || r.status === 410) { this._robots = { rules: [] }; return; }
      if (r.status === 403 || r.status === 429) throw new StopRun(`robots.txt で HTTP ${r.status} が返りました(拒否の可能性)`);
      if (r.ok) { this._robots = parseRobots(r.text, this.cfg.user_agent); return; }
      last = "HTTP " + r.status;
    }
    throw new StopRun("robots.txt を読めませんでした(" + last + ")");
  }
  async get(path) {
    const url = this.cfg.base_url.replace(/\/$/, "") + path;
    if (this._robots && !canFetch(this._robots, path.split("?")[0])) throw new StopRun("robots.txt がこのページを禁止しています: " + path);
    let last = "", busy = 0;
    for (let attempt = 0; attempt < 3;) {
      await this._wait();
      this.requests++;
      let r = null;
      try { r = await httpGet(this.fetchFn, url, { "User-Agent": this.cfg.user_agent, "Accept-Language": "ja" }, 30000); }
      catch (e) { last = String(e.message || e); }
      if (r) {
        if (r.status === 404) return { status: 404, text: "" };
        // 403/429 は「拒否・取りすぎ」の合図。再試行せず、その回を止める(サイトポリシーのため、ここは止める)
        if (r.status === 403 || r.status === 429) throw new StopRun(`公式サイトが HTTP ${r.status} を返しました(拒否の可能性)。時間を置いてください`);
        // 503 は混雑・保守中。止めずに、長く待ってから試す。続くなら、このページは失敗(busy)として返す
        if (r.status === 503) {
          if (++busy > this.cfg.busy_retries) { const e = new PageError(`HTTP 503(混雑)が続きました: ${path}`); e.busy = true; throw e; }
          this.onNotice?.(`公式サイトが混雑しています(HTTP 503)。${Math.round(this.cfg.busy_wait_sec / 60)}分待ってから、もう一度試します(${busy}/${this.cfg.busy_retries})`);
          await this._sleep(this.cfg.busy_wait_sec * 1000);
          continue;
        }
        if (r.ok) return { status: r.status, text: r.text };
        last = "HTTP " + r.status;
      }
      attempt++;
      if (attempt < 3) await this._sleep(30000 * attempt); // 通信エラー・その他の5xxは、最大2回まで待って再試行
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
