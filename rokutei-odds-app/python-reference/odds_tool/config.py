"""設定(config.json)の読み込みと検証。"""
import json, os

DEFAULTS = {
    # --- どの日を取るか ---
    "date_range": {"start": "2025-10-06", "end": "2026-10-05"},   # この期間の中から選ぶ
    "sample": {"mode": "random", "days": 30, "seed": 20261006, "balance_months": True},
    #   mode: "random"=期間からランダムにN日 / "range"=期間の全日 / "list"=下の dates の日だけ
    "dates": [],
    # --- 何を取るか ---
    "bet_types": ["3t", "2tf"],        # 3t=3連単 / 2tf=2連単と2連複(同じページ)
    "stadiums": None,                   # None=全場。絞るなら場番号のリスト 例 [19, 16]
    # --- 取り方(公式への配慮。公式の返信の条件に合わせて調整してください) ---
    "interval_sec": 5.0,                # 1リクエストごとの待ち時間(最小3秒。これ未満には設定できません)
    "jitter": 0.2,                      # 待ち時間に±20%のばらつきを付ける
    "days_per_run": 1,                  # 1回の実行で何日分を取るか
    "max_pages_per_run": 700,           # 1回の実行の最大ページ数(超えたら、きりのよい所で止めて次回に続ける)
    "run_window_jst": None,             # 例 {"start": "01:00", "end": "07:00"} 。None=時間帯の制限なし
    "respect_robots": True,             # robots.txtで禁止されていたら取らない
    "max_consecutive_errors": 5,        # 連続でエラーが出たら、その回は止める
    "max_consecutive_parse_errors": 3,  # 読み取り失敗が続いたら(形式変更の可能性)、その回は止める
    "max_attempts_per_day": 3,          # 同じ日が中断・失敗を繰り返したら、諦めて「取れていない日」に回す
    # --- 接続先・その他 ---
    "base_url": "https://www.boatrace.jp",
    "calendar_base_url": "https://boatraceopenapi.github.io",   # その日にどの場・何Rがあるかを調べる(GitHub上の公開データ)
    "user_agent": "rokutei-lab-odds-research/1.0 (personal research)",
    "state_dir": "state",
    "data_dir": "data/odds",
    "work_dir": "work",
}
MIN_INTERVAL = 3.0   # 安全のための下限。設定ファイルでも、これより短くはできない。


def _merge(base, over):
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load(path="config.json"):
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cfg = _merge(DEFAULTS, json.load(f))
    validate(cfg)
    return cfg


def validate(cfg):
    errs = []
    if cfg["interval_sec"] < MIN_INTERVAL:
        errs.append("interval_sec は %.0f 秒以上にしてください(公式サイトへの負荷を避けるための下限です)" % MIN_INTERVAL)
    if not set(cfg["bet_types"]) <= {"3t", "2tf"} or not cfg["bet_types"]:
        errs.append("bet_types は '3t' と '2tf' の組み合わせにしてください")
    if cfg["sample"]["mode"] not in ("random", "range", "list"):
        errs.append("sample.mode は random / range / list のどれかにしてください")
    if cfg["days_per_run"] < 1 or cfg["max_pages_per_run"] < 1:
        errs.append("days_per_run と max_pages_per_run は1以上にしてください")
    if cfg["run_window_jst"] is not None:
        w = cfg["run_window_jst"]
        if not ("start" in w and "end" in w):
            errs.append("run_window_jst は {\"start\": \"01:00\", \"end\": \"07:00\"} の形にしてください")
    if errs:
        raise ValueError("設定エラー:\n  - " + "\n  - ".join(errs))
