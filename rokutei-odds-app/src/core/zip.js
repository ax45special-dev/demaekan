// ZIP(圧縮なし)とBase64。OpenApiCollector で実機検証済み・PythonとunzipでZIPが開けることを確認済みの部品をそのまま移した。
export function utf8Bytes(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) { n += 4; i++; }
    else n += 3;
  }
  const out = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { out[p++] = c; }
    else if (c < 0x800) { out[p++] = 0xc0 | (c >> 6); out[p++] = 0x80 | (c & 63); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out[p++] = 0xf0 | (c >> 18); out[p++] = 0x80 | ((c >> 12) & 63); out[p++] = 0x80 | ((c >> 6) & 63); out[p++] = 0x80 | (c & 63);
    } else { out[p++] = 0xe0 | (c >> 12); out[p++] = 0x80 | ((c >> 6) & 63); out[p++] = 0x80 | (c & 63); }
  }
  return out;
}
let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function buildZip(files, now) {
  const d = now || new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())) & 0xffff;
  const entries = files.map((f) => ({ nameBytes: utf8Bytes(f.name), bytes: f.bytes, crc: crc32(f.bytes), offset: 0 }));
  let total = 22;
  for (const e of entries) total += 30 + e.nameBytes.length + e.bytes.length + 46 + e.nameBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    e.offset = p;
    dv.setUint32(p, 0x04034b50, true); p += 4;
    dv.setUint16(p, 20, true); p += 2;
    dv.setUint16(p, 0x0800, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, dosTime, true); p += 2;
    dv.setUint16(p, dosDate, true); p += 2;
    dv.setUint32(p, e.crc, true); p += 4;
    dv.setUint32(p, e.bytes.length, true); p += 4;
    dv.setUint32(p, e.bytes.length, true); p += 4;
    dv.setUint16(p, e.nameBytes.length, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    out.set(e.nameBytes, p); p += e.nameBytes.length;
    out.set(e.bytes, p); p += e.bytes.length;
  }
  const cdStart = p;
  for (const e of entries) {
    dv.setUint32(p, 0x02014b50, true); p += 4;
    dv.setUint16(p, 20, true); p += 2;
    dv.setUint16(p, 20, true); p += 2;
    dv.setUint16(p, 0x0800, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, dosTime, true); p += 2;
    dv.setUint16(p, dosDate, true); p += 2;
    dv.setUint32(p, e.crc, true); p += 4;
    dv.setUint32(p, e.bytes.length, true); p += 4;
    dv.setUint32(p, e.bytes.length, true); p += 4;
    dv.setUint16(p, e.nameBytes.length, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint32(p, 0, true); p += 4;
    dv.setUint32(p, e.offset, true); p += 4;
    out.set(e.nameBytes, p); p += e.nameBytes.length;
  }
  const cdSize = p - cdStart;
  dv.setUint32(p, 0x06054b50, true); p += 4;
  dv.setUint16(p, 0, true); p += 2;
  dv.setUint16(p, 0, true); p += 2;
  dv.setUint16(p, entries.length, true); p += 2;
  dv.setUint16(p, entries.length, true); p += 2;
  dv.setUint32(p, cdSize, true); p += 4;
  dv.setUint32(p, cdStart, true); p += 4;
  dv.setUint16(p, 0, true); p += 2;
  return out;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes) {
  const parts = [];
  const CH = 3 * 16384;
  for (let s = 0; s < bytes.length; s += CH) {
    const end = Math.min(bytes.length, s + CH);
    let str = '';
    let i = s;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      str += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rem = end - i;
    if (rem === 1) { const n = bytes[i] << 16; str += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '=='; }
    else if (rem === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); str += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='; }
    parts.push(str);
  }
  return parts.join('');
}


// ---- 書き出し: 取った日のデータを、1つのZIPにまとめる ----
import { iso } from "./state.js";
export const exportName = (days) => `odds_${days[0]}_${days[days.length - 1]}.zip`;

// store から、指定した日のCSV/メタを読んで、ZIPのバイト列にする。戻り値 {name, bytes, files}
export async function buildExport(store, cfg, days, nowIso = new Date().toISOString()) {
  const files = [];
  const names = ["odds_3t.csv", "odds_2t.csv", "odds_2f.csv", "races.csv", "meta.json"];
  for (const d of days) {
    for (const n of names) {
      const p = `${cfg.data_dir}/${iso(d)}/${n}`;
      if (await store.exists(p)) files.push({ name: `${iso(d)}/${n}`, bytes: utf8Bytes(await store.readText(p)) });
    }
  }
  files.push({ name: "README.txt", bytes: utf8Bytes(EXPORT_README) });
  files.push({ name: "manifest.json", bytes: utf8Bytes(JSON.stringify({ exported_at: nowIso, days, files: files.length }, null, 1)) });
  const sorted = [...days].sort();
  return { name: exportName(sorted), bytes: buildZip(files), files: files.length };
}
const EXPORT_README = [
  "公式サイト(boatrace.jp)の締切時オッズ(3連単・2連単・2連複)です。日ごとのフォルダに入っています。",
  "odds_3t.csv: stadium,race,first,second,third,odds   (欠場の艇の組は odds が空欄)",
  "odds_2t.csv: stadium,race,first,second,odds / odds_2f.csv: stadium,race,a,b,odds(2連複。a<b)",
  "races.csv: レースごとの取得状態 (ok / no_data=表なし・中止など / parse_error=読み取り失敗)。meta.json: その日の取得結果。",
  "オッズは100円あたりの払戻倍率。stadium=場番号(1=桐生 2=戸田 3=江戸川 4=平和島 5=多摩川 6=浜名湖 7=蒲郡 8=常滑 9=津 10=三国 11=びわこ 12=住之江 13=尼崎 14=鳴門 15=丸亀 16=児島 17=宮島 18=徳山 19=下関 20=若松 21=芦屋 22=福岡 23=唐津 24=大村)。",
  "締切時オッズ=発売票数の集計が完了した時点のオッズ。レース開始後の返還・欠場による変動は反映されません。",
].join("\n");
