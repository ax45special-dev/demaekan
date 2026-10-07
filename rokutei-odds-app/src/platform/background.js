// 画面を消しても動かすための「フォアグラウンドサービス」(通知を出しながら、JavaScriptを動かし続ける)。
// ※実機でしか確認できない部分です(私は実機テストができていません)。うまく動かない時は、アプリの
//   『画面をつけたまま実行』(expo-keep-awake)が、同じ取得を確実に行います。
// 使うライブラリ: react-native-background-actions(Android 12以降は、アプリを開いている時に開始する必要があります)
import BackgroundService from "react-native-background-actions";

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// work(): 取得の本体。stopRequested() が true になったら、きりのよい所で戻ること。
export async function startBackground(work, { title = "オッズ収集中", desc = "開始します…" } = {}) {
  const task = async () => { await work(() => !BackgroundService.isRunning()); };
  await BackgroundService.start(task, {
    taskName: "odds-collect",
    taskTitle: title,
    taskDesc: desc,
    taskIcon: { name: "ic_launcher", type: "mipmap" },
    color: "#5b8def",
    linkingURI: "rokuteiodds://",
    // Android 14以降は、フォアグラウンドサービスの種類の宣言が必要(AndroidManifest側にも dataSync を宣言済み)。
    // キー名は単数形 foregroundServiceType(v4.1.0 の src/index.js で確認。複数形だと無視され、種類0で開始される)
    foregroundServiceType: ["dataSync"],
  });
}
export const stopBackground = async () => { await BackgroundService.stop(); };
export const isBackgroundRunning = () => BackgroundService.isRunning();
export const updateNotification = async (desc) => { if (BackgroundService.isRunning()) await BackgroundService.updateNotification({ taskDesc: desc }); };
export { sleepMs };
