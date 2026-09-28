import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EvalVerdict,
  EvaluationRecord,
  Requirements,
  Rubric,
  RubricActions,
  RubricCriterion,
  TeamAgent,
} from "./types.js";

/** ルーブリックと評価記録の置き場 */
export function evalDir(repoPath: string): string {
  return join(repoPath, ".claude", "atf-eval");
}

/** ルーブリックの定義ファイル(評価基準の単一情報源) */
export function rubricPath(repoPath: string): string {
  return join(evalDir(repoPath), "rubric.json");
}

/** 評価記録ファイル(1 行 1 成果物の JSONL) */
export function evaluationsPath(repoPath: string): string {
  return join(evalDir(repoPath), "evaluations.jsonl");
}

/**
 * 評価する側のエージェントは評価対象にしない。
 * (自分の成果物を自分で採点しても意味がないため)
 */
export const NON_TARGET_AGENTS = ["evaluator"];

/** 合格とみなす既定の最低スコア(rubric.json の passScore で上書きできる) */
export const DEFAULT_PASS_SCORE = 3;

/**
 * 雛形と移行で使う、閾値に対するネクストアクションの既定。
 *
 * 空で配ると「設定できること自体に気づかれない」まま列が出ない状態が続くため、
 * **最初から動く文面**を入れておき、evaluator とユーザーが書き換える前提にする。
 */
export const DEFAULT_RUBRIC_ACTIONS: RubricActions = {
  below: ["担当エージェントに改善指示を添えて差し戻し、修正後に再評価する"],
  meets: ["orchestrator に合格を報告し、次の作業へ進む"],
};

/**
 * 既存の rubric.json に `actions` がなければ既定を補う(移行)。
 *
 * ネクストアクションは後から足した項目なので、それ以前に作られたルーブリックには
 * キーごと存在しない。**足りない項目を補うだけ**で、観点・水準・記録には一切触らない
 * (`actions` が既にあれば空でもそのまま残す = ユーザーが意図的に空にした場合を尊重する)。
 *
 * @returns 補ったら true(呼び出し側が報告に使う)
 */
export function ensureRubricActions(repoPath: string): boolean {
  const path = rubricPath(repoPath);
  if (!existsSync(path)) return false;
  let parsed: Rubric;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Rubric;
  } catch {
    // 壊れた JSON を書き換えると壊れ方が増えるだけなので触らない
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || parsed.actions !== undefined) return false;

  // criteria の直前に置くと、閾値(passScore)と並んで読める
  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "criteria") migrated.actions = DEFAULT_RUBRIC_ACTIONS;
    migrated[key] = value;
  }
  if (migrated.actions === undefined) migrated.actions = DEFAULT_RUBRIC_ACTIONS;
  writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
  return true;
}

/** 判定 → 表示用ラベル(CLI・ダッシュボードで共通に使う) */
export const EVAL_VERDICT_LABEL: Record<EvalVerdict, string> = {
  pass: "✅ 合格",
  revise: "⚠️ 要改善(指摘を直して再評価)",
  fail: "❌ 不合格(方針から見直す)",
  unknown: "❓ 判定不能",
};

/**
 * 判定 → 表の中で使う短いラベル。
 * EVAL_VERDICT_LABEL は意味まで含む長い文面なので、列幅の限られた表ではこちらを使う。
 */
export const EVAL_VERDICT_SHORT: Record<EvalVerdict, string> = {
  pass: "✅ 合格",
  revise: "⚠️ 要改善",
  fail: "❌ 不合格",
  unknown: "❓ 判定不能",
};

/** 評価を実行できないときに CLI・エージェントへ出す案内 */
export const RUBRIC_HELP = `ルーブリック評価を点検できません。次を確認してください:
  - .claude/atf-eval/rubric.json に評価観点(EVAL-xx)が定義されているか(なければ evaluator に定義を依頼する)
  - .claude/atf-eval/evaluations.jsonl に評価記録があるか(evaluator が成果物ごとに 1 行追記する)
評価そのものは evaluator エージェントが行い、atf は記録の集計とゲート判定だけを担います。`;

