// ROKUTEI オッズ収集 — 画面。取得の中身は src/core/(Node上でテスト済み)にあり、ここは操作と表示だけ。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, PermissionsAndroid, Platform, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Sharing from "expo-sharing";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { mergeConfig, DEFAULTS } from "./src/core/config.js";
import { State, iso, todayJst } from "./src/core/state.js";
import { run } from "./src/core/runner.js";
import { buildExport, toBase64 } from "./src/core/zip.js";
import { probeRace, formatProbe, fileLogger, readLog, chunkDays, findUnfinished } from "./src/core/extras.js";
import { expoStore as store } from "./src/platform/expoStore.js";
import { startBackground, stopBackground, isBackgroundRunning, updateNotification } from "./src/platform/background.js";

const SETTINGS = "settings.json";
const fileLog = fileLogger(store);   // logs/run.log(最大1MB、古い行から捨てる)
const C = { bg: "#111", card: "#1a1a1a", text: "#eee", mute: "#999", blue: "#5b8def", green: "#8ecf8e", warn: "#e8c466", red: "#e07070" };

export default function App() {
  const [form, setForm] = useState({ days: "30", start: DEFAULTS.date_range.start, end: DEFAULTS.date_range.end, interval: "5", daysPerRun: "1", maxPages: "700", t3: true, t2: true, window: false, wStart: "01:00", wEnd: "07:00", zipDays: "10", pDate: "2026-01-02", pJcd: "19", pRno: "8" });
  const [snap, setSnap] = useState({ pending: [], done: {}, failed: {} });
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [probe, setProbe] = useState("");
  const [fileLines, setFileLines] = useState(null);
  const [unfinished, setUnfinished] = useState([]);
  const stopRef = useRef(false);

  const log = useCallback((m) => {
    setLogs((l) => [`${new Date().toLocaleTimeString("ja-JP")} ${m}`, ...l].slice(0, 80));
    fileLog.append(`${new Date().toISOString()} ${m}`);
  }, []);
  const cfgFromForm = useCallback(() => mergeConfig({
    date_range: { start: form.start, end: form.end }, sample: { ...DEFAULTS.sample, days: parseInt(form.days, 10) || 30, seed: null },
    bet_types: [form.t3 && "3t", form.t2 && "2tf"].filter(Boolean), interval_sec: parseFloat(form.interval), days_per_run: parseInt(form.daysPerRun, 10) || 1,
    max_pages_per_run: parseInt(form.maxPages, 10) || 700, run_window_jst: form.window ? { start: form.wStart, end: form.wEnd } : null,
  }), [form]);

  const refresh = useCallback(async () => { const st = new State(DEFAULTS, store); setSnap({ pending: await st.pending(), done: await st.done(), failed: await st.failed() }); setUnfinished(await findUnfinished(DEFAULTS, store)); }, []);
  useEffect(() => { (async () => {
    const s = await store.readJson(SETTINGS, null); if (s) setForm((f) => ({ ...f, ...s })); await refresh();
    const bg = await isBackgroundRunning().catch(() => false); if (bg) setRunning(true);
    const u = await findUnfinished(DEFAULTS, store);
    if (u.length && !bg) log(`前回は途中で止まりました: ${u.map((x) => `${iso(x.day)}(${x.races}レース取得済み)`).join(", ")}。もう一度実行すると、続きから取ります`);
  })(); }, [refresh, log]);
  useEffect(() => { store.writeJson(SETTINGS, form); }, [form]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const guard = async (fn) => { try { await fn(); } catch (e) { Alert.alert("エラー", String(e.message || e)); } };

  const doInit = (random) => guard(async () => {
    const cfg = cfgFromForm(); const st = new State(cfg, store);
    const added = await st.init(todayJst(), random ?? null); log(`取る日を ${added.length} 日追加しました`); await refresh();
  });
  const work = async (shouldStop, foreground) => {
    const cfg = cfgFromForm(); const st = new State(cfg, store);
    try {
      // 通知の更新に失敗しても、取得は続ける
      const r = await run(cfg, st, store, { log: (m) => { log(m); if (!foreground) updateNotification(m.slice(0, 60)).catch(() => {}); }, shouldStop, ignoreWindow: foreground });
      log(`今回: 取れた日 ${r.done.map(iso).join(", ") || "なし"}${r.failed.length ? ` / 飛ばした日(次回また取る) ${r.failed.map(iso).join(", ")}` : ""} / ページ ${r.pages}${r.interrupted ? " / 中断: " + r.interrupted : ""}`);
    } catch (e) { log("■ エラー: " + (e && e.message ? e.message : e)); }
    await refresh().catch(() => {});
  };
  const startFg = () => guard(async () => {
    cfgFromForm(); stopRef.current = false; setRunning(true); await activateKeepAwakeAsync();
    try { await work(() => stopRef.current, true); } finally { deactivateKeepAwake(); setRunning(false); }
  });
  const startBg = () => guard(async () => {
    cfgFromForm(); stopRef.current = false;
    if (Platform.OS === "android" && Platform.Version >= 33) await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS"); // 通知が出ないと、サービスを開始できない
    setRunning(true);
    await startBackground(async (bgStop) => { await work(() => bgStop() || stopRef.current, false); }, { title: "オッズ収集中", desc: "公式サイトから、間隔を空けて取得しています" });
    setRunning(false); await refresh();
  });
  const stop = () => { stopRef.current = true; stopBackground().catch(() => {}); log("停止します(今のページを取り終えたら止まります)"); };
  const share = () => guard(async () => {
    const cfg = cfgFromForm(); const days = Object.keys(snap.done).sort().filter((d) => snap.done[d].races > 0 && !snap.done[d].data_deleted);   // 削除済みの日は、ファイルが無いので書き出さない
    if (!days.length) return Alert.alert("書き出せる日がありません", "まだ取れていないか、すべて削除済みです。");
    const parts = chunkDays(days, parseInt(form.zipDays, 10) || 0);   // N日ごとに別のZIP(0=分けない)
    for (const [i, part] of parts.entries()) {
      const e = await buildExport(store, cfg, part); const uri = await store.writeBase64("export/" + e.name, toBase64(e.bytes));
      await Sharing.shareAsync(uri, { mimeType: "application/zip", UTI: "public.zip-archive", dialogTitle: `${e.name}(${i + 1}/${parts.length})` });
      const st = new State(cfg, store); const done = await st.done(); for (const d of part) done[d].exported_at = new Date().toISOString();   // 共有できた分だけ、印を付ける
      await store.writeJson(cfg.state_dir + "/done.json", { days: done }); log(`${part.length}日分を書き出しました(${e.name}、${i + 1}/${parts.length})`);
    }
    await refresh();
  });
  const doProbe = () => guard(async () => {
    const cfg = cfgFromForm(); setRunning(true); setProbe("取得中…(間隔を空けて、2ページ取ります)");
    try {
      const r = await probeRace(cfg, store, form.pDate.replace(/-/g, ""), parseInt(form.pJcd, 10), parseInt(form.pRno, 10));
      const txt = formatProbe(r); setProbe(txt); log(`1レース確認 ${form.pDate} 場${form.pJcd} ${form.pRno}R: ${txt.replace(/\n/g, " / ")}`);
    } catch (e) { setProbe("失敗: " + (e.message || e)); throw e; } finally { setRunning(false); }
  });
  const showFileLog = () => guard(async () => { await fileLog.flush(); setFileLines((await readLog(store, { lastLines: 200 })).reverse()); });
  const deleteExported = () => Alert.alert("共有済みのデータを削除", "共有(書き出し)した日の、オッズのファイルを端末から消します。\nチャットなどに送れたことを確認してから実行してください。元に戻せません。", [
    { text: "やめる", style: "cancel" },
    { text: "削除する", style: "destructive", onPress: () => guard(async () => {
      const cfg = cfgFromForm(); const done = await new State(cfg, store).done(); let n = 0;
      for (const [d, v] of Object.entries(done)) if (v.exported_at && !v.data_deleted) { await store.remove(`${cfg.data_dir}/${iso(d)}`); v.data_deleted = true; n++; }
      await store.writeJson(cfg.state_dir + "/done.json", { days: done }); await refresh(); log(`${n}日分のデータを削除しました`);
    }) },
  ]);
  const requeue = () => guard(async () => { const d = await new State(cfgFromForm(), store).requeue(); log(`${d.length}日を未取得リストに戻しました`); await refresh(); });

  const doneDays = Object.keys(snap.done).sort(), failedDays = Object.keys(snap.failed).sort();
  const gave = failedDays.filter((d) => snap.failed[d].gave_up);
  const review = doneDays.filter((d) => snap.done[d].parse_errors > 0);
  const perDay = (parseInt(form.interval, 10) || 5) * (form.t3 && form.t2 ? 2 : 1) * 150 / 60;
  return (
    <SafeAreaView style={s.root}><ScrollView contentContainerStyle={s.pad}>
      <Text style={s.h1}>ROKUTEI オッズ収集</Text>
      <Text style={s.mute}>公式サイトの締切時オッズ(3連単・2連単・2連複)を、間隔を空けて1件ずつ取得します。公式の許可の範囲で使ってください。</Text>

      <Text style={s.h2}>① 取る日を決める</Text>
      <Row label="ランダムに何日分"><In v={form.days} on={set("days")} num /></Row>
      <Row label="期間(この中から選ぶ)"><In v={form.start} on={set("start")} w={110} /><Text style={s.mute}> 〜 </Text><In v={form.end} on={set("end")} w={110} /></Row>
      <Btn t="取る日を決める(ランダム)" on={() => doInit(null)} /><Btn t="さらに5日、ランダムに追加" on={() => doInit(5)} sub />

      <Text style={s.h2}>② 取り方の設定</Text>
      <Row label="間隔(秒・最小3)"><In v={form.interval} on={set("interval")} num /></Row>
      <Row label="1回に何日分"><In v={form.daysPerRun} on={set("daysPerRun")} num /></Row>
      <Row label="1回の最大ページ数"><In v={form.maxPages} on={set("maxPages")} num /></Row>
      <Row label="3連単"><Switch value={form.t3} onValueChange={set("t3")} /></Row>
      <Row label="2連単・2連複"><Switch value={form.t2} onValueChange={set("t2")} /></Row>
      <Row label="実行時間帯を限る(裏で実行の時)"><Switch value={form.window} onValueChange={set("window")} /></Row>
      {form.window && <Row label="時間帯(日本時間)"><In v={form.wStart} on={set("wStart")} w={70} /><Text style={s.mute}> 〜 </Text><In v={form.wEnd} on={set("wEnd")} w={70} /></Row>}
      <Text style={s.mute}>1日(約150レース)の目安: 約{perDay.toFixed(0)}分</Text>

      <Text style={s.h2}>1レースだけ確認(保存しない)</Text>
      <Row label="日付(YYYY-MM-DD)"><In v={form.pDate} on={set("pDate")} w={110} /></Row>
      <Row label="場番号 / R"><In v={form.pJcd} on={set("pJcd")} num w={50} /><Text style={s.mute}>  </Text><In v={form.pRno} on={set("pRno")} num w={50} /></Row>
      {!running && <Btn t="このレースだけ取って確認" on={doProbe} sub />}
      {probe !== "" && <Text style={s.t}>{probe}</Text>}
      <Text style={s.mute}>例: 2026-01-02 下関(19) 8R は、3連単 1-3-2 = 6.8、2連単 1-3 = 3.8(払戻金で確認済み)。</Text>

      <Text style={s.h2}>③ 実行</Text>
      {!running ? (<>
        <Btn t="画面をつけたまま実行(確実)" on={startFg} />
        <Btn t="裏で実行(画面OFFでもOK・要実機確認)" on={startBg} sub />
        <Text style={s.mute}>裏で実行する時は、充電しながら、このアプリの電池の最適化を『制限なし』にすると、止まりにくくなります。</Text>
      </>) : <Btn t="停止" on={stop} danger />}

      <Text style={s.h2}>状況</Text>
      <Text style={s.t}>まだ取っていない日: {snap.pending.length}日{snap.pending.length ? `(次: ${snap.pending.slice(0, 3).map(iso).join(", ")})` : ""}</Text>
      <Text style={s.t}>取れた日: {doneDays.length}日 / レース {doneDays.reduce((a, d) => a + (snap.done[d].races || 0), 0)}</Text>
      {review.length > 0 && <Text style={s.warn}>⚠ 読み取り失敗を含む日: {review.map(iso).join(", ")}</Text>}
      {unfinished.length > 0 && !running && <Text style={s.warn}>⚠ 前回は途中で止まりました: {unfinished.map((x) => `${iso(x.day)}(${x.races}レース取得済み)`).join(", ")}。もう一度実行すると、続きから取ります。</Text>}
      <Text style={s.t}>取れていない日(失敗・中断): {failedDays.length}日</Text>
      {failedDays.map((d) => <Text key={d} style={s.warn}>{iso(d)} {snap.failed[d].attempts}回目{snap.failed[d].gave_up ? "【諦め】" : ""} {snap.failed[d].last_reason}</Text>)}
      {gave.length > 0 && <Btn t="諦めた日を、未取得に戻す" on={requeue} sub />}

      <Text style={s.h2}>④ 書き出し</Text>
      <Row label="1つのZIPに入れる日数(0=分けない)"><In v={form.zipDays} on={set("zipDays")} num /></Row>
      <Btn t="取れた日をZIPにして共有" on={share} /><Btn t="共有済みの日のデータを端末から削除" on={deleteExported} sub />

      <Text style={s.h2}>ログ</Text>
      <Btn t={fileLines ? "ログファイルを閉じる" : "ログファイル(logs/run.log)を表示"} on={() => (fileLines ? setFileLines(null) : showFileLog())} sub />
      {(fileLines ?? logs).map((l, i) => <Text key={i} style={s.log}>{l}</Text>)}
    </ScrollView></SafeAreaView>
  );
}

const Row = ({ label, children }) => <View style={s.row}><Text style={[s.t, { flex: 1 }]}>{label}</Text>{children}</View>;
const In = ({ v, on, num, w = 70, ph }) => <TextInput style={[s.in, { width: w }]} value={String(v)} onChangeText={on} keyboardType={num ? "numeric" : "default"} placeholder={ph} placeholderTextColor="#666" autoCapitalize="none" />;
const Btn = ({ t, on, sub, danger }) => <TouchableOpacity style={[s.btn, sub && s.btnSub, danger && s.btnDanger]} onPress={on}><Text style={s.btnT}>{t}</Text></TouchableOpacity>;
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }, pad: { padding: 16, paddingBottom: 60 },
  h1: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 6 }, h2: { color: C.text, fontSize: 15, fontWeight: "700", marginTop: 20, marginBottom: 8 },
  t: { color: C.text, fontSize: 13, marginVertical: 2 }, mute: { color: C.mute, fontSize: 12, lineHeight: 18 }, warn: { color: C.warn, fontSize: 12, marginVertical: 1 }, log: { color: C.mute, fontSize: 11, marginVertical: 1 },
  row: { flexDirection: "row", alignItems: "center", marginVertical: 3 }, in: { backgroundColor: "#222", color: C.text, padding: 8, borderRadius: 6, fontSize: 13 },
  btn: { backgroundColor: C.blue, padding: 13, borderRadius: 8, alignItems: "center", marginTop: 8 }, btnSub: { backgroundColor: "#3a4660" }, btnDanger: { backgroundColor: "#b04040" }, btnT: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
