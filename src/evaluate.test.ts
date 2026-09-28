import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEvalStatuses,
  appendEvaluations,
  buildEvalTargets,
  criteriaFor,
  criterionPassScore,
  DEFAULT_RUBRIC_ACTIONS,
  defaultNextActions,
  ensureRubricActions,
  evalDir,
  evalGateStatus,
  evalTargetNames,
  hasNextActions,
  isEvalTarget,
  isEvalTargetAgent,
  isRubricTemplate,
  latestEvaluations,
  loadEvaluations,
  loadRubric,
  nextActionItems,
  nextActions,
  ownNextActions,
  passScoreOf,
  rubricPath,
  thresholdMismatches,
  totalScore,
} from "./evaluate.js";
import type {
  EvaluationRecord,
  Requirements,
  Rubric,
  RubricCriterion,
  TeamAgent,
} from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-eval-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const writeRubric = (rubric: unknown | string): void => {
  mkdirSync(evalDir(repoDir), { recursive: true });
  writeFileSync(
    rubricPath(repoDir),
    typeof rubric === "string" ? rubric : JSON.stringify(rubric, null, 2),
  );
};

const rubric = (): Rubric => ({
  passScore: 3,
  criteria: [
    {
      id: "EVAL-01",
      name: "要求の充足",
      description: "完了条件を満たしているか",
      weight: 2,
      levels: [{ score: 4, label: "優秀", description: "..." }],
    },
    {
      id: "EVAL-02",
      name: "検証の裏づけ",
      description: "テストがあるか",
      levels: [{ score: 4, label: "優秀", description: "..." }],
    },
  ],
});

const record = (over: Partial<EvaluationRecord> = {}): EvaluationRecord => ({
  target: "code-reviewer",
  artifact: "src/a.ts",
  scores: [{ id: "EVAL-01", score: 3 }],
  verdict: "pass",
  ...over,
});

const requirements = (over: Partial<Requirements> = {}): Requirements => ({
  phase: "active",
  focus: ["quality"],
  teamSize: "minimal",
  ...over,
});

const agents = (...names: string[]): TeamAgent[] =>
  names.map((name) => ({ file: `${name}.md`, name, description: "" }));

describe("loadRubric", () => {
  it("rubric.json がなければ undefined", () => {
    expect(loadRubric(repoDir)).toBeUndefined();
  });

  it("壊れた JSON は undefined として扱う(ダッシュボード・CLI を落とさない)", () => {
    writeRubric("{ criteria: ");
    expect(loadRubric(repoDir)).toBeUndefined();
  });

  it("criteria が配列でなければ undefined", () => {
    writeRubric({ criteria: "EVAL-01" });
    expect(loadRubric(repoDir)).toBeUndefined();
  });

  it("雛形は template フラグで判別できる", () => {
    writeRubric({ template: true, criteria: [] });
    expect(isRubricTemplate(repoDir)).toBe(true);

    writeRubric(rubric());
    expect(isRubricTemplate(repoDir)).toBe(false);
  });
});

describe("loadEvaluations", () => {
  it("壊れた行と必須項目を欠く行は無視する(エージェントの自己申告のため寛容に扱う)", () => {
    mkdirSync(evalDir(repoDir), { recursive: true });
    appendEvaluations(repoDir, [record(), record({ artifact: "src/b.ts" })]);
    writeFileSync(
      join(evalDir(repoDir), "evaluations.jsonl"),
      [
        JSON.stringify(record()),
        "{ broken",
        JSON.stringify({ target: "x", verdict: "pass" }), // artifact がない
        JSON.stringify({ artifact: "src/c.ts", verdict: "pass" }), // target がない
        "",
      ].join("\n"),
    );

    const records = loadEvaluations(repoDir);
    expect(records).toHaveLength(1);
    expect(records[0].target).toBe("code-reviewer");
  });

  it("同じ対象 + 成果物の行は後勝ち(再評価で判定が置き換わる)", () => {
    const records = [
      record({ verdict: "revise" }),
      record({ artifact: "src/b.ts", verdict: "fail" }),
      record({ verdict: "pass" }),
    ];
    const latest = latestEvaluations(records);

    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.artifact === "src/a.ts")?.verdict).toBe("pass");
  });
});

