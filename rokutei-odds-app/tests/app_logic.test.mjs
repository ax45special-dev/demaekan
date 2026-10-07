// App.js が行う「核の呼び出し」を、画面なしで通す。ZIP書き出し→共有済みの印→削除、の流れも確認する。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeConfig } from "../src/core/config.js";
import { State, iso } from "../src/core/state.js";
import { Fetcher } from "../src/core/net.js";
import { run } from "../src/core/runner.js";
import { buildExport, toBase64 } from "../src/core/zip.js";
import { nodeStore } from "./nodeStore.mjs";
import { Fake, start } from "./fakeserver.mjs";

test("取得 → ZIP書き出し → 共有済みの印 → 削除。削除後も『取れた日』の記録は残る", async () => {
  const fake = new Fake(); const { server, base } = await start(fake);
  for (const d of ["20260305", "20260309"]) fake.calendar[d] = [[2, 1], [19, 8]];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odds-app-")), store = nodeStore(root);
  const cfg = mergeConfig({ base_url: base, calendar_base_url: base, interval_sec: 3, jitter: 0, date_range: { start: "2026-03-01", end: "2026-03-31" }, sample: { mode: "list", days: 2, seed: 1 }, dates: ["2026-03-05", "2026-03-09"] });
  const st = new State(cfg, store); await st.init("20261007");
  assert.deepEqual(await st.pending(), ["20260305", "20260309"]);
  let t = 0; const f = new Fetcher(cfg, { sleep: async (ms) => { t += ms; }, now: () => t });
  await run(cfg, st, store, { days: 2, fetcher: f, now: new Date("2026-10-06T18:00:00Z") });
  assert.deepEqual(await st.pending(), []); assert.deepEqual(Object.keys(await st.done()), ["20260305", "20260309"]);

  // App.js の share() と同じ手順
  const days = Object.entries(await st.done()).filter(([, v]) => v.races > 0 && !v.data_deleted).map(([d]) => d).sort();   // App.js の share() と同じ絞り込み
  const e = await buildExport(store, cfg, days);
  const b64 = toBase64(e.bytes); assert.ok(b64.length > 100); assert.equal(e.name, "odds_20260305_20260309.zip");
  const done = await st.done(); for (const d of days) done[d].exported_at = "2026-10-07T00:00:00Z";
  await store.writeJson(cfg.state_dir + "/done.json", { days: done });

  // App.js の deleteExported() と同じ手順
  const done2 = await new State(cfg, store).done(); let n = 0;
  for (const [d, v] of Object.entries(done2)) if (v.exported_at && !v.data_deleted) { await store.remove(`${cfg.data_dir}/${iso(d)}`); v.data_deleted = true; n++; }
  await store.writeJson(cfg.state_dir + "/done.json", { days: done2 });
  assert.equal(n, 2); assert.ok(!fs.existsSync(path.join(root, "data", "2026-03-05")));      // CSVは消える
  const after = await new State(cfg, store).done(); assert.ok(after["20260305"].data_deleted); assert.equal(after["20260305"].races, 2);   // 『取った』記録は残る
  assert.deepEqual(await new State(cfg, store).pending(), []);                                // 取った日が、また未取得に戻ることはない
  // 削除後に、もう一度『書き出し』を押しても、削除済みの日は対象にならない(空のZIPを作らない)
  const again = Object.entries(after).filter(([, v]) => v.races > 0 && !v.data_deleted).map(([d]) => d);
  assert.deepEqual(again, []);
  server.close(); fs.rmSync(root, { recursive: true, force: true });
});
