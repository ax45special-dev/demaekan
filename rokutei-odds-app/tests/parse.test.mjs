import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePage, ParseError, NoOddsTable } from "../src/core/parse.js";

const fx = (n) => fs.readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
// Python版の読み取り結果(正解)を、同じ形に直して比べる
function toRows(res) {
  const o = {};
  for (const [k, m] of Object.entries(res)) o[k] = [...m.entries()].map(([key, v]) => [...key.split("-").map(Number), v]).sort((a, b) => { for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
  return o;
}
const expected = (n) => JSON.parse(fx(n));

for (const [name, kind] of [["3t_rowspan", "3t"], ["3t_flat", "3t"], ["2tf_normal", "2tf"], ["2tf_absent", "2tf"]]) {
  test(`${name}: Python版の読み取り結果と完全に一致する`, () => {
    assert.deepEqual(toRows(parsePage(kind, fx(name + ".html"))), expected(name + ".expected.json"));
  });
}
test("3連単: rowspanでも空セルでも同じ結果で、120通り", () => {
  const a = parsePage("3t", fx("3t_rowspan.html")).t3, b = parsePage("3t", fx("3t_flat.html")).t3;
  assert.equal(a.size, 120);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});
test("3連単: 実物の表を目で確認した値", () => {
  const a = parsePage("3t", fx("3t_rowspan.html")).t3;
  for (const [k, v] of [["1-2-3", 25.3], ["1-2-6", 18.0], ["1-6-5", 84.6], ["6-1-2", 140.1], ["6-1-5", 389.0], ["6-5-4", 454.3], ["3-4-1", 186.2], ["5-4-2", 580.8], ["5-4-1", 355.2]]) assert.equal(a.get(k), v, k);
});
test("2連単・2連複: 実物の値", () => {
  const r = parsePage("2tf", fx("2tf_normal.html"));
  assert.equal(r.t2.size, 30); assert.equal(r.f2.size, 15);
  assert.equal(r.t2.get("1-2"), 8.9); assert.equal(r.t2.get("6-5"), 126.9); assert.equal(r.f2.get("1-2"), 6.3); assert.equal(r.f2.get("5-6"), 22.8);
});
test("欠場の艇は null、残りは数値", () => {
  const r = parsePage("2tf", fx("2tf_absent.html"));
  assert.equal(r.t2.size, 30); assert.equal(r.t2.get("1-5"), null); assert.equal(r.t2.get("5-1"), null); assert.equal(r.t2.get("1-2"), 4.9); assert.equal(r.f2.get("1-2"), 1.4);
  assert.equal([...r.t2.values()].filter((v) => v !== null).length, 20);
});
test("表が無い/種類が違うページは NoOddsTable", () => {
  assert.throws(() => parsePage("3t", fx("no_table.html")), NoOddsTable);
  assert.throws(() => parsePage("2tf", ""), NoOddsTable);
  assert.throws(() => parsePage("3t", fx("2tf_normal.html")), NoOddsTable);
  assert.throws(() => parsePage("2tf", fx("3t_flat.html")), NoOddsTable);
});
test("構造の崩れ(重複・行の欠け)を検出する", () => {
  assert.throws(() => parsePage("3t", fx("3t_broken.html")), ParseError);
  assert.throws(() => parsePage("3t", fx("3t_missing_row.html")), ParseError);
});
test("小さいオッズの読み違い(25.3→2.5)は、逆数の合計で検出できる", () => {
  assert.throws(() => parsePage("3t", fx("3t_misread_small.html")), ParseError);
});
test("メニュー・広告・コメント・script内の偽の表が混ざっても、オッズの表だけを読む", () => {
  assert.deepEqual(toRows(parsePage("3t", fx("3t_noisy.html"))), expected("3t_flat.expected.json"));
});
test("桁区切りのカンマ", () => { assert.equal(parsePage("3t", fx("3t_comma.html")).t3.get("5-3-2"), 1104); });
test("&nbsp; が混ざっていても同じ結果", () => { assert.deepEqual(toRows(parsePage("3t", fx("3t_entities.html"))), expected("3t_flat.expected.json")); });
