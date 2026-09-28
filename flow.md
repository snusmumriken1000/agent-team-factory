# atf — コマンドとエージェントの関係 / 実行タイミング

Mermaid 記法。VS Code の Mermaid プレビュー、または GitHub の ```mermaid フェンスで描画できる。

---

## 1. 全体ライフサイクル — どのコマンドがいつ走るか

```mermaid
flowchart TB
  subgraph SETUP["① 導入フェーズ（人が atf を叩く）"]
    direction TB
    CAT["atf catalog<br/>プリセット / スキル一覧"]
    INIT["atf init &lt;dir&gt;<br/>解析 → ヒアリング → プレビュー確認<br/>→ タッチポイント選択 → 生成"]
    CAT -.参考.-> INIT
  end

  subgraph ADJUST["② 構成変更フェーズ（随時・人が叩く）"]
    direction TB
    APPLY["atf apply &lt;formal|arch|docs|issue|eval|report&gt;<br/>機能を後から導入"]
    APPLYD["atf apply design<br/>デザインスキル + 指示を対話で適用"]
    REMOVE["atf remove &lt;機能|design&gt;<br/>撤去（--purge で成果物も）"]
    UPDATE["atf update<br/>有効な機能のアセットを最新の atf に更新"]
  end

  subgraph OUT["③ 生成物（対象プロジェクト）"]
    direction TB
    AGENTS[".claude/agents/*.md<br/>エージェント定義"]
    SETTINGS["atf-settings.yaml<br/>★機能 ON/OFF の単一情報源"]
    BIN["atf-bin/*.sh<br/>ゲート実行の薄いラッパ"]
    SCAF["足場: spec/ docs/adr/<br/>.claude/atf-arch/ atf-eval/<br/>atf-docs/ atf-issues/"]
    SKILLS[".claude/skills/"]
    DASH[".claude/atf-dashboard.html"]
  end

  subgraph LOOP["④ 開発フェーズ（エージェントが atf-bin 経由で叩く）"]
    direction TB
    ORCH{{"orchestrator<br/>開発ループを回す"}}
  end

  subgraph WATCH["⑤ 点検・可視化（人 / エージェント）"]
    direction TB
    STATUS["atf status<br/>有効な機能と実体の食い違い検査"]
    REPORT["atf report<br/>ダッシュボード再生成"]
    VIEW["atf view<br/>稼働モニター（常駐）"]
  end

  INIT ==> OUT
  APPLY & APPLYD & REMOVE & UPDATE ==> OUT
  SETTINGS -. 根拠 .-> APPLY
  SETTINGS -. 根拠 .-> STATUS
  OUT ==> LOOP
  LOOP ==> WATCH
  WATCH -. 食い違い / 不足 .-> ADJUST
