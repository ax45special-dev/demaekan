# Python版(基準実装)
アプリ(JavaScript版)と同じ動きの、PC用の実装です。標準ライブラリだけで動きます。
`python3 -m unittest tests.test_parse tests.test_flow`(27個)。アプリと同じ検証用ページで、同じ結果になることを確認しています。
PCやサーバーで動かす場合は、`python3 -m odds_tool init` → `run` → `status`。