/** その判定で次へ進んでよいか(要改善・不合格・判定不能は未達) */
export function isEvalPass(verdict: EvalVerdict): boolean {
  return verdict === "pass";
}

/** rubric.json を読む(なければ undefined。壊れていれば undefined) */
export function loadRubric(repoPath: string): Rubric | undefined {
  const path = rubricPath(repoPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Rubric;
    if (!Array.isArray(parsed?.criteria)) return undefined;
    return parsed;
  } catch {
    // 壊れた rubric.json はダッシュボード・CLI を落とさず「未定義」として扱う
    return undefined;
  }
}

/**
 * ルーブリックが atf の置いた雛形のまま(評価観点が未整備)か。
 * 雛形には `"template": true` が入っており、evaluator が観点を書き起こすときに外す。
 */
export function isRubricTemplate(repoPath: string, rubric = loadRubric(repoPath)): boolean {
  return rubric?.template === true;
}

/** evaluations.jsonl の評価記録を読む(壊れた行は無視。なければ空) */
export function loadEvaluations(repoPath: string): EvaluationRecord[] {
  const path = evaluationsPath(repoPath);
  if (!existsSync(path)) return [];
  const records: EvaluationRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as EvaluationRecord;
      // 対象・成果物・判定がない行は表にできないため捨てる(エージェントの自己申告のため寛容に扱う)
      if (!record?.target || !record?.artifact || !record?.verdict) continue;
      records.push({ ...record, scores: Array.isArray(record.scores) ? record.scores : [] });
    } catch {
      // 壊れた行は無視
    }
  }
  return records;
}