```

---

## 2. 機能 → エージェント → 実行スクリプト → ゲートの対応

`atf-settings.yaml` の `requirements` が ON のときだけ、担当エージェント・足場・`atf-bin/*.sh` が配られる。

```mermaid
flowchart LR
  classDef req fill:#fff,stroke:#333,stroke-width:1px
  classDef agent fill:#f5f5f0,stroke:#333
  classDef bin fill:#eef,stroke:#333
  classDef gate fill:#ffe,stroke:#333

  subgraph R["requirements（atf-settings.yaml）"]
    direction TB
    r1["formalSpec"]:::req
    r2["archCheck"]:::req
    r3["reverseDocs"]:::req
    r4["issueDriven"]:::req
    r5["rubricEval"]:::req
    r6["capabilityScout"]:::req
    r7["designSkills"]:::req
    r8["（常時）"]:::req
  end

  subgraph A["共通エージェント（teamSize の枠外）"]
    direction TB
    a1["spec-formalizer"]:::agent
    a2["arch-guard"]:::agent
    a3["doc-reverser"]:::agent
    a4["issue-manager"]:::agent
    a5["evaluator"]:::agent
    a6["capability-scout"]:::agent
    a7["orchestrator"]:::agent
    a8["env-builder"]:::agent
  end

  subgraph B["atf-bin（エージェントが実行）"]
    direction TB
    b1["formal.sh"]:::bin
    b2["lint.sh"]:::bin
    b3["weave.sh"]:::bin
    b4["arch.sh"]:::bin
    b5["docs.sh"]:::bin
    b6["eval.sh"]:::bin
    b7["status.sh"]:::bin
    b8["report.sh"]:::bin
  end

  subgraph G["ゲートのタイミング"]
    direction TB
    g1["実装【前】ゲート"]:::gate
    g2["実装【後】ゲート"]:::gate
    g3["完了【前】ゲート"]:::gate
    g4["ゲートではない（可視化・点検）"]:::gate
  end

  r1 --> a1 --> b1 & b2 & b3
  r2 --> a2 --> b4
  r3 --> a3 --> b5
  r4 --> a4
  r5 --> a5 --> b6
  r6 --> a6
  r7 --> a7
  r8 --> a7 & a8
  a8 -. 実行環境を整備 .-> B
  a7 -. すべてのゲートを呼ぶ .-> B
  r8 --> b7 & b8

  b2 --> g1
  b1 --> g1
  b4 --> g2
  b6 --> g3
  b3 & b5 & b7 & b8 --> g4
```

| 機能 | 担当エージェント | スクリプト | 実行タイミング |
|---|---|---|---|
| formal（形式仕様 Alloy） | spec-formalizer | `lint.sh` → `formal.sh` → `weave.sh` | **実装前**（通るまで実装を委譲しない） |
| arch（適合検証） | arch-guard | `arch.sh` | **実装後**（違反を残して完了としない） |
| docs（リバースドキュメント） | doc-reverser | `docs.sh` | 実装**前**に読む / 構造変更**後**に更新 |
| issue（Issue 駆動） | issue-manager | なし（進め方の機能） | ループの入口 |
| eval（ルーブリック評価） | evaluator | `eval.sh` | **完了前**（採点は evaluator、集計は atf） |
| capability（最新機能スカウト） | capability-scout | なし | 随時（orchestrator へ採否表と計画書） |
| report（ダッシュボード） | — | `report.sh` | 随時 |
| （常時） | orchestrator / env-builder | `status.sh` | 随時 |

---

## 3. エージェント間のフロー（buildFlow が組み立てる辺）

`firstAgent` = プリセット先頭の実装エージェント。破線は機能が ON のときだけ現れる辺。

```mermaid
flowchart LR
  ORCH["orchestrator<br/>（まとめ役）"]
  ISSUE["issue-manager"]
  SPEC["spec-formalizer"]
  DOCR["doc-reverser"]
  IMPL["実装エージェント<br/>（プリセット由来）"]
  ARCH["arch-guard"]
  EVAL["evaluator"]
  SCOUT["capability-scout"]
  ENV["env-builder"]

  SCOUT -.capabilityScout.-> ORCH
  ORCH ==> ISSUE
  ISSUE -.issueDriven.-> SPEC
  SPEC -.formalSpec.-> IMPL
  DOCR -.reverseDocs.-> IMPL
  IMPL -.archCheck.-> ARCH
  DOCR -.reverseDocs+archCheck.-> ARCH
  IMPL -.rubricEval.-> EVAL
  EVAL -.rubricEval.-> ORCH
  ENV -. 実行環境・ガードレールを整備（ループ外） .-> ORCH

  note["入口の決まり方:<br/>orchestrator → issue-manager → spec-formalizer → 実装<br/>（機能が OFF ならその段は飛ばして次に繋がる）"]
```

---

## 4. 開発 1 サイクルの実行タイミング（Issue 駆動モード）

```mermaid
sequenceDiagram
  autonumber
  participant U as ユーザー
  participant O as orchestrator
  participant I as issue-manager
  participant S as spec-formalizer
  participant D as doc-reverser
  participant M as 実装エージェント
  participant G as arch-guard
  participant E as evaluator

  Note over O: 動作モードは 2 つ<br/>既定=ブートストラップ（Issue/PR なし・作業単位でコミット）<br/>本図=Issue 駆動モード

  O->>I: Issue を起票 / 次のタスクを取得
  opt タッチポイント issue-approval
    I-->>U: 着手前の承認を仰ぐ（ここで一時停止）
  end

  rect rgb(245,245,240)
    Note over O,S: ── 実装【前】ゲート ──
    O->>S: 仕様の形式化を委譲
    S->>S: spec/*.als と docs/adr/ を更新
    O->>O: bash atf-bin/lint.sh（運用規約）
    O->>O: bash atf-bin/formal.sh（Alloy 検証）
    alt 反例あり & specAutoFix=true & 選択肢が一意
      O->>S: 自動確定（.als 修正 + ADR + decisions.jsonl）→ 再検証
    else 反例あり & 判断が割れる
      S-->>U: 仕様変更の判断を仰ぐ
    end
    O->>O: bash atf-bin/weave.sh（docs/generated/ を生成）
  end

  opt reverseDocs
    O->>D: 該当箇所の現状文書を確認・更新
    D-->>M: 実装前に読む文書を渡す
  end

  O->>M: 実装を委譲（ブランチ作成 → 実装 → テスト）

  rect rgb(245,245,240)
    Note over O,G: ── 実装【後】ゲート ──
    O->>O: bash atf-bin/arch.sh（レイヤ規約の適合）
    alt 違反あり
      O->>M: 修正を委譲（違反 0 まで戻す）
    end
  end

  opt reverseDocs
    O->>D: 構造が変わったので文書・図を更新
    O->>O: bash atf-bin/docs.sh（「追随」を確認）
  end

  rect rgb(245,245,240)
    Note over O,E: ── 完了【前】ゲート ──
    O->>E: 成果物の採点を依頼（rubric.json）
    E->>E: evaluations.jsonl に判定を追記
    O->>O: bash atf-bin/eval.sh（集計・ゲート判定）
    alt 閾値未満
      O->>M: ネクストアクションに沿って差し戻し
    end
  end

  O->>M: push → gh pr create
  alt タッチポイント pr-merge あり
    M-->>U: マージはユーザーが実行（エージェントの gh pr merge は禁止）
  else なし
    M->>M: CI・レビュー確認後にエージェントがマージ
  end

  M->>M: .claude/atf-logs/runs.jsonl に実行記録を追記
  O->>O: bash atf-bin/report.sh（ダッシュボード更新）
  O->>I: 次の Issue へ
```

---

## 5. 情報源と生成物の依存（SSOT の向き）

```mermaid
flowchart LR
  subgraph SSOT["単一情報源（手書き・commit する）"]
    ALS["spec/*.als<br/>いまの仕様"]
    ADR["docs/adr/*.md<br/>決定の履歴（追記のみ）"]
    RULES[".claude/atf-arch/rules.json<br/>レイヤ規約"]
    RUB[".claude/atf-eval/rubric.json<br/>評価基準"]
    YAML["atf-settings.yaml<br/>機能 ON/OFF"]
  end

  subgraph REC["記録（エージェントが追記・atf は読むだけ）"]
    CHK["checks.jsonl / decisions.jsonl"]
    ACHK["atf-arch/checks.jsonl"]
    EV["atf-eval/evaluations.jsonl"]
    DOCJ["atf-docs/docs.jsonl"]
    RUNS["atf-logs/runs.jsonl"]
  end

  subgraph DERIV["派生物（atf が生成・gitignore・編集禁止）"]
    GEN["docs/generated/<br/>overview / spec / glossary<br/>traceability / *.explain.html"]
    DASH2[".claude/atf-dashboard.html"]
  end

  ALS --> |weave.sh| GEN
  ADR --> |weave.sh| GEN
  ALS --> |formal.sh| CHK
  ALS --> |lint.sh| LINT["違反レポート<br/>error があれば exit 1"]
  ADR --> |lint.sh| LINT
  RULES --> |arch.sh| ACHK
  RUB --> |evaluator が採点| EV
  YAML & RUNS & CHK & ACHK & EV & DOCJ --> |report.sh| DASH2
  YAML --> |status.sh| ST["機能と実体の突き合わせ<br/>食い違いがあれば exit 1"]
```
