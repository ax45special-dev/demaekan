// 1日分(全場・全レース)を取得して、保存し、状態を更新する。Python版(odds_tool/runner.py)と同じ動き。
import { parsePage, NoOddsTable, ParseError } from "./parse.js";
import { Fetcher, StopRun, PageError, fetchRacesForDay } from "./net.js";
import { writeDay } from "./storage.js";
import { todayJst } from "./state.js";

export class PageBudget extends Error {} // 1回の実行のページ数の上限に達した(異常ではない。次回に続ける)
export class UserStop extends Error {} // 利用者が停止を押した(異常ではない)

const PATHS = { "3t": "/owpc/pc/race/odds3t", "2tf": "/owpc/pc/race/odds2tf" };
const p2 = (n) => String(n).padStart(2, "0");

export function inWindow(cfg, now) {
  const w = cfg.run_window_jst;
  if (!w) return true;
  const j = new Date(now.getTime() + 9 * 3600 * 1000), hm = p2(j.getUTCHours()) + ":" + p2(j.getUTCMinutes());
  return w.start <= w.end ? w.start <= hm && hm < w.end : hm >= w.start || hm < w.end; // 日をまたぐ時間帯(22:00〜05:00など)にも対応
}

async function saveRaw(cfg, store, day, jcd, rno, kind, html) { // 読み取りに失敗したページの生HTMLを残す(1日あたり最大5件)
  const dir = `${cfg.work_dir}/raw_errors/${day}`;
  if ((await store.list(dir)).length >= 5) return;
  await store.writeText(`${dir}/${p2(jcd)}_${p2(rno)}_${kind}.html`, html);
}