describe("totalScore", () => {
  it("total があればそれを使う", () => {
    expect(totalScore(record({ total: 3.5 }), rubric())).toBe(3.5);
  });

  it("total がなければ weight で加重平均する", () => {
    const r = record({
      scores: [
        { id: "EVAL-01", score: 4 }, // weight 2
        { id: "EVAL-02", score: 1 }, // weight 1(既定)
      ],
    });
    expect(totalScore(r, rubric())).toBe(3);
  });

  it("採点が 1 件もなければ undefined", () => {
    expect(totalScore(record({ scores: [] }), rubric())).toBeUndefined();
  });

  it("合格線は rubric の passScore(未設定なら 3)", () => {
    expect(passScoreOf(rubric())).toBe(3);
    expect(passScoreOf({ criteria: [] })).toBe(3);
    expect(passScoreOf({ criteria: [], passScore: 4 })).toBe(4);
  });
});

describe("ensureRubricActions(既存ルーブリックへの移行)", () => {
  it("actions がなければ既定を補う(観点・水準・その他の項目は変えない)", () => {
    writeRubric({
      $comment: "手で書いたコメント",
      project: "demo",
      passScore: 4,
      criteria: rubric().criteria,
      notes: ["申し合わせ"],
    });

    expect(ensureRubricActions(repoDir)).toBe(true);

    const after = loadRubric(repoDir)!;
    expect(after.actions).toEqual(DEFAULT_RUBRIC_ACTIONS);
    // 既存の内容はそのまま
    expect(after.passScore).toBe(4);
    expect(after.criteria.map((c) => c.id)).toEqual(["EVAL-01", "EVAL-02"]);
    expect(after.notes).toEqual(["申し合わせ"]);
    expect((after as Record<string, unknown>).$comment).toBe("手で書いたコメント");
  });

  it("既に actions があれば触らない(意図的に空にした場合も残す)", () => {
    writeRubric({ passScore: 3, actions: { below: [] }, criteria: [] });

    expect(ensureRubricActions(repoDir)).toBe(false);
    expect(loadRubric(repoDir)!.actions).toEqual({ below: [] });
  });

  it("ファイルがない・壊れている場合は何もしない", () => {
    expect(ensureRubricActions(repoDir)).toBe(false);
    writeRubric("{ 壊れている");
    expect(ensureRubricActions(repoDir)).toBe(false);
  });
});

describe("閾値とネクストアクション", () => {
  const actionable = (): Rubric => ({
    passScore: 3,
    actions: { below: ["担当に差し戻す"], meets: ["次の作業へ進む"] },
    criteria: [
      {
        id: "EVAL-01",
        name: "要求の充足",
        description: "...",
        levels: [],
      },
      {
        id: "EVAL-02",
        name: "検証の裏づけ",
        description: "...",
        // この観点だけ閾値が高く、固有の差し戻し手順を持つ
        passScore: 4,
        actions: { below: ["不足しているテストを一覧にして差し戻す"] },
        levels: [],
      },
    ],
  });

  it("閾値は観点ごとの passScore を優先し、なければ全体の値を使う", () => {
    const r = actionable();
    expect(criterionPassScore(r.criteria[0], r)).toBe(3);
    expect(criterionPassScore(r.criteria[1], r)).toBe(4);
    // ルーブリックに passScore がなければ既定の 3
    expect(criterionPassScore(r.criteria[0], { criteria: [] })).toBe(3);
  });

  it("閾値未満なら below、以上なら meets のアクションを返す", () => {
    const r = actionable();
    expect(nextActions(r.criteria[0], 2, r)).toEqual(["担当に差し戻す"]);
    expect(nextActions(r.criteria[0], 3, r)).toEqual(["次の作業へ進む"]);
    // 観点ごとの閾値(4)で判定される
    expect(nextActions(r.criteria[1], 3, r)).toEqual(["不足しているテストを一覧にして差し戻す"]);
    expect(nextActions(r.criteria[1], 4, r)).toEqual(["次の作業へ進む"]); // meets は全体の既定にフォールバック
  });

  it("観点固有のアクションと、全体の既定を区別して取り出せる", () => {
    const r = actionable();
    // 観点に書いてあるものだけ(既定にフォールバックしない)
    expect(ownNextActions(r.criteria[1], "below")).toEqual([
      "不足しているテストを一覧にして差し戻す",
    ]);
    expect(ownNextActions(r.criteria[1], "meets")).toEqual([]);
    expect(ownNextActions(r.criteria[0], "below")).toEqual([]);
    // ルーブリック直下の既定
    expect(defaultNextActions(r, "below")).toEqual(["担当に差し戻す"]);
    expect(defaultNextActions(r, "meets")).toEqual(["次の作業へ進む"]);
    expect(defaultNextActions(undefined, "below")).toEqual([]);
  });

  it("未採点(スコアなし)ならアクションを返さない", () => {
    expect(nextActions(actionable().criteria[0], undefined, actionable())).toEqual([]);
  });

  it("アクションが 1 つも設定されていなければ hasNextActions は false", () => {
    expect(hasNextActions(actionable())).toBe(true);
    expect(hasNextActions(rubric())).toBe(false);
    expect(hasNextActions(undefined)).toBe(false);
  });

  it("採点結果から、閾値を跨いだ観点のネクストアクションを取り出す", () => {
    const r = actionable();
    const records = [
      record({
        scores: [
          { id: "EVAL-01", score: 4 },
          { id: "EVAL-02", score: 3 },
        ],
      }),
    ];
    const below = nextActionItems(r, records, ["code-reviewer"], "below");
    expect(below).toHaveLength(1);
    expect(below[0]).toMatchObject({
      agent: "code-reviewer",
      artifact: "src/a.ts",
      criterion: "EVAL-02",
      score: 3,
      threshold: 4,
      meets: false,
      actions: ["不足しているテストを一覧にして差し戻す"],
    });

    const meets = nextActionItems(r, records, ["code-reviewer"], "meets");
    expect(meets.map((m) => m.criterion)).toEqual(["EVAL-01"]);
  });

  it("評価対象外のエージェント・ルーブリックにない観点は取り出さない", () => {
    const r = actionable();
    const items = nextActionItems(
      r,
      [
        record({ target: "docs-writer", scores: [{ id: "EVAL-01", score: 1 }] }),
        record({ scores: [{ id: "EVAL-99", score: 1 }] }),
      ],
      ["code-reviewer"],
    );
    expect(items).toEqual([]);
  });

  it("合格と記録されていても、閾値未満の観点が残っていれば食い違いとして返す", () => {
    const r = actionable();
    const mismatches = thresholdMismatches(
      r,
      [
        record({
          verdict: "pass",
          scores: [
            { id: "EVAL-01", score: 4 },
            { id: "EVAL-02", score: 3 }, // 閾値 4 に届いていない
          ],
        }),
        record({ artifact: "src/b.ts", verdict: "revise", scores: [{ id: "EVAL-01", score: 1 }] }),
      ],
      ["code-reviewer"],
    );

    // 合格の記録だけが対象(要改善はもともと未達として扱われる)
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].record.artifact).toBe("src/a.ts");
    expect(mismatches[0].below).toEqual(["EVAL-02"]);
  });
});

