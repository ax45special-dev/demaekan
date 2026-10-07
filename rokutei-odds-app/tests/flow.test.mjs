import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeConfig } from "../src/core/config.js";
import { State, addDays } from "../src/core/state.js";
import { Fetcher } from "../src/core/net.js";
import { run, inWindow } from "../src/core/runner.js";
import { nodeStore } from "./nodeStore.mjs";
import { Fake, start } from "./fakeserver.mjs";

const NOW = new Date("2026-10-06T18:00:00Z"); // = 2026-10-07 03:00 JST
const TODAY = "20261007";
const RACES = [[2, 1], [2, 2], [19, 1], [19, 2], [19, 3]];

async function setup(over = {}) {
  const fake = new Fake(); const { server, base } = await start(fake);
  for (let d = 1; d <= 31; d++) fake.calendar["202603" + String(d).padStart(2, "0")] = RACES;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odds-"));
  const cfg = mergeConfig({ base_url: base, calendar_base_url: base, interval_sec: 3.0, jitter: 0, user_agent: "test-agent",
    date_range: { start: "2026-03-01", end: "2026-03-31" }, sample: { mode: "random", days: 6, seed: 1, balance_months: true }, ...over });
  const store = nodeStore(root), state = new State(cfg, store);
  let t = 0; const slept = [];
  const mk = (c = cfg) => new Fetcher(c, { sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t });   // 実際には待たず、記録だけする
  return { fake, server, cfg, store, state, root, mk, slept, clock: () => t, close: () => { server.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const quiet = { log: () => {} };

test("init: 同じ設定なら同じ日・今日以降は選ばない・月ごとに散らす・種を変えれば別の日", async () => {
  const s = await setup({ date_range: { start: "2026-01-01", end: "2026-12-31" }, sample: { mode: "random", days: 12, seed: 1, balance_months: true } });
  const a = await s.state.init(TODAY); await s.store.remove("state");
  const b = await new State(s.cfg, s.store).init(TODAY);
  assert.deepEqual(a, b); assert.equal(a.length, 12); assert.ok(a.every((d) => d < TODAY));
  assert.equal(new Set(a.map((d) => d.slice(0, 6))).size, 10); // 1〜10月(今日より前の10か月)に1日以上ずつ
  await s.store.remove("state"); const c = await new State(mergeConfig({ ...s.cfg, sample: { ...s.cfg.sample, seed: 2 } }), s.store).init(TODAY);
  assert.notDeepEqual(a, c); s.close();
});

test("取れた日は未取得リストから消え、データが正しい場所・正しい値で保存される", async () => {
  const s = await setup(); await s.state.init(TODAY); const before = await s.state.pending(); assert.equal(before.length, 6);
  const r = await run(s.cfg, s.state, s.store, { ...quiet, days: 2, fetcher: s.mk(), now: NOW });
  assert.equal(r.done.length, 2); const after = await s.state.pending(); assert.equal(after.length, 4);
  for (const d of r.done) { assert.ok(!after.includes(d)); assert.ok(d in (await s.state.done())); } // ← 取れた日は、未取得リストから消える
  assert.deepEqual(r.done, [...before].sort().slice(0, 2));
  const d = r.done[0], dir = path.join(s.root, "data", `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`);
  const rows = fs.readFileSync(path.join(dir, "odds_3t.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  assert.equal(rows.length, 5 * 120);
  const mk = new Map(rows.filter((x) => x[2] === "1" && x[3] === "2" && x[4] === "3").map((x) => [`${x[0]}-${x[1]}`, +x[5]]));
  assert.equal(mk.size, 5); assert.equal(mk.get("19-2"), 119.0); assert.equal(mk.get("2-1"), 102.0);            // レースごとの印が、正しいレースの行に入っている
  assert.equal(fs.readFileSync(path.join(dir, "odds_2t.csv"), "utf8").trim().split("\n").length - 1, 5 * 30);
  assert.equal(fs.readFileSync(path.join(dir, "odds_2f.csv"), "utf8").trim().split("\n").length - 1, 5 * 15);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); assert.equal(meta.races, 5); assert.equal(meta.pages, 10);
  assert.ok(!fs.existsSync(path.join(s.root, "work", d)));                                                      // 途中経過は消える
  s.close();
});

test("間隔: どのリクエストの前にも2.4秒以上(設定3秒の0.8倍)待つ。ページ数は10", async () => {
  const s = await setup(); await s.state.init(TODAY); const f = s.mk();
  await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: f, now: NOW });
  assert.equal(f.requests, 10); assert.ok(s.slept.every((ms) => ms >= 3000 * 0.8 - 1e-6)); assert.ok(s.clock() >= 3000 * 9 * 0.8); s.close();
});

test("間隔が3秒未満の設定は、受け付けない", () => { assert.throws(() => mergeConfig({ interval_sec: 1.0 }), /3 秒以上/); });

test("503で止まり、次回は取れていないレースだけを再開する", async () => {
  const s = await setup(); await s.state.init(TODAY); const first = await s.state.nextDay();
  s.fake.failAfter = 5;
  const r = await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: s.mk(), now: NOW });
  assert.deepEqual(r.done, []); assert.match(r.interrupted, /503/);
  assert.ok((await s.state.pending()).includes(first)); assert.equal((await s.state.failed())[first].attempts, 1); assert.equal((await s.state.failed())[first].gave_up, false);
  assert.equal((await s.state.loadWork(first)).size, 2);                            // 5ページ目まで成功=2レース分(2種×2)
  const got = s.fake.requests.length; s.fake.failAfter = null;
  const r2 = await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: s.mk(), now: NOW });
  assert.deepEqual(r2.done, [first]); assert.equal(s.fake.requests.length - got, 6);   // 残り3レース×2種だけ。取得済みの2レースは取り直さない
  assert.ok(!((await s.state.failed())[first])); s.close();
});

