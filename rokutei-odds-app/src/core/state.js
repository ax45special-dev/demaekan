// 取得状況の管理。3つのファイルで、「取った日」「まだの日」「取れていない日」を把握する。
//   state/pending.json  まだ取っていない日。取れた日は、ここから消える。
//   state/done.json     取れた日と結果(レース数・ページ数・エラー数など)。
//   state/failed.json   中断・失敗した日と、理由・回数。回数が上限を超えたら gave_up=true(=取れていない日)。
//   work/YYYYMMDD/JJ_RR.json  取得の途中経過(1レース取るたびに1ファイル)。止まっても、続きから再開できる。
// ファイルの読み書きは store(下の関数を持つオブジェクト)に任せる。アプリでは expo-file-system、テストでは fs。
//   store: { readJson(path, def), writeJson(path, obj), readText(path), writeText(path, text), remove(path), list(dir), exists(path) }

export function mulberry32(seed) { // 種が同じなら、いつも同じ乱数列
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, rnd) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

export const iso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
export const toYmd = (isoStr) => isoStr.replace(/-/g, "");
export function addDays(ymd, n) { const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n)); return d.toISOString().slice(0, 10).replace(/-/g, ""); }
export function daterange(startIso, endIso) { const out = []; let d = toYmd(startIso); const e = toYmd(endIso); while (d <= e) { out.push(d); d = addDays(d, 1); } return out; }
export const todayJst = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

export class State {
  constructor(cfg, store) {
    this.cfg = cfg; this.store = store;
    const sd = cfg.state_dir;
    this.pPending = sd + "/pending.json"; this.pDone = sd + "/done.json"; this.pFailed = sd + "/failed.json";
  }
  async pending() { return [...(await this.store.readJson(this.pPending, { days: [] })).days]; }
  async done() { return (await this.store.readJson(this.pDone, { days: {} })).days; }
  async failed() { return (await this.store.readJson(this.pFailed, { days: {} })).days; }
  async _savePending(days, extra = {}) {
    const old = await this.store.readJson(this.pPending, {});
    await this.store.writeJson(this.pPending, { ...old, ...extra, days: [...new Set(days)].sort() });
  }
  // 設定に従って、未取得リストを作る(すでに取った日・取れていない日・今日以降は入れない)。戻り値: 追加した日
  async init(today, addRandom = null) {
    const cfg = this.cfg, s = cfg.sample;
    const taken = new Set([...Object.keys(await this.done()), ...(await this.pending()), ...Object.entries(await this.failed()).filter(([, v]) => v.gave_up).map(([k]) => k)]);
    const cand = daterange(cfg.date_range.start, cfg.date_range.end).filter((d) => d < today && !taken.has(d));
    const n = addRandom ?? s.days;
    let chosen;
    if (s.mode === "list" && addRandom === null) { const set = new Set(cand); chosen = cfg.dates.map(toYmd).filter((d) => set.has(d)); }
    else if (s.mode === "range" && addRandom === null) chosen = cand;
    else {
      const rnd = mulberry32(s.seed ?? Math.floor(Math.random() * 2 ** 31));
      if (s.balance_months) { // 月ごとに均等に(1年の中に散らす)
        const byMonth = {};
        for (const c of cand) (byMonth[c.slice(0, 6)] ??= []).push(c);
        for (const v of Object.values(byMonth)) shuffle(v, rnd);
        const months = Object.keys(byMonth).sort(); chosen = [];
        while (chosen.length < n && months.some((m) => byMonth[m].length)) for (const m of months) if (byMonth[m].length && chosen.length < n) chosen.push(byMonth[m].pop());
      } else chosen = shuffle([...cand], rnd).slice(0, n);
    }
    await this._savePending([...(await this.pending()), ...chosen], { seed: s.seed ?? null, mode: s.mode });
    return [...chosen].sort();
  }
  async nextDay() { const p = await this.pending(); return p.length ? p[0] : null; }

  async markDone(day, info) {
    const done = await this.store.readJson(this.pDone, { days: {} }); done.days[day] = info;
    await this.store.writeJson(this.pDone, done);
    await this._savePending((await this.pending()).filter((d) => d !== day)); // ← 取れた日は、未取得リストから消える
    const f = await this.store.readJson(this.pFailed, { days: {} });
    if (f.days[day]) { delete f.days[day]; await this.store.writeJson(this.pFailed, f); }
  }
  async markInterrupted(day, reason, nowIso, countAttempt = true) {
    const f = await this.store.readJson(this.pFailed, { days: {} });
    const rec = f.days[day] ?? { attempts: 0 };
    if (countAttempt) rec.attempts += 1;
    rec.last_reason = reason; rec.last_at = nowIso; rec.gave_up = rec.attempts >= this.cfg.max_attempts_per_day;
    f.days[day] = rec; await this.store.writeJson(this.pFailed, f);
    if (rec.gave_up) await this._savePending((await this.pending()).filter((d) => d !== day)); // 取れていない日にして、リストから外す
    return rec;
  }
  async dropPending(day) { await this._savePending((await this.pending()).filter((d) => d !== day)); }
  async requeue(day = null) {
    const f = await this.store.readJson(this.pFailed, { days: {} });
    const days = day ? [day] : Object.entries(f.days).filter(([, v]) => v.gave_up).map(([k]) => k);
    for (const d of days) delete f.days[d];
    await this.store.writeJson(this.pFailed, f);
    await this._savePending([...(await this.pending()), ...days]);
    return days;
  }

  // ---- 途中経過(再開用) ----
  _wdir(day) { return `${this.cfg.work_dir}/${day}`; }
  async loadWork(day) {
    const rec = new Map();
    for (const name of await this.store.list(this._wdir(day))) {
      if (!name.endsWith(".json")) continue;
      const r = await this.store.readJson(`${this._wdir(day)}/${name}`, null);
      if (r) rec.set(`${r.jcd}-${r.rno}`, r);
    }
    return rec;
  }
  async appendWork(day, r) { await this.store.writeJson(`${this._wdir(day)}/${String(r.jcd).padStart(2, "0")}_${String(r.rno).padStart(2, "0")}.json`, r); }
  async clearWork(day) { await this.store.remove(this._wdir(day)); }
}
