// 公式サイト(boatrace.jp)のオッズページ(odds3t / odds2tf)のHTMLを読み取る。DOMを使わない純JS。
// Python版(odds_tool/parse.py)と同じ動きにしてあり、同じ検証用HTMLで同じ結果になることをテストで確認している。
// 安全装置: ①通り数(3連単120/2連単30/2連複15)と重複・欠けの検査 ②オッズの逆数の合計が1.2〜1.5(実物で1.336〜1.376)
// 限界(実測): ②では、1つの組だけの桁違いは、ほとんど検出できない(10分の1は120通り中22通り、10倍は0通り)。構造の読み違い(行・列のずれ、取り違え)は①で検出できる。
//   単独の組の読み違いは、集めた後の『払戻金との照合』(TASKS.md タスク2)で検出する。

export class ParseError extends Error {}
export class NoOddsTable extends ParseError {}
export const SUM_MIN = 1.2, SUM_MAX = 1.5;

function decode(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}
function clean(s) { return decode(s).replace(/[\u00a0\u3000]/g, " ").replace(/\s+/g, " ").trim(); }
function attr(attrs, name) {
  const m = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}
function span(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 ? n : 1; }

// HTML → 表(セルの配列。rowspan/colspan付き)
export function extractTables(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  const tags = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const tables = [], stack = [];
  let last = 0, m;
  const addText = (t) => { const top = stack[stack.length - 1]; if (top && top.cell) top.cell.text.push(t); };
  while ((m = tags.exec(html))) {
    addText(html.slice(last, m.index));
    last = tags.lastIndex;
    const close = m[1] === "/", tag = m[2].toLowerCase(), attrs = m[3] || "";
    const top = stack[stack.length - 1];
    if (tag === "table" && !close) stack.push({ rows: [], row: null, cell: null });
    else if (tag === "table" && close) { if (top) tables.push(stack.pop().rows); }
    else if (!top) continue;
    else if (tag === "tr" && !close) top.row = [];
    else if (tag === "tr" && close) { if (top.row) { top.rows.push(top.row); top.row = null; } }
    else if ((tag === "td" || tag === "th") && !close) { if (top.row) top.cell = { text: [], rs: span(attr(attrs, "rowspan")), cs: span(attr(attrs, "colspan")) }; }
    else if ((tag === "td" || tag === "th") && close) { if (top.cell) { top.row.push(top.cell); top.cell = null; } }
    else if (tag === "br" && !close && top.cell) top.cell.text.push(" ");
  }
  return tables;
}

// rowspan/colspan を展開して、長方形の表(文字だけ)にする
export function expandTable(rows) {
  const grid = [], carry = new Map();
  for (const row of rows) {
    const out = [];
    const flush = () => {
      while (carry.has(out.length)) {
        const [text, rem] = carry.get(out.length);
        const col = out.length;
        out.push(text);
        if (rem <= 1) carry.delete(col); else carry.set(col, [text, rem - 1]);
      }
    };
    for (const cell of row) {
      flush();
      const text = clean(cell.text.join(""));
      for (let k = 0; k < cell.cs; k++) {
        if (cell.rs > 1) carry.set(out.length, [text, cell.rs - 1]);
        out.push(text);
      }
    }
    flush();
    grid.push(out);
  }
  return grid;
}

const isBoat = (s) => /^[1-6]$/.test(s);
const isOdds = (s) => s === "欠場" || /^\d+(\.\d+)?$/.test(s.replace(/,/g, ""));
const toOdds = (s) => (s === "欠場" ? null : parseFloat(s.replace(/,/g, "")));