// 1ページ取得→読み取り。戻り値は work 用のオブジェクト。拒否・混雑は StopRun を投げる。
export async function fetchOnePage(cfg, store, fetcher, day, jcd, rno, kind) {
  const { status, text: html } = await fetcher.get(`${PATHS[kind]}?rno=${rno}&jcd=${p2(jcd)}&hd=${day}`);
  if (status === 404) return { status: "no_data", note: `${kind}: HTTP 404` };
  let r;
  try { r = parsePage(kind, html); }
  catch (e) {
    if (e instanceof NoOddsTable) return { status: "no_data", note: `${kind}: ${e.message}` };
    if (e instanceof ParseError) { await saveRaw(cfg, store, day, jcd, rno, kind, html); return { status: "parse_error", note: `${kind}: ${e.message}` }; }
    throw e;
  }
  if (!html.includes("締切時オッズ")) return { status: "parse_error", note: `${kind}: 『締切時オッズ』の表示がありません(確定前のオッズの可能性)` };
  const num = (k) => k.split("-").map(Number);
  if (kind === "3t") return { status: "ok", odds: [...r.t3.entries()].map(([k, o]) => [...num(k), o]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) };
  const rows = (m) => [...m.entries()].map(([k, o]) => [...num(k), o]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { status: "ok", t2: rows(r.t2), f2: rows(r.f2) };
}

// day: 'YYYYMMDD'。budget: {pages: 残りページ数}。完了なら統計を返す。途中で止める時は例外(StopRun/PageBudget/PageError/UserStop)。
export async function processDay(cfg, state, store, fetcher, day, budget, { log = () => {}, shouldStop = () => false, fetchFn, nowIso = () => new Date().toISOString() } = {}) {
  const races = await fetchRacesForDay(cfg, day, { fetchFn });
  if (!races.length) { log(`  ${day}: 開催なし(レース一覧が空)。取得済みとして扱います`); return { races: 0, pages: 0, note: "no races", no_data: 0, parse_errors: 0, parse_error_races: [] }; }
  let work = await state.loadWork(day);
  const todo = races.filter(([j, r]) => !work.has(`${j}-${r}`));
  log(`  ${day}: ${races.length} レース(再開: すでに ${races.length - todo.length} レース取得済み)`);
  let consecErr = 0; const consecParse = Object.fromEntries(cfg.bet_types.map((k) => [k, 0]));
  for (const [jcd, rno] of todo) {
    const rec = { jcd, rno };
    for (const kind of cfg.bet_types) {
      if (shouldStop()) throw new UserStop("停止が押されました");
      if (budget.pages <= 0) throw new PageBudget(`この回のページ数の上限(${cfg.max_pages_per_run})に達しました`);
      let res;
      try { res = await fetchOnePage(cfg, store, fetcher, day, jcd, rno, kind); consecErr = 0; }
      catch (e) {
        if (!(e instanceof PageError)) throw e;
        res = { status: "error", note: e.message };
        if (++consecErr >= cfg.max_consecutive_errors) throw new StopRun(`通信エラーが ${consecErr} 回続いたため止めます(${e.message})`);
      }
      budget.pages -= 1;
      if (res.status === "parse_error") consecParse[kind] += 1; else if (res.status === "ok") consecParse[kind] = 0;
      rec["r" + kind] = res;
      if (consecParse[kind] >= cfg.max_consecutive_parse_errors) {
        await state.appendWork(day, rec);
        throw new StopRun(`${kind} の読み取り失敗が ${consecParse[kind]} 回続きました。公式サイトの形式が変わった可能性があります(raw_errors に生のHTMLを保存)`);
      }
    }
    if (cfg.bet_types.some((k) => rec["r" + k]?.status === "error")) continue; // 通信エラーのレースは保存しない=次回また取り直す
    await state.appendWork(day, rec);
  }
  work = await state.loadWork(day);
  const missing = races.filter(([j, r]) => !work.has(`${j}-${r}`));
  if (missing.length) throw new PageError(`取れていないレースが ${missing.length} 件あります(通信エラー)`);
  const stats = { races: races.length, pages: 0, no_data: 0, parse_errors: 0, parse_error_races: [], bet_types: [...cfg.bet_types], fetched_at: nowIso() };
  for (const [k, w] of work) for (const t of cfg.bet_types) {
    const st = w["r" + t]?.status; if (st === undefined) continue;
    stats.pages++;
    if (st === "no_data") stats.no_data++;
    else if (st === "parse_error") { stats.parse_errors++; const [j, r] = k.split("-").map(Number); stats.parse_error_races.push(`${p2(j)}-${p2(r)}-${t}`); }
  }
  stats.path = await writeDay(store, cfg.data_dir, day, work, cfg.bet_types, stats);
  return stats;
}

// 未取得リストの先頭から順に、days 日ぶん取る。
export async function run(cfg, state, store, { days = null, ignoreWindow = false, fetcher = null, log = () => {}, now = new Date(), shouldStop = () => false, fetchFn } = {}) {
  const nDays = days ?? cfg.days_per_run, nowIso = now.toISOString();
  const summary = { done: [], interrupted: null, pages: 0 };
  if (shouldStop()) { summary.interrupted = "stopped"; return summary; }
  if (!ignoreWindow && !inWindow(cfg, now)) { log(`実行時間帯(${cfg.run_window_jst.start}〜${cfg.run_window_jst.end} JST)の外です。何もせず終了します`); summary.interrupted = "outside window"; return summary; }
  fetcher = fetcher ?? new Fetcher(cfg, { fetchFn });
  const budget = { pages: cfg.max_pages_per_run };
  try {
    await fetcher.checkRobots();
    for (let i = 0; i < nDays; i++) {
      const day = await state.nextDay();
      if (day === null) { log("未取得の日がありません。『取る日を決める』で追加してください"); break; }
      if (day >= todayJst(now)) { log(`  ${day} は今日以降のため取得しません(確定前のオッズになるため)`); await state.dropPending(day); continue; }
      if (shouldStop()) { summary.interrupted = "stopped"; break; }
      log(`▶ ${day} を取得します(残り ${(await state.pending()).length} 日)`);
      let stats;
      try { stats = await processDay(cfg, state, store, fetcher, day, budget, { log, shouldStop, fetchFn, nowIso: () => nowIso }); }
      catch (e) {
        if (e instanceof PageBudget || e instanceof UserStop) { log("  ■ " + e.message); summary.interrupted = e.message; break; } // 異常ではないので、失敗回数は増やさない
        if (e instanceof StopRun || e instanceof PageError) {
          const rec = await state.markInterrupted(day, e.message, nowIso);
          log(`  ■ 中断: ${e.message} (この日の失敗 ${rec.attempts}/${cfg.max_attempts_per_day}回${rec.gave_up ? "→ 取れていない日に回しました" : ""})`);
          summary.interrupted = e.message; break;
        }
        throw e;
      }
      await state.markDone(day, stats); await state.clearWork(day); summary.done.push(day);
      log(`  ✔ ${day} 完了: ${stats.races} レース / ${stats.pages} ページ / データなし ${stats.no_data} / 読み取り失敗 ${stats.parse_errors}`);
    }
  } catch (e) {
    if (e instanceof StopRun) { log("■ 中止: " + e.message); summary.interrupted = e.message; } else throw e;
  }
  summary.pages = cfg.max_pages_per_run - budget.pages;
  await store.writeJson(`${cfg.state_dir}/last_run.json`, { at: nowIso, ...summary });
  return summary;
}
