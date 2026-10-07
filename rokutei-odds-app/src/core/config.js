// 設定。スマホアプリでは、画面で変えた値を settings.json に保存して、ここに重ねる。
export const MIN_INTERVAL = 3.0; // 安全のための下限(秒)。設定でも、これより短くはできない
export const DEFAULTS = {
  date_range: { start: "2025-10-06", end: "2026-10-05" },
  sample: { mode: "random", days: 30, seed: 20261006, balance_months: true }, // random=期間からN日 / range=期間の全日 / list=dates の日だけ
  dates: [],
  bet_types: ["3t", "2tf"], // 3t=3連単 / 2tf=2連単+2連複(同じページ)
  stadiums: null, // null=全場。絞るなら場番号の配列
  interval_sec: 5.0,
  jitter: 0.2,
  days_per_run: 1,
  max_pages_per_run: 700,
  run_window_jst: null, // 例 {start:"01:00", end:"07:00"}
  respect_robots: true,
  max_consecutive_errors: 5,
  max_consecutive_parse_errors: 3,
  max_attempts_per_day: 3,
  base_url: "https://www.boatrace.jp",
  calendar_base_url: "https://boatraceopenapi.github.io",
  user_agent: "rokutei-lab-odds-research/1.0 (personal research)",
  state_dir: "state",
  data_dir: "data",
  work_dir: "work",
};

export function mergeConfig(over = {}) {
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(a[k], v) : v;
    return out;
  };
  const cfg = merge(DEFAULTS, over);
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  const errs = [];
  if (!(cfg.interval_sec >= MIN_INTERVAL)) errs.push(`interval_sec は ${MIN_INTERVAL} 秒以上にしてください(公式サイトへの負荷を避けるための下限です)`);
  if (!cfg.bet_types.length || !cfg.bet_types.every((t) => t === "3t" || t === "2tf")) errs.push("bet_types は '3t' と '2tf' の組み合わせにしてください");
  if (!["random", "range", "list"].includes(cfg.sample.mode)) errs.push("sample.mode は random / range / list のどれかにしてください");
  if (!(cfg.days_per_run >= 1) || !(cfg.max_pages_per_run >= 1)) errs.push("days_per_run と max_pages_per_run は1以上にしてください");
  if (cfg.run_window_jst && !(cfg.run_window_jst.start && cfg.run_window_jst.end)) errs.push('run_window_jst は {start:"01:00", end:"07:00"} の形にしてください');
  if (errs.length) throw new Error("設定エラー:\n  - " + errs.join("\n  - "));
}
