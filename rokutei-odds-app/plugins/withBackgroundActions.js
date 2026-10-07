// react-native-background-actions に必要な権限とサービスを、AndroidManifest に追加する Expo 設定プラグイン。
// ※実機ビルドでしか確認できません。ビルドが失敗する/起動直後に落ちる場合は、READMEの『うまくいかない時』を見てください。
const { withAndroidManifest } = require("@expo/config-plugins");

const PERMS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.WAKE_LOCK",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.INTERNET",
];
const SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";

module.exports = function withBackgroundActions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    for (const p of PERMS) {
      if (!manifest["uses-permission"].some((x) => x.$["android:name"] === p)) manifest["uses-permission"].push({ $: { "android:name": p } });
    }
    const app = manifest.application[0];
    app.service = app.service || [];
    const found = app.service.find((s) => s.$["android:name"] === SERVICE);
    if (found) found.$["android:foregroundServiceType"] = "dataSync";
    else app.service.push({ $: { "android:name": SERVICE, "android:foregroundServiceType": "dataSync", "android:exported": "false" } });
    return cfg;
  });
};