describe("評価対象の ON/OFF", () => {
  it("evalTargets がなければ全エージェントが対象(evaluator 自身を除く)", () => {
    const req = requirements({ rubricEval: true });
    expect(isEvalTarget(req, "code-reviewer")).toBe(true);
    expect(isEvalTarget(req, "evaluator")).toBe(false);
  });

  it("機能が無効なら誰も対象にならない", () => {
    expect(isEvalTarget(requirements(), "code-reviewer")).toBe(false);
    // 撤去時にどのエージェントから指示を外すかは、機能の ON/OFF と無関係に決まる
    expect(isEvalTargetAgent(requirements(), "code-reviewer")).toBe(true);
  });

  it("false にしたエージェントだけが対象から外れる(未設定のエージェントは対象のまま)", () => {
    const req = requirements({
      rubricEval: true,
      evalTargets: { "code-reviewer": false, "test-engineer": true },
    });
    expect(isEvalTarget(req, "code-reviewer")).toBe(false);
    expect(isEvalTarget(req, "test-engineer")).toBe(true);
    // 設定にない(あとから増えた)エージェントは黙って評価から外れない
    expect(isEvalTarget(req, "new-agent")).toBe(true);

    expect(evalTargetNames(req, agents("code-reviewer", "test-engineer", "evaluator"))).toEqual([
      "test-engineer",
    ]);
  });

  it("buildEvalTargets はチーム構成から表を作り、既存の false を残す", () => {
    const targets = buildEvalTargets(agents("code-reviewer", "test-engineer", "evaluator"), {
      "code-reviewer": false,
      "gone-agent": false,
    });

    // evaluator 自身は載せず、チームにいないエージェントは消える
    expect(targets).toEqual({ "code-reviewer": false, "test-engineer": true });
  });
});