test("失敗が続くと『取れていない日』になり、リストから外れる。requeueで戻せる", async () => {
  const s = await setup({ max_attempts_per_day: 2 }); await s.state.init(TODAY); const first = await s.state.nextDay(); s.fake.failAfter = 0;
  for (let i = 0; i < 2; i++) await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: s.mk(), now: NOW });
  assert.equal((await s.state.failed())[first].gave_up, true); assert.ok(!(await s.state.pending()).includes(first)); assert.equal((await s.state.pending()).length, 5);
  assert.deepEqual(await s.state.requeue(), [first]); assert.ok((await s.state.pending()).includes(first)); s.close();
});

test("ページ数の上限で止まるのは失敗ではない", async () => {
  const s = await setup({ max_pages_per_run: 4 }); await s.state.init(TODAY); const first = await s.state.nextDay();
  const r = await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: s.mk(), now: NOW });
  assert.deepEqual(r.done, []); assert.equal(r.pages, 4); assert.ok(!(first in (await s.state.failed())));
  const cfg2 = mergeConfig({ ...s.cfg, max_pages_per_run: 100 }); const r2 = await run(cfg2, new State(cfg2, s.store), s.store, { ...quiet, days: 1, fetcher: s.mk(cfg2), now: NOW });
  assert.deepEqual(r2.done, [first]); s.close();
});

test("データなし(404・表なし)と読み取り失敗(構造の崩れ)が記録され、生のHTMLが残る", async () => {
  const s = await setup(); await s.state.init(TODAY); const first = await s.state.nextDay();
  s.fake.statusFor.set("2-1-3t", 404); s.fake.empty.add("2-2-2tf"); s.fake.broken.add("19-1-3t");
  await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: s.mk(), now: NOW });
  const d = (await s.state.done())[first]; assert.equal(d.no_data, 2); assert.equal(d.parse_errors, 1); assert.deepEqual(d.parse_error_races, ["19-01-3t"]);
  const rs = fs.readFileSync(path.join(s.root, "data", `${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6)}`, "races.csv"), "utf8");
  assert.match(rs, /^2,1,no_data,ok,/m); assert.match(rs, /^19,1,parse_error,ok,/m); assert.match(rs, /^2,2,ok,no_data,/m);
  assert.ok(fs.existsSync(path.join(s.root, "work", "raw_errors", first, "19_01_3t.html"))); s.close();
});

test("読み取り失敗が続くと止まる(3連単だけが壊れても、2連単の成功に打ち消されない)", async () => {
  const s = await setup({ max_consecutive_parse_errors: 3 }); await s.state.init(TODAY); const first = await s.state.nextDay();
  for (const [j, r] of RACES) s.fake.broken.add(`${j}-${r}-3t`);
  const r = await run(s.cfg, s.state, s.store, { ...quiet, days: 1, fetcher: s.mk(), now: NOW });
  assert.match(r.interrupted, /形式が変わった/); assert.ok((await s.state.pending()).includes(first)); s.close();
});

