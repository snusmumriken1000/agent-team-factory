# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの目的

agent-team-factory は、多種多様な要件にあわせたエージェントチームを構成し、指定されたリポジトリに提供する CLI ツール(`atf`)。

対象リポジトリの自動解析 + 対話ヒアリングで要件を把握し、プリセットをベースにカスタマイズしたエージェント定義一式を対象リポジトリの `.claude/agents/` に書き込む(ハイブリッド方式)。

## コマンド

```bash
npm run dev -- <args>   # ビルドなしで CLI を実行(例: npm run dev -- generate ../some-repo)
npm test                # テスト実行(vitest)
npx vitest run src/presets.test.ts   # 単一テストファイルの実行
npm run typecheck       # 型チェックのみ
npm run build           # dist/ へビルド(bin: atf)
```

## アーキテクチャ

CLI は `generate` コマンドを軸としたパイプライン構成。データフローは:

```
analyzer.ts → RepoProfile ─┐
                           ├→ presets.ts(スコアリング)→ generator.ts(書き込み)
hearing.ts  → Requirements ┘
```

- `src/cli.ts` — commander によるエントリポイント(`analyze` / `list` / `generate` / `report`)
- `src/analyzer.ts` — 対象リポジトリを走査し、言語(拡張子)・フレームワーク(package.json 依存 + マーカーファイル)・CI/テストの有無・GitHub リポジトリ(.git/config の remote URL)を検出して `RepoProfile` を作る
- `src/hearing.ts` — @inquirer/prompts による対話ヒアリング(開発フェーズ・重視観点・チーム規模・GitHub リポジトリ・Issue 駆動の有無)→ `Requirements`。GitHub リポジトリは検出値をデフォルトに**必ず確認する**(空欄で未設定も可)。指定されると Issue 駆動指示に起票先(`gh -R owner/repo`)として明記され、`{{githubRepo}}` プレースホルダでも使える
- `src/presets.ts` — `templates/presets/` からプリセットをロードし、profile/requirements との一致でスコアリング(focus 一致を最重視: +5、言語/FW: +2、フェーズ: +1。focus がスコアを支配するのは意図的 — ユーザーの明示要件 > 自動検出)。`uncoveredFocus` でどのプリセットにもカバーされない focus を検出でき、`generate` は全 focus が未カバーなら管理者へのテンプレート作成依頼を促して中断する(部分未カバーは警告のみ。`--preset` 明示指定時はチェックしない)
- `src/generator.ts` — 選ばれたプリセットのエージェント定義を `{{placeholder}}` 置換して対象リポジトリの `.claude/agents/` に書き込み、`.claude/team.json` にマニフェスト(`TeamManifest`)を記録。各エージェント定義の末尾に「完了時に `.claude/atf-logs/runs.jsonl` へ実行記録を追記する」指示を自動付与する。Issue 駆動(`requirements.issueDriven`)なら `templates/common/issue-manager.md` を teamSize の枠外で追加し、全エージェントに Issue 起点で動く指示を付与する
- `src/report.ts` — `team.json` + `atf-logs/runs.jsonl` から自己完結 HTML ダッシュボード(`.claude/atf-dashboard.html`)を生成。冒頭に「実行環境の仕組み」としてハーネス / ガードレール / フィードバックループの 3 要素カードを表示(項目はマニフェストと実行記録から動的に導出し、Issue 駆動オフ時は関連項目を「未導入」と薄く表示)。チーム構成図は Mermaid(CDN)、実行記録はテーブル + 実行回数バーで可視化。エージェント由来の文字列は必ず `escapeHtml` を通すこと

## プリセットの追加方法

`templates/presets/<id>/` に `preset.json` と `agents/*.md` を置くだけでコード変更なしで認識される。全プリセット共通のエージェント(issue-manager など)は `templates/common/` に置く。

- `preset.json`: `name` / `description` / `match`(スコアリング条件: languages, frameworks, focus, phase)/ `agents`(含めるエージェント定義のファイル名リスト。teamSize 制限で先頭から採用されるため重要な順に並べる)/ `flow`(ダッシュボードの構成図に描く from → to のエージェント名ペア)
- ヒアリングの focus 選択肢(`src/hearing.ts`)に対応する値がないと、その focus を条件とするプリセットはヒアリング経由で選ばれない。新しい focus をプリセットに使うときは hearing.ts にも選択肢を追加すること
- `agents/*.md`: Claude Code サブエージェント定義(frontmatter: name, description)。本文では `{{projectName}}` `{{languages}}` `{{frameworks}}` `{{phase}}` `{{focus}}` `{{githubRepo}}` が置換される

## 設計上の注意

- generator は既存の `.claude/agents/` 内ファイルを `--force` なしでは上書きしない(対象リポジトリの既存定義を尊重する)
- `presetsRoot()` は `import.meta.url` 基準で `../templates/presets` を参照するため、`src/` からの実行(tsx)と `dist/` からの実行の両方で動く。ディレクトリ構成を変えるときはここを壊さないこと
