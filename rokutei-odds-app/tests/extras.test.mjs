// タスク3の補助機能(1レースだけ確認・ログのファイル・書き出しの分割・前回の途中経過)。偽サーバーで確認する。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeConfig } from "../src/core/config.js";
import { State } from "../src/core/state.js";
import { Fetcher } from "../src/core/net.js";
import { run } from "../src/core/runner.js";
import { buildExport } from "../src/core/zip.js";
import { probeRace, formatProbe, trimLog, fileLogger, readLog, chunkDays, findUnfinished } from "../src/core/extras.js";
import { nodeStore } from "./nodeStore.mjs";
import { Fake, start } from "./fakeserver.mjs";

const NOW = new Date("2026-10-06T18:00:00Z"); // = 2026-10-07 03:00 JST
async function setup(over = {}) {
  const fake = new Fake(); const { server, base } = await start(fake);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odds-x-")), store = nodeStore(root);
  const cfg = mergeConfig({ base_url: base, calendar_base_url: base, interval_sec: 3, jitter: 0, user_agent: "test-agent", ...over });
  let t = 0; const slept = [];
  const mk = () => new Fetcher(cfg, { sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t });
  return { fake, cfg, store, root, mk, slept, close: () => { server.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("1レースだけ確認: 2ページだけ取り、通り数・逆数の合計・1-2-3 を返す。オッズは保存しない", async () => {
  const s = await setup(); const f = s.mk();
  const r = await probeRace(s.cfg, s.store, "20260102", 19, 8, { fetcher: f, now: NOW });
  assert.deepEqual(s.fake.requests, [["20260102", 19, 8, "3t"], ["20260102", 19, 8, "2tf"]]);   // カレンダーAPIも使わず、この2ページだけ
  assert.equal(s.fake.robotsHits, 1);
  assert.ok(s.slept.every((ms) => ms >= 2400));
  const [t3, t2] = r;
  assert.equal(t3.status, "ok"); assert.equal(t3.t3.n, 120);
  assert.equal(t3.t3.o123, 119.1);                                       // 偽サーバーの印 = (100 + 19 + 8/100).toFixed(1) → 1-2-3 の欄(元 25.3)
  assert.ok(t3.t3.inv_sum > 1.2 && t3.t3.inv_sum < 1.5);
  assert.equal(t2.t2.n, 30); assert.equal(t2.f2.n, 15); assert.equal(t2.t2.o12, 119.1);  // 2連単 1-2 の欄(元 8.9)に印
  assert.match(formatProbe(r), /\[3連単\] 120通り .* 1-2-3 = 119\.1/);
  assert.deepEqual(fs.readdirSync(s.root).filter((x) => x !== "work"), []);  // data/ も state/ も作らない
  s.close();
});

test("1レースだけ確認: 今日以降の日・範囲外の場は、アクセスせずに断る", async () => {
  const s = await setup(); const f = s.mk();
  await assert.rejects(probeRace(s.cfg, s.store, "20261007", 19, 8, { fetcher: f, now: NOW }), /今日以降/);
  await assert.rejects(probeRace(s.cfg, s.store, "20260102", 25, 8, { fetcher: f, now: NOW }), /場は1〜24/);
  await assert.rejects(probeRace(s.cfg, s.store, "2026-01-02", 19, 8, { fetcher: f, now: NOW }), /YYYY-MM-DD/);
  assert.equal(s.fake.requests.length, 0); assert.equal(s.fake.robotsHits, 0);
  s.close();
});

test("1レースだけ確認: 503 なら再試行せずに止まる", async () => {
  const s = await setup(); s.fake.failAfter = 0; const f = s.mk();
  await assert.rejects(probeRace(s.cfg, s.store, "20260102", 19, 8, { fetcher: f, now: NOW }), /HTTP 503/);
  assert.equal(s.fake.requests.length, 1);
  s.close();
});

test("1レースだけ確認: 読み取り失敗は parse_error として返し、生のHTMLを残す", async () => {
  const s = await setup(); s.fake.broken.add("19-8-3t"); const f = s.mk();
  const [t3] = await probeRace(s.cfg, s.store, "20260102", 19, 8, { fetcher: f, now: NOW });
  assert.equal(t3.status, "parse_error");
  assert.ok(fs.existsSync(path.join(s.root, "work", "raw_errors", "20260102", "19_08_3t.html")));
  s.close();
});

test("ログ: 上限を超えたら古い行から捨て、新しい行は残す(日本語のバイト数で数える)", () => {
  const line = "あ".repeat(9);                     // 27バイト + 改行 = 28
  const text = Array.from({ length: 10 }, (_, i) => `${i}${line}`).join("\n") + "\n";
  const out = trimLog(text, 100);
  assert.ok(Buffer.byteLength(out) <= 100);
  assert.ok(out.endsWith(`9${line}\n`)); assert.ok(!out.includes(`0${line}`));
  assert.equal(trimLog("short\n", 100), "short\n");
});

test("ログ: ファイルに追記され、同時に書いても行が消えない。読み出しは最後の行から", async () => {
  const s = await setup(); const lg = fileLogger(s.store, { maxBytes: 1000 });
  for (let i = 0; i < 100; i++) lg.append(`line ${i}`);
  await lg.flush();
  const all = await readLog(s.store, { lastLines: 1000 });
  assert.ok(Buffer.byteLength(fs.readFileSync(path.join(s.root, "logs", "run.log"))) <= 1000);
  assert.equal(all[all.length - 1], "line 99");
  const nums = all.map((l) => +l.split(" ")[1]); assert.deepEqual(nums, nums.map((_, i) => nums[0] + i));   // 抜けがない
  assert.deepEqual(await readLog(s.store, { lastLines: 2 }), ["line 98", "line 99"]);
  s.close();
});

test("書き出しの分割: 10日ごとに別のZIP。日付順で、全日が1回ずつ入る", async () => {
  const days = Array.from({ length: 23 }, (_, i) => `202603${String(i + 1).padStart(2, "0")}`).reverse();
  const c = chunkDays(days, 10);
  assert.deepEqual(c.map((x) => x.length), [10, 10, 3]);
  assert.deepEqual(c.flat(), [...days].sort());
  assert.deepEqual(chunkDays(days, 0), [[...days].sort()]);
  assert.deepEqual(chunkDays([], 10), []);
  // 実際に分けて書き出すと、ZIPの名前が重ならない
  const s = await setup();
  const names = []; for (const part of c) names.push((await buildExport(s.store, s.cfg, part)).name);
  assert.deepEqual(names, ["odds_20260301_20260310.zip", "odds_20260311_20260320.zip", "odds_20260321_20260323.zip"]);
  s.close();
});

test("前回の途中経過: 途中で止まった日だけを見つける(raw_errors は数えない)", async () => {
  const s = await setup({ date_range: { start: "2026-03-01", end: "2026-03-31" }, sample: { mode: "list", days: 1, seed: 1 }, dates: ["2026-03-05"], max_pages_per_run: 3 });
  s.fake.calendar["20260305"] = [[2, 1], [2, 2], [19, 1]];
  const st = new State(s.cfg, s.store); await st.init("20261007");
  assert.deepEqual(await findUnfinished(s.cfg, s.store), []);
  const r = await run(s.cfg, st, s.store, { fetcher: s.mk(), now: NOW });                // 3ページで上限 → 1レース分だけ途中経過に残る
  assert.match(r.interrupted, /上限/);
  await s.store.writeText("work/raw_errors/20260301/02_01_3t.html", "<html></html>");
  assert.deepEqual(await findUnfinished(s.cfg, s.store), [{ day: "20260305", races: 1 }]);
  const full = mergeConfig({ ...s.cfg, max_pages_per_run: 700 });
  await run(full, new State(full, s.store), s.store, { fetcher: s.mk(), now: NOW, days: 1 });   // 続きを取れば消える
  assert.deepEqual(await findUnfinished(s.cfg, s.store), []);
  s.close();
});
