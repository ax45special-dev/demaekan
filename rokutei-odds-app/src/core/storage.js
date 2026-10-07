// 1日分の結果を、CSVで保存する(スマホの容量を考えて、圧縮はせず、書き出し時にZIPにまとめる)。
//   data/YYYY-MM-DD/odds_3t.csv   stadium,race,first,second,third,odds   (欠場のオッズは空欄)
//   data/YYYY-MM-DD/odds_2t.csv   stadium,race,first,second,odds
//   data/YYYY-MM-DD/odds_2f.csv   stadium,race,a,b,odds
//   data/YYYY-MM-DD/races.csv     stadium,race,status_3t,status_2tf,note  (どのレースが取れた/取れなかったか)
//   data/YYYY-MM-DD/meta.json
import { iso } from "./state.js";

const esc = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (header, rows) => [header.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";
export const dayDir = (dataDir, day) => `${dataDir}/${iso(day)}`;

export async function writeDay(store, dataDir, day, work, betTypes, meta) {
  const dir = dayDir(dataDir, day);
  const r3 = [], r2 = [], rf = [], rs = [];
  const keys = [...work.keys()].sort((a, b) => { const [x, y] = a.split("-").map(Number), [p, q] = b.split("-").map(Number); return x - p || y - q; });
  for (const k of keys) {
    const w = work.get(k), a = w.r3t, b = w.r2tf, [jcd, rno] = k.split("-").map(Number);
    if (a && a.status === "ok") for (const [f, s, t, o] of a.odds) r3.push([jcd, rno, f, s, t, o]);
    if (b && b.status === "ok") { for (const [f, s, o] of b.t2) r2.push([jcd, rno, f, s, o]); for (const [x, y, o] of b.f2) rf.push([jcd, rno, x, y, o]); }
    rs.push([jcd, rno, a?.status ?? "-", b?.status ?? "-", [a, b].filter((x) => x && x.note).map((x) => x.note).join("; ")]);
  }
  if (betTypes.includes("3t")) await store.writeText(`${dir}/odds_3t.csv`, csv(["stadium", "race", "first", "second", "third", "odds"], r3));
  if (betTypes.includes("2tf")) {
    await store.writeText(`${dir}/odds_2t.csv`, csv(["stadium", "race", "first", "second", "odds"], r2));
    await store.writeText(`${dir}/odds_2f.csv`, csv(["stadium", "race", "a", "b", "odds"], rf));
  }
  await store.writeText(`${dir}/races.csv`, csv(["stadium", "race", "status_3t", "status_2tf", "note"], rs));
  await store.writeJson(`${dir}/meta.json`, meta);
  return dir;
}