test("停止ボタン・実行時間帯: 時間帯の外では1件もアクセスしない。停止が押されたら止まる", async () => {
  const s = await setup({ run_window_jst: { start: "01:00", end: "07:00" } }); await s.state.init(TODAY);
  const noon = new Date("2026-10-07T03:00:00Z"); // 12:00 JST
  let r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: noon });
  assert.equal(r.interrupted, "outside window"); assert.equal(s.fake.requests.length, 0);
  r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW }); assert.equal(r.done.length, 1);     // 03:00 JST は時間帯の中
  const n = s.fake.requests.length;
  r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW, shouldStop: () => true });
  assert.equal(r.interrupted, "stopped"); assert.equal(s.fake.requests.length, n);
  let calls = 0; r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW, shouldStop: () => ++calls > 3 });   // 取得の途中で停止
  assert.equal(r.done.length, 0); assert.ok(s.fake.requests.length - n <= 3);
  assert.equal((await s.state.failed())[(await s.state.nextDay())] , undefined);                                      // 停止は失敗ではない
  s.close();
});

test("日をまたぐ時間帯(22:00〜05:00)", () => {
  const cfg = { run_window_jst: { start: "22:00", end: "05:00" } };
  for (const [h, m, ok] of [[23, 0, true], [2, 0, true], [5, 0, false], [12, 0, false], [22, 30, true], [21, 0, false]]) {
    const utc = new Date(Date.UTC(2026, 9, 7, h - 9, m)); assert.equal(inWindow(cfg, utc), ok, `${h}:${m}`);
  }
});

test("robots.txt が禁止していたら、1件も取らない。許可なら取る", async () => {
  const s = await setup(); s.fake.robots = "User-agent: *\nDisallow: /owpc/\n"; await s.state.init(TODAY);
  const r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW });
  assert.match(r.interrupted, /robots/); assert.equal(s.fake.requests.length, 0); s.close();
});

test("今日以降の日は取らない(確定前のオッズになるため)", async () => {
  const s = await setup(); s.fake.calendar["20261007"] = RACES; await s.state._savePending(["20261007", "20261008", "20260305"]);
  await run(s.cfg, s.state, s.store, { ...quiet, days: 3, fetcher: s.mk(), now: NOW });
  assert.ok(s.fake.requests.every(([hd]) => hd !== "20261007" && hd !== "20261008")); assert.ok("20260305" in (await s.state.done())); s.close();
});

test("場の絞り込み・3連単のみ", async () => {
  let s = await setup({ stadiums: [19] }); await s.state.init(TODAY);
  await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW });
  assert.deepEqual([...new Set(s.fake.requests.map((r) => r[1]))], [19]); s.close();
  s = await setup({ bet_types: ["3t"] }); await s.state.init(TODAY);
  await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW });
  assert.deepEqual([...new Set(s.fake.requests.map((r) => r[3]))], ["3t"]); assert.equal(s.fake.requests.length, 5); s.close();
});

test("ランダムに追加しても、取った日・待ち中の日とは重ならない", async () => {
  const s = await setup(); await s.state.init(TODAY); await run(s.cfg, s.state, s.store, { ...quiet, days: 2, fetcher: s.mk(), now: NOW });
  const done = new Set(Object.keys(await s.state.done())), pend = new Set(await s.state.pending());
  const added = await s.state.init(TODAY, 5); assert.equal(added.length, 5);
  assert.ok(added.every((d) => !done.has(d) && !pend.has(d))); s.close();
});

test("2026年より前の日は、出走表API(v3)でレース一覧を取る", async () => {
  const s = await setup({ date_range: { start: "2025-11-01", end: "2025-11-30" } }); s.fake.calendar["20251105"] = [[16, 1], [16, 2]];
  await s.state._savePending(["20251105"]); const r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW });
  assert.deepEqual(r.done, ["20251105"]); assert.equal(s.fake.requests.length, 4); s.close();
});

test("開催なしの日(カレンダーが404)は、取得済みとして扱い、無限に残らない", async () => {
  const s = await setup(); await s.state._savePending(["20260230"]);   // カレンダーに無い日
  const r = await run(s.cfg, s.state, s.store, { ...quiet, fetcher: s.mk(), now: NOW });
  assert.deepEqual(r.done, ["20260230"]); assert.equal((await s.state.done())["20260230"].races, 0); assert.equal((await s.state.pending()).length, 0); s.close();
});