describe("evalGateStatus", () => {
  const targets = ["code-reviewer", "test-engineer"];

  it("観点が未定義なら通過しない", () => {
    const gate = evalGateStatus(undefined, [], targets);
    expect(gate.ok).toBe(false);
    expect(gate.criteria).toBe(0);
  });

  it("未評価の対象が残っているあいだは通過しない", () => {
    const gate = evalGateStatus(rubric(), [record()], targets);
    expect(gate.ok).toBe(false);
    expect(gate.passed).toBe(1);
    expect(gate.unevaluated).toEqual(["test-engineer"]);
  });

  it("未達が残っているあいだは通過しない", () => {
    const gate = evalGateStatus(
      rubric(),
      [record(), record({ target: "test-engineer", verdict: "revise" })],
      targets,
    );
    expect(gate.ok).toBe(false);
    expect(gate.failed).toBe(1);
  });

  it("対象外のエージェントの記録は集計に入れない", () => {
    const gate = evalGateStatus(
      rubric(),
      [
        record(),
        record({ target: "test-engineer" }),
        record({ target: "docs-writer", verdict: "fail" }),
      ],
      targets,
    );
    expect(gate.ok).toBe(true);
    expect(gate.passed).toBe(2);
    expect(gate.failed).toBe(0);
  });

  it("再評価で合格に変わったものは通過扱いになる(後勝ち)", () => {
    const gate = evalGateStatus(
      rubric(),
      [
        record({ verdict: "revise" }),
        record({ target: "test-engineer" }),
        record({ verdict: "pass" }),
      ],
      targets,
    );
    expect(gate.ok).toBe(true);
  });
});

describe("agentEvalStatuses", () => {
  it("エージェントごとに件数と平均スコアを集計する", () => {
    const statuses = agentEvalStatuses(
      ["code-reviewer", "test-engineer"],
      [
        record({ scores: [{ id: "EVAL-01", score: 4 }] }),
        record({ artifact: "src/b.ts", verdict: "revise", scores: [{ id: "EVAL-01", score: 2 }] }),
      ],
      rubric(),
    );

    expect(statuses[0]).toMatchObject({
      agent: "code-reviewer",
      evaluated: 2,
      passed: 1,
      failed: 1,
      averageScore: 3,
    });
    expect(statuses[1]).toMatchObject({ agent: "test-engineer", evaluated: 0 });
    expect(statuses[1].averageScore).toBeUndefined();
  });

  it("観点ごとの採点(誰の成果物をどの観点で見ているか)を rubric と同じ並びで返す", () => {
    const targeted: Rubric = {
      ...rubric(),
      criteria: [
        ...rubric().criteria,
        {
          id: "EVAL-03",
          name: "指摘の具体性",
          description: "根拠と直し方があるか",
          appliesTo: ["code-reviewer"],
          levels: [{ score: 4, label: "優秀", description: "..." }],
        },
      ],
    };
    const statuses = agentEvalStatuses(
      ["code-reviewer", "test-engineer"],
      [
        record({
          scores: [
            { id: "EVAL-01", score: 4 },
            { id: "EVAL-03", score: 3 },
          ],
        }),
        record({ artifact: "src/b.ts", scores: [{ id: "EVAL-01", score: 2 }] }),
        record({ target: "test-engineer", scores: [{ id: "EVAL-02", score: 3 }] }),
      ],
      targeted,
    );

    // 列は rubric.criteria と同じ並び・同じ件数(表の列がずれないように)
    expect(statuses[0].cells.map((c) => c.criterion)).toEqual(["EVAL-01", "EVAL-02", "EVAL-03"]);
    // 同じ観点が複数の成果物で採点されていれば平均になる
    expect(statuses[0].cells[0]).toMatchObject({ applies: true, scored: 2, score: 3 });
    // 適用される観点でも、採点がなければスコアは undefined(= 未採点)
    expect(statuses[0].cells[1]).toMatchObject({ applies: true, scored: 0 });
    expect(statuses[0].cells[1].score).toBeUndefined();
    // appliesTo で絞られた観点は、対象外のエージェントでは applies: false
    expect(statuses[0].cells[2].applies).toBe(true);
    expect(statuses[1].cells[2].applies).toBe(false);
  });

  it("rubric がなければ観点の列を持たない", () => {
    const statuses = agentEvalStatuses(["code-reviewer"], [record()]);
    expect(statuses[0].cells).toEqual([]);
  });
});

describe("criteriaFor", () => {
  const scoped = (): Rubric => ({
    passScore: 3,
    criteria: [
      { id: "EVAL-01", name: "全員向け", description: "...", levels: [] },
      {
        id: "EVAL-02",
        name: "レビュー向け",
        description: "...",
        appliesTo: ["code-reviewer"],
        levels: [],
      },
    ],
  });

  it("そのエージェントに適用される観点だけを rubric の並びで返す", () => {
    expect(criteriaFor(scoped(), "code-reviewer").map((c) => c.id)).toEqual([
      "EVAL-01",
      "EVAL-02",
    ]);
    expect(criteriaFor(scoped(), "test-engineer").map((c) => c.id)).toEqual(["EVAL-01"]);
  });

  it("rubric がなければ空", () => {
    expect(criteriaFor(undefined, "code-reviewer")).toEqual([]);
  });
});