/** 評価記録を追記する(ディレクトリがなければ作成) */
export function appendEvaluations(repoPath: string, records: EvaluationRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(evalDir(repoPath), { recursive: true });
  appendFileSync(evaluationsPath(repoPath), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** 成果物(エージェント + 成果物パス)を識別するキー */
export function evaluationKey(record: EvaluationRecord): string {
  // 区切りは NUL。エージェント名にも成果物のパスにも現れない文字なので、
  // "a b" と "a" + " b" のような衝突が起きない
  return `${record.target}\u0000${record.artifact}`;
}

/**
 * 成果物ごとの最新の評価だけを残す。
 * evaluations.jsonl は追記順とみなし、**同じ対象 + 成果物の行は後勝ち**にする
 * (再評価で合格に変わったものを、古い「要改善」で落とさないため。履歴は生ファイルに残る)。
 */
export function latestEvaluations(records: EvaluationRecord[]): EvaluationRecord[] {
  const latest = new Map<string, EvaluationRecord>();
  for (const record of records) latest.set(evaluationKey(record), record);
  return [...latest.values()];
}

/** その観点がそのエージェントに適用されるか(appliesTo 省略 / "*" は全員が対象) */
export function criterionApplies(criterion: RubricCriterion, agentName: string): boolean {
  const applies = criterion.appliesTo;
  if (!applies || applies.length === 0 || applies.includes("*")) return true;
  return applies.includes(agentName);
}

/**
 * そのエージェントに適用される観点だけを返す(rubric の並びを保つ)。
 * 「このエージェントは何を見られるのか」をエージェント単位で並べるときに使う。
 */
export function criteriaFor(rubric: Rubric | undefined, agentName: string): RubricCriterion[] {
  return (rubric?.criteria ?? []).filter((c) => criterionApplies(c, agentName));
}

/**
 * 総合スコア。記録に total があればそれを使い、なければ観点ごとの採点を
 * ルーブリックの weight で加重平均する(採点が 1 件もなければ undefined)。
 */
export function totalScore(record: EvaluationRecord, rubric?: Rubric): number | undefined {
  if (typeof record.total === "number") return record.total;
  const scores = record.scores ?? [];
  if (scores.length === 0) return undefined;
  let sum = 0;
  let weights = 0;
  for (const score of scores) {
    const weight = rubric?.criteria.find((c) => c.id === score.id)?.weight ?? 1;
    sum += score.score * weight;
    weights += weight;
  }
  if (weights === 0) return undefined;
  return Math.round((sum / weights) * 100) / 100;
}

/** 合格とみなす最低スコア(ルーブリック全体の既定) */
export function passScoreOf(rubric?: Rubric): number {
  return typeof rubric?.passScore === "number" ? rubric.passScore : DEFAULT_PASS_SCORE;
}

/**
 * その観点の閾値。観点ごとの `passScore` を優先し、なければルーブリック全体の合格線を使う
 * (「この観点だけは 4 以上を求める」といった設定ができる)。
 */
export function criterionPassScore(criterion: RubricCriterion, rubric?: Rubric): number {
  return typeof criterion.passScore === "number" ? criterion.passScore : passScoreOf(rubric);
}

/**
 * 閾値に対する採点結果ごとのネクストアクション。
 * 観点の `actions` を優先し、なければルーブリック全体の `actions` にフォールバックする
 * (共通の差し戻し手順を 1 か所に書き、観点ごとに上書きできるようにするため)。
 *
 * @param score 付いたスコア。undefined(未採点)なら空を返す
 */
export function nextActions(
  criterion: RubricCriterion,
  score: number | undefined,
  rubric?: Rubric,
): string[] {
  if (typeof score !== "number") return [];
  const kind = score >= criterionPassScore(criterion, rubric) ? "meets" : "below";
  const own = ownNextActions(criterion, kind);
  return own.length > 0 ? own : defaultNextActions(rubric, kind);
}

/**
 * その観点に固有のネクストアクション(ルーブリック直下の既定にはフォールバックしない)。
 * 表で「この観点だけの手順」と「全体の既定」を区別して見せるために使う。
 */
export function ownNextActions(criterion: RubricCriterion, kind: "below" | "meets"): string[] {
  return (kind === "below" ? criterion.actions?.below : criterion.actions?.meets) ?? [];
}

/** ルーブリック直下の既定のネクストアクション(観点に指定がないときに効くもの) */
export function defaultNextActions(
  rubric: Rubric | undefined,
  kind: "below" | "meets",
): string[] {
  return (kind === "below" ? rubric?.actions?.below : rubric?.actions?.meets) ?? [];
}

/** そのルーブリックにネクストアクションが 1 つでも設定されているか(表を出すかの判定) */
export function hasNextActions(rubric?: Rubric): boolean {
  if (!rubric) return false;
  const any = (a?: RubricActions) => (a?.below?.length ?? 0) > 0 || (a?.meets?.length ?? 0) > 0;
  return any(rubric.actions) || rubric.criteria.some((c) => any(c.actions));
}

/**
 * 評価対象にできるエージェントか(evaluator 自身は常に対象外)。
 * **機能の ON/OFF(requirements.rubricEval)は見ない** — 機能を撤去するときに
 * 「どのエージェントから指示を外すか」を決めるのにも使うため。
 */
export function isEvalTargetAgent(requirements: Requirements, agentName: string): boolean {
  if (NON_TARGET_AGENTS.includes(agentName)) return false;
  const targets = requirements.evalTargets;
  if (!targets) return true;
  // 設定にないエージェントは対象(黙って評価から外れないようにする)
  return targets[agentName] !== false;
}

/** 機能が有効で、かつそのエージェントが評価対象か */
export function isEvalTarget(requirements: Requirements, agentName: string): boolean {
  return requirements.rubricEval === true && isEvalTargetAgent(requirements, agentName);
}

/**
 * 評価対象のエージェント名(atf-settings.yaml の agents と evalTargets の突き合わせ)。
 * 指示文・ダッシュボード・ゲート判定で同じ一覧を使う。
 */
export function evalTargetNames(requirements: Requirements, agents: TeamAgent[]): string[] {
  return agents.filter((a) => isEvalTargetAgent(requirements, a.name)).map((a) => a.name);
}

/**
 * エージェントごとの ON/OFF 表を組み立てる(atf-settings.yaml に書き出す形)。
 * 既に設定されている値は残し、新しく増えたエージェントは true(評価する)で追加する。
 */
export function buildEvalTargets(
  agents: TeamAgent[],
  current?: Record<string, boolean>,
): Record<string, boolean> {
  const targets: Record<string, boolean> = {};
  for (const agent of agents) {
    if (NON_TARGET_AGENTS.includes(agent.name)) continue;
    targets[agent.name] = current?.[agent.name] !== false;
  }
  return targets;
}

/** 観点 1 件 × エージェント 1 体の交点(「誰の成果物を、どの観点で採点しているか」の 1 マス) */
export interface EvalCell {
  /** 観点の id(RubricCriterion.id) */
  criterion: string;
  /** この観点がこのエージェントに適用されるか(rubric の appliesTo で絞れる) */
  applies: boolean;
  /** この観点が採点された成果物の件数(最新の評価のみ) */
  scored: number;
  /** 平均スコア(採点がなければ undefined) */
  score?: number;
  /** この観点の閾値(観点ごとの passScore → ルーブリック全体の順) */
  threshold: number;
  /** 平均スコアが閾値以上か(未採点なら undefined) */
  meets?: boolean;
}

/** エージェント 1 体の評価状況(ダッシュボード・atf eval・status の 1 行) */
export interface AgentEvalStatus {
  agent: string;
  /** 評価した成果物の件数(最新のみ) */
  evaluated: number;
  /** 合格の件数 */
  passed: number;
  /** 未達(要改善・不合格・判定不能)の件数 */
  failed: number;
  /** 最新の評価(なければ undefined) */
  latest?: EvaluationRecord;
  /** 平均の総合スコア(採点がなければ undefined) */
  averageScore?: number;
  /**
   * 観点ごとの採点状況(rubric.criteria と同じ順・同じ件数)。
   * 「このエージェントがどの観点で見られているか」を表にするための行。
   * rubric がなければ空。
   */
  cells: EvalCell[];
}

/** 平均(空なら undefined。小数第 2 位で丸める) */
function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/**
 * 評価対象のエージェントごとに、最新評価を集計する。
 *
 * `cells` は rubric の観点と同じ並びで、「その観点がこのエージェントに適用されるか」と
 * 「実際に何件採点され、平均いくつか」を持つ。どのエージェントの成果物を
 * どの観点で採点しているかの表(CLI・ダッシュボード)は、これを 1 行ずつ並べたもの。
 */
export function agentEvalStatuses(
  targets: string[],
  records: EvaluationRecord[],
  rubric?: Rubric,
): AgentEvalStatus[] {
  const latest = latestEvaluations(records);
  return targets.map((agent) => {
    const mine = latest.filter((r) => r.target === agent);
    return {
      agent,
      evaluated: mine.length,
      passed: mine.filter((r) => isEvalPass(r.verdict)).length,
      failed: mine.filter((r) => !isEvalPass(r.verdict)).length,
      latest: records.filter((r) => r.target === agent).slice(-1)[0],
      averageScore: average(
        mine.map((r) => totalScore(r, rubric)).filter((s): s is number => typeof s === "number"),
      ),
      cells: (rubric?.criteria ?? []).map((criterion) => {
        const scores = mine
          .flatMap((r) => r.scores ?? [])
          .filter((sc) => sc.id === criterion.id)
          .map((sc) => sc.score);
        const score = average(scores);
        const threshold = criterionPassScore(criterion, rubric);
        return {
          criterion: criterion.id,
          applies: criterionApplies(criterion, agent),
          scored: scores.length,
          score,
          threshold,
          meets: typeof score === "number" ? score >= threshold : undefined,
        };
      }),
    };
  });
}

/**
 * 「この成果物のこの観点は閾値をどう跨いだか、次に何をするか」の 1 件。
 * 差し戻し(閾値未満)と、次に進む手順(閾値以上)の両方を同じ形で扱う。
 */
export interface NextActionItem {
  /** 評価されたエージェント */
  agent: string;
  /** 評価された成果物 */
  artifact: string;
  /** 観点の id */
  criterion: string;
  /** 観点の名前 */
  criterionName: string;
  /** 付いたスコア */
  score: number;
  /** その観点の閾値 */
  threshold: number;
  /** 閾値以上だったか */
  meets: boolean;
  /** ルーブリックに設定されたネクストアクション */
  actions: string[];
}

/**
 * 最新の評価から、ルーブリックに設定されたネクストアクションを取り出す。
 *
 * 採点された観点ごとに閾値と突き合わせ、`below` / `meets` のどちらを出すかを決める。
 * アクションが設定されていない観点は返さない(「何もしなくてよい」ではなく「未設定」なので、
 * 表に空行を作らない)。
 *
 * @param only "below" で未達のぶんだけ、"meets" で達成のぶんだけに絞る
 */
export function nextActionItems(
  rubric: Rubric | undefined,
  records: EvaluationRecord[],
  targets: string[],
  only?: "below" | "meets",
): NextActionItem[] {
  if (!rubric) return [];
  const items: NextActionItem[] = [];
  for (const record of latestEvaluations(records).filter((r) => targets.includes(r.target))) {
    for (const scored of record.scores ?? []) {
      const criterion = rubric.criteria.find((c) => c.id === scored.id);
      // ルーブリックにない観点の採点は、基準と対応が取れないので扱わない
      if (!criterion || !criterionApplies(criterion, record.target)) continue;
      const threshold = criterionPassScore(criterion, rubric);
      const meets = scored.score >= threshold;
      if (only === "below" && meets) continue;
      if (only === "meets" && !meets) continue;
      const actions = nextActions(criterion, scored.score, rubric);
      if (actions.length === 0) continue;
      items.push({
        agent: record.target,
        artifact: record.artifact,
        criterion: criterion.id,
        criterionName: criterion.name,
        score: scored.score,
        threshold,
        meets,
        actions,
      });
    }
  }
  return items;
}

/**
 * 「合格」と記録されているのに、閾値未満の観点が残っている評価。
 *
 * 合否そのものは evaluator の判断(`verdict`)が単一情報源だが、閾値を設定した以上は
 * 食い違いを黙って通さない。atf はこれを**要確認**として報告するだけで、判定は書き換えない。
 */
export function thresholdMismatches(
  rubric: Rubric | undefined,
  records: EvaluationRecord[],
  targets: string[],
): Array<{ record: EvaluationRecord; below: string[] }> {
  if (!rubric) return [];
  const out: Array<{ record: EvaluationRecord; below: string[] }> = [];
  for (const record of latestEvaluations(records).filter((r) => targets.includes(r.target))) {
    if (!isEvalPass(record.verdict)) continue;
    const below = (record.scores ?? [])
      .filter((scored) => {
        const criterion = rubric.criteria.find((c) => c.id === scored.id);
        if (!criterion || !criterionApplies(criterion, record.target)) return false;
        return scored.score < criterionPassScore(criterion, rubric);
      })
      .map((scored) => scored.id);
    if (below.length > 0) out.push({ record, below });
  }
  return out;
}

/** 評価ゲートの状況 */
export interface EvalGateStatus {
  /** 評価対象のエージェント数 */
  targets: number;
  /** 合格した成果物の件数(最新の評価のみ) */
  passed: number;
  /** 未達(要改善・不合格・判定不能)の成果物の件数 */
  failed: number;
  /** 評価記録が 1 件もない対象エージェント */
  unevaluated: string[];
  /** ルーブリックの評価観点の件数 */
  criteria: number;
  /** ゲートを通過しているか */
  ok: boolean;
}

/**
 * 記録済みの評価から、成果物を完了としてよいか(評価ゲート)を判定する。
 * ダッシュボード・CLI・orchestrator への説明で同じ判定を使う。
 *
 * 通過の条件は「評価観点が定義されている」「対象エージェントがすべて評価済み」
 * 「未達の成果物が 1 件も残っていない」の 3 つ。
 */
export function evalGateStatus(
  rubric: Rubric | undefined,
  records: EvaluationRecord[],
  targets: string[],
): EvalGateStatus {
  const criteria = rubric?.criteria.length ?? 0;
  const latest = latestEvaluations(records).filter((r) => targets.includes(r.target));
  const passed = latest.filter((r) => isEvalPass(r.verdict)).length;
  const failed = latest.length - passed;
  const unevaluated = targets.filter((t) => !latest.some((r) => r.target === t));
  return {
    targets: targets.length,
    passed,
    failed,
    unevaluated,
    criteria,
    ok: criteria > 0 && targets.length > 0 && failed === 0 && unevaluated.length === 0,
  };
}
