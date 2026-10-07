// 画面の補助機能(TASKS.md タスク3)。画面に依存せず、Node でテストできる。
//  - probeRace: 1レースだけ取って、読み取り結果の要約を返す(オッズは保存しない)
//  - appendLog / readLog: logs/run.log への追記(上限を超えたら、古い行から捨てる)
//  - chunkDays: 書き出しを N 日ごとに分ける
//  - findUnfinished: work/ に残った、前回の途中経過を探す
import { Fetcher } from "./net.js";
import { fetchOnePage } from "./runner.js";
import { todayJst } from "./state.js";
import { utf8Bytes } from "./zip.js";

// ---- 1レースだけ確認 ----
const invSum = (rows) => rows.reduce((a, r) => a + (r[r.length - 1] ? 1 / r[r.length - 1] : 0), 0);
const pick = (rows, ...nums) => rows.find((r) => nums.every((n, i) => r[i] === n))?.[nums.length] ?? null;

// fetchOnePage の結果を、画面に出す要約にする。
export function summarizeProbe(kind, res) {
  if (res.status !== "ok") return { kind, status: res.status, note: res.note ?? "" };
  if (kind === "3t") return { kind, status: "ok", t3: { n: res.odds.length, inv_sum: invSum(res.odds), o123: pick(res.odds, 1, 2, 3) } };
  return { kind, status: "ok", t2: { n: res.t2.length, inv_sum: invSum(res.t2), o12: pick(res.t2, 1, 2) }, f2: { n: res.f2.length, inv_sum: invSum(res.f2), o12: pick(res.f2, 1, 2) } };
}

// ymd: 'YYYYMMDD'。安全装置(今日以降は取らない・robots.txt・間隔・403/429/503で停止)は、本番の取得と同じ。
// 読み取りに失敗したページは、本番と同じく work/raw_errors/ に生のHTMLを残す(原因の調査用)。オッズは保存しない。
export async function probeRace(cfg, store, ymd, jcd, rno, { fetcher = null, fetchFn, now = new Date() } = {}) {
  if (!/^\d{8}$/.test(ymd)) throw new Error("日付は YYYY-MM-DD の形で入れてください");
  if (!(jcd >= 1 && jcd <= 24) || !(rno >= 1 && rno <= 12)) throw new Error("場は1〜24、Rは1〜12で入れてください");
  if (ymd >= todayJst(now)) throw new Error("今日以降の日は取りません(確定前のオッズになるため)");
  cfg = { ...cfg, busy_retries: 0 };                 // 確認用なので、混雑(503)の時は待たずに、すぐ結果を返す
  fetcher = fetcher ?? new Fetcher(cfg, { fetchFn });
  await fetcher.checkRobots();
  const out = [];
  for (const kind of cfg.bet_types) out.push(summarizeProbe(kind, await fetchOnePage(cfg, store, fetcher, ymd, jcd, rno, kind)));
  return out;
}

export function formatProbe(results) {
  const f = (x) => (x === null || x === undefined ? "-" : String(x));
  return results.map((r) => {
    if (r.status !== "ok") return `[${r.kind}] ${r.status} ${r.note}`;
    if (r.kind === "3t") return `[3連単] ${r.t3.n}通り / 逆数の合計 ${r.t3.inv_sum.toFixed(3)} / 1-2-3 = ${f(r.t3.o123)}`;
    return `[2連単] ${r.t2.n}通り / 逆数の合計 ${r.t2.inv_sum.toFixed(3)} / 1-2 = ${f(r.t2.o12)}\n[2連複] ${r.f2.n}通り / 逆数の合計 ${r.f2.inv_sum.toFixed(3)} / 1=2 = ${f(r.f2.o12)}`;
  }).join("\n");
}

// ---- ログをファイルに残す ----
export const LOG_PATH = "logs/run.log";
export const LOG_MAX_BYTES = 1024 * 1024;

// 上限(バイト)を超えたら、古い行から捨てる。1行が上限より長い時は、その行だけ残す(末尾を優先)。
export function trimLog(text, maxBytes = LOG_MAX_BYTES) {
  if (utf8Bytes(text).length <= maxBytes) return text;
  const lines = text.split("\n");
  let size = utf8Bytes(text).length, i = 0;
  while (i < lines.length - 1 && size > maxBytes) { size -= utf8Bytes(lines[i]).length + 1; i++; }
  return lines.slice(i).join("\n");
}

// store には追記の機能がないので、読んで足して書く。書き込みは直列にする(同時に呼ばれても行が消えない)。
export function fileLogger(store, { path = LOG_PATH, maxBytes = LOG_MAX_BYTES } = {}) {
  let chain = Promise.resolve();
  const append = (line) => (chain = chain.then(async () => {
    const old = (await store.exists(path)) ? await store.readText(path) : "";
    await store.writeText(path, trimLog(old + line.replace(/\n/g, " ") + "\n", maxBytes));
  }).catch(() => {}));   // ログの失敗で、取得を止めない
  return { append, flush: () => chain };
}

export async function readLog(store, { path = LOG_PATH, lastLines = 200 } = {}) {
  if (!(await store.exists(path))) return [];
  return (await store.readText(path)).split("\n").filter(Boolean).slice(-lastLines);
}

// ---- 書き出しを分割 ----
// per=0 または未指定なら、1つのZIP。
export function chunkDays(days, per) {
  const sorted = [...days].sort();
  if (!(per >= 1)) return sorted.length ? [sorted] : [];
  const out = [];
  for (let i = 0; i < sorted.length; i += per) out.push(sorted.slice(i, i + per));
  return out;
}

// ---- 前回の途中経過 ----
// work/YYYYMMDD/ に残ったレースの数。raw_errors(読み取り失敗のHTML)は途中経過ではないので除く。
export async function findUnfinished(cfg, store) {
  const out = [];
  for (const name of (await store.list(cfg.work_dir)).sort()) {
    if (!/^\d{8}$/.test(name)) continue;
    const n = (await store.list(`${cfg.work_dir}/${name}`)).filter((x) => x.endsWith(".json")).length;
    if (n > 0) out.push({ day: name, races: n });
  }
  return out;
}
