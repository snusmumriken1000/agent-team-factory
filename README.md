# agent-team-factory

多種多様な要件にあわせたエージェントチームを、指定されたリポジトリに提供する CLI ツール。

対象リポジトリを自動解析し、対話ヒアリングで要件を把握したうえで、最適なチームプリセットを選定・カスタマイズして、対象リポジトリの `.claude/agents/` に Claude Code サブエージェント定義一式を導入します。

## 使い方

```bash
npm install

# 対象リポジトリを解析してプロファイルを表示
npm run dev -- analyze /path/to/repo

# 利用可能なチームプリセットを一覧
npm run dev -- list

# 解析 + ヒアリング → チームを導入
npm run dev -- generate /path/to/repo

# プリセット直接指定・既存定義の上書き
npm run dev -- generate /path/to/repo --preset security-audit --force

# チーム構成・実行記録の HTML ダッシュボードを再生成
npm run dev -- report /path/to/repo
```

## ダッシュボード(可視化)

`generate` を実行すると、対象リポジトリの `.claude/atf-dashboard.html` にチームダッシュボードが生成されます(ブラウザで開くだけで閲覧可能)。

- **チーム構成・入出力フロー** — エージェント間の入出力関係を Mermaid フローチャートで表示
- **エージェント一覧** — 各エージェントの役割カード
- **実行記録** — 各エージェントは作業完了時に `.claude/atf-logs/runs.jsonl` へ実行記録(タスク・入力・出力・結果)を追記するよう指示されており、`atf report` で最新の実行タイムラインと実行回数をダッシュボードに反映できます

## 同梱プリセット

| ID | チーム | 用途 |
| --- | --- | --- |
| `web-dev` | Web アプリ開発チーム | 設計・実装・テスト・レビュー・ドキュメントを分担する標準開発体制 |
| `quality-review` | 品質レビューチーム | コード品質・テスト・保守性の改善 |
| `security-audit` | セキュリティ監査チーム | 脆弱性検出・依存関係監査・修正(防御目的) |
| `new-service` | 新サービス検討チーム | 新規サービスの企画・市場調査・実現性検証・UX 設計・事業性評価 |

プリセットは `templates/presets/<id>/` に `preset.json` + `agents/*.md` を置くだけで追加できます。

## 開発

```bash
npm run dev -- <args>   # ビルドなしで実行
npm test                # テスト
npm run typecheck       # 型チェック
npm run build           # ビルド
```
