// テスト用の store(fs版)。アプリでは expo-file-system 版を使う。
import fs from "node:fs";
import path from "node:path";
export function nodeStore(root) {
  const p = (x) => path.join(root, x);
  return {
    async readJson(x, def) { try { return JSON.parse(fs.readFileSync(p(x), "utf8")); } catch { return def; } },
    async writeJson(x, o) { fs.mkdirSync(path.dirname(p(x)), { recursive: true }); fs.writeFileSync(p(x), JSON.stringify(o)); },
    async readText(x) { return fs.readFileSync(p(x), "utf8"); },
    async writeText(x, t) { fs.mkdirSync(path.dirname(p(x)), { recursive: true }); fs.writeFileSync(p(x), t); },
    async remove(x) { fs.rmSync(p(x), { recursive: true, force: true }); },
    async list(x) { try { return fs.readdirSync(p(x)); } catch { return []; } },
    async exists(x) { return fs.existsSync(p(x)); },
  };
}
