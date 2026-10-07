// expo-file-system を使った store。アプリの専用フォルダ(documentDirectory)の中に保存する。
// ※実機でしか確認できない部分。Expo SDK 54 以降は legacy API を使う。
import * as FileSystem from "expo-file-system/legacy";

const root = () => FileSystem.documentDirectory;
const uri = (p) => root() + p;
async function ensureDir(path) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await FileSystem.makeDirectoryAsync(uri(dir), { intermediates: true }).catch(() => {});
}

export const expoStore = {
  async exists(p) { return (await FileSystem.getInfoAsync(uri(p))).exists; },
  async readText(p) { return FileSystem.readAsStringAsync(uri(p), { encoding: FileSystem.EncodingType.UTF8 }); },
  async writeText(p, t) { await ensureDir(p); await FileSystem.writeAsStringAsync(uri(p), t, { encoding: FileSystem.EncodingType.UTF8 }); },
  async readJson(p, def) { try { if (!(await this.exists(p))) return def; return JSON.parse(await this.readText(p)); } catch { return def; } },
  async writeJson(p, o) { await this.writeText(p, JSON.stringify(o)); },
  async remove(p) { await FileSystem.deleteAsync(uri(p), { idempotent: true }); },
  async list(dir) { try { return await FileSystem.readDirectoryAsync(uri(dir)); } catch { return []; } },
  // ZIP等のバイナリ(base64)を一時フォルダに書く。共有用
  async writeBase64(p, b64) { await ensureDir(p); await FileSystem.writeAsStringAsync(uri(p), b64, { encoding: FileSystem.EncodingType.Base64 }); return uri(p); },
};