function try3t(grid) {
  const data = grid.filter((row) => row.length === 18 &&
    [0, 1, 2, 3, 4, 5].every((g) => (isBoat(row[3 * g]) || row[3 * g] === "") && isBoat(row[3 * g + 1]) && isOdds(row[3 * g + 2])));
  if (data.length < 10) return null;
  const cur = new Array(6).fill(null), result = new Map();
  for (const row of data) {
    for (let g = 0; g < 6; g++) {
      if (row[3 * g] !== "") cur[g] = parseInt(row[3 * g], 10);
      if (cur[g] === null) throw new ParseError("3連単: 最初の行に2着の艇番がありません");
      const key = [g + 1, cur[g], parseInt(row[3 * g + 1], 10)].join("-");
      if (result.has(key)) throw new ParseError("3連単: 同じ組み合わせが2回出ました " + key);
      result.set(key, toOdds(row[3 * g + 2]));
    }
  }
  return result;
}

function try2(grid) {
  const data = []; let blanks = 0;
  for (const row of grid) {
    if (row.length !== 12) continue;
    let ok = true, nb = 0;
    for (let g = 0; g < 6; g++) {
      const s = row[2 * g], o = row[2 * g + 1];
      if (s === "" && o === "") nb++;
      else if (!(isBoat(s) && isOdds(o))) { ok = false; break; }
    }
    if (ok && nb < 6) { data.push(row); blanks += nb; }
  }
  if (data.length < 5) return null;
  const result = new Map();
  for (const row of data) {
    for (let g = 0; g < 6; g++) {
      const s = row[2 * g];
      if (s === "") continue;
      const key = (g + 1) + "-" + parseInt(s, 10);
      if (result.has(key)) throw new ParseError("2連: 同じ組み合わせが2回出ました " + key);
      result.set(key, toOdds(row[2 * g + 1]));
    }
  }
  return [blanks === 0 ? "t2" : "f2", result];
}

function expectKeys(kind) {
  const keys = new Set(), b = [1, 2, 3, 4, 5, 6];
  if (kind === "t3") for (const x of b) for (const y of b) for (const z of b) { if (x !== y && y !== z && x !== z) keys.add(`${x}-${y}-${z}`); }
  else if (kind === "t2") for (const x of b) for (const y of b) { if (x !== y) keys.add(`${x}-${y}`); }
  else for (const x of b) for (const y of b) { if (x < y) keys.add(`${x}-${y}`); }
  return keys;
}

function check(kind, map) {
  const expect = expectKeys(kind);
  const missing = [...expect].filter((k) => !map.has(k)).length, extra = [...map.keys()].filter((k) => !expect.has(k)).length;
  if (missing || extra) throw new ParseError(`${kind}: 組み合わせが合いません(欠け ${missing} / 余り ${extra})`);
  const nums = [...map.values()].filter((v) => v !== null);
  if (!nums.length) throw new NoOddsTable(`${kind}: オッズが1つもありません(全艇欠場など)`);
  if (nums.some((v) => v <= 0)) throw new ParseError(`${kind}: 0以下のオッズがあります`);
  const s = nums.reduce((a, v) => a + 1 / v, 0);
  if (!(s >= SUM_MIN && s <= SUM_MAX)) throw new ParseError(`${kind}: オッズの逆数の合計が ${s.toFixed(3)} で、想定の範囲(${SUM_MIN}〜${SUM_MAX})外です。数字の読み違いの可能性`);
  return s;
}

// kind='3t' → {t3: Map("1-2-3"→オッズ)} / kind='2tf' → {t2: Map("1-2"→..), f2: Map("1-2"→..)}。欠場はnull。
export function parsePage(kind, html) {
  const grids = extractTables(html).map(expandTable);
  const found = {};
  for (const g of grids) {
    const r3 = try3t(g);
    if (r3) { found.t3 ??= r3; continue; }
    const r2 = try2(g);
    if (r2) found[r2[0]] ??= r2[1];
  }
  const out = {};
  for (const k of kind === "3t" ? ["t3"] : ["t2", "f2"]) {
    if (!found[k]) throw new NoOddsTable(Object.keys(found).length || grids.some((g) => g.length > 5) ? `${k} の表が見つかりません` : "オッズの表が見つかりません");
    check(k, found[k]);
    out[k] = found[k];
  }
  return out;
}

export const keyToNums = (k) => k.split("-").map(Number);
