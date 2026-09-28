import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ArchCheckRecord, ArchResult, ArchRule, ArchRuleSet } from "./types.js";

/** アーキテクチャ規約と検証記録の置き場 */
export function archDir(repoPath: string): string {
  return join(repoPath, ".claude", "atf-arch");
}

/** レイヤ規約の定義ファイル(規約の単一情報源) */
export function archRulesPath(repoPath: string): string {
  return join(archDir(repoPath), "rules.json");
}

/** 検証記録ファイル(1 行 1 規約の JSONL) */
export function archChecksPath(repoPath: string): string {
  return join(archDir(repoPath), "checks.jsonl");
}

/** JUnit XML を ARCH 行に変換するスクリプト(ArchUnit 系のツールで共用する) */
export function archReportJunitPath(repoPath: string): string {
  return join(archDir(repoPath), "report-junit.mjs");
}

/** 検証の実行スクリプト(言語ごとの検証ツールを呼ぶ薄いラッパ。arch-guard が中身を埋める) */
export function archRunnerPath(repoPath: string): string {
  return join(archDir(repoPath), "run-arch-check.sh");
}

/**
 * atf が置いた run-arch-check.sh の雛形に含まれる目印。
 * 「検証ツールがまだ配線されていない」判定の単一情報源で、
 * 雛形本体(generator.ts)と点検(features.ts / apply.ts)の両方がこれを使う。
 */
export const ARCH_RUNNER_TEMPLATE_MARK =
  "run-arch-check.sh に検証コマンドが設定されていません(arch-guard に検証の実装を依頼してください)";

/** 検証スクリプトが atf の雛形のまま(検証ツールが未配線)か */
export function isArchRunnerTemplate(repoPath: string): boolean {
  const path = archRunnerPath(repoPath);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(ARCH_RUNNER_TEMPLATE_MARK);
}

/** 結果 → 表示用ラベル(CLI・ダッシュボードで共通に使う) */
export const ARCH_RESULT_LABEL: Record<ArchResult, string> = {
  pass: "✅ 適合(違反なし)",
  violation: "❌ 違反あり(実装が規約から外れている)",
  error: "⚠️ 検証エラー(ツール未導入・設定エラー)",
  unknown: "❓ 判定不能",
};

/** 規約の種類 → 表示ラベル */
export const ARCH_RULE_KIND_LABEL: Record<string, string> = {
  forbid: "依存の禁止",
  "allow-only": "依存先の限定",
  "no-cycle": "循環依存の禁止",
  naming: "命名・配置",
  custom: "その他",
};

/** 検証を実行できないときに CLI・エージェントへ出す案内 */
export const ARCH_RUNNER_HELP = `アーキテクチャ検証を実行できません。次を確認してください:
  - .claude/atf-arch/run-arch-check.sh があるか(なければ arch-guard に検証の設定を依頼する)
  - 検証ツール(ArchUnit / ArchUnitTS / ArchUnitPython / go-arch-lint / dependency-cruiser など。一覧は .claude/atf-arch/README.md)が導入されているか
スクリプトは規約ごとに 1 行 "ARCH <規約 id> <PASS|VIOLATION|ERROR> [違反件数] [詳細]" を出力する規約です。`;

/** 規約が満たされているか(違反・エラー・判定不能は未達) */
export function isArchPass(result: ArchResult): boolean {
  return result === "pass";
}

/** rules.json を読む(なければ undefined。壊れていれば undefined) */
export function loadArchRules(repoPath: string): ArchRuleSet | undefined {
  const path = archRulesPath(repoPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ArchRuleSet;
    if (!Array.isArray(parsed?.rules)) return undefined;
    return { ...parsed, layers: Array.isArray(parsed.layers) ? parsed.layers : [] };
  } catch {
    // 壊れた rules.json はダッシュボード・CLI を落とさず「未定義」として扱う
    return undefined;
  }
}

/** checks.jsonl の検証記録を読む(壊れた行は無視。なければ空) */
export function loadArchChecks(repoPath: string): ArchCheckRecord[] {
  const path = archChecksPath(repoPath);
  if (!existsSync(path)) return [];
  const checks: ArchCheckRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as ArchCheckRecord;
      if (!record?.rule || !record?.result) continue;
      checks.push(record);
    } catch {
      // エージェントの自己申告も混ざるため、壊れた行は寛容に無視する
    }
  }
  return checks;
}

/** 検証記録を追記する(ディレクトリがなければ作成) */
export function appendArchChecks(repoPath: string, records: ArchCheckRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(archDir(repoPath), { recursive: true });
  appendFileSync(archChecksPath(repoPath), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** 規約に対する最新の検証記録(checks.jsonl は追記順とみなし、最後の 1 件を採用) */
export function latestArchCheck(
  checks: ArchCheckRecord[],
  rule: string,
): ArchCheckRecord | undefined {
  return checks.filter((c) => c.rule === rule).slice(-1)[0];
}

/**
 * 検証スクリプトの出力を規約単位の結果に分解する。
 *
 * 検証ツールは言語ごとに異なる(ArchUnit / dependency-cruiser / import-linter / deptrac …)ため、
 * atf はツールを直接叩かず「1 行 1 規約」の共通形式だけを決めている:
 *
 *     ARCH ARCH-01 PASS
 *     ARCH ARCH-02 VIOLATION 3 domain -> infra への依存が 3 件
 *     ARCH ARCH-03 ERROR dependency-cruiser が見つかりません
 *
 * タブ区切り(ARCH / 規約 id / 判定 / 件数 / 詳細)でも読める。
 * 違反件数は省略でき、その場合は詳細として扱う。
 */
export function parseArchOutput(output: string): Omit<ArchCheckRecord, "checkedAt" | "agent">[] {
  const records: Omit<ArchCheckRecord, "checkedAt" | "agent">[] = [];
  for (const raw of output.split("\n")) {
    // 検証ツールが混ぜる ANSI エスケープ・バックスペースは記録前に取り除く
    const line = raw
      .replace(/\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[\b\r]/g, "")
      .trim();
    if (!line) continue;
    if (!/^ARCH\b/i.test(line)) continue;

    // タブ区切りが含まれていればフィールドとして扱う(詳細に空白が多い出力に強い)
    const fields = line.includes("\t") ? line.split("\t").map((f) => f.trim()) : undefined;
    let rule: string;
    let verdict: string;
    let rest: string;
    if (fields && fields.filter(Boolean).length >= 3) {
      const filled = fields.filter(Boolean);
      rule = filled[1];
      verdict = filled[2];
      rest = filled.slice(3).join(" ");
    } else {
      const m = line.match(/^ARCH\s+(\S+)\s+(\S+)\s*(.*)$/i);
      if (!m) continue;
      rule = m[1];
      verdict = m[2];
      rest = m[3];
    }

    const result = toArchResult(verdict);
    // 詳細の先頭が数値なら違反件数として扱う(VIOLATION 3 domain -> infra …)
    const countMatch = rest.match(/^(\d+)\s*(.*)$/);
    const violations = countMatch ? Number(countMatch[1]) : undefined;
    const detail = (countMatch ? countMatch[2] : rest).trim();
    records.push({
      rule,
      result,
      ...(violations !== undefined ? { violations } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return records;
}

/** 出力中の判定語を結果に変換する(ツールごとの語彙差を吸収する) */
function toArchResult(verdict: string): ArchResult {
  const v = verdict.toUpperCase();
  if (["PASS", "OK", "SUCCESS"].includes(v)) return "pass";
  if (["VIOLATION", "VIOLATIONS", "FAIL", "FAILED", "NG"].includes(v)) return "violation";
  if (["ERROR", "SKIP", "SKIPPED"].includes(v)) return "error";
  return "unknown";
}

export interface ArchVerifyReport {
  /** 実行した検証スクリプト(見つからなければ undefined) */
  runner?: string;
  /** スクリプトを起動できたか */
  executed: boolean;
  checks: ArchCheckRecord[];
  /** 記録されなかった(検証されていない)規約の id */
  unchecked: string[];
  /** 生の出力(判定できなかったときの手がかり) */
  output: string;
  /** すべての規約が適合していたか(規約が 1 件もない場合は false) */
  passed: boolean;
}

/**
 * .claude/atf-arch/run-arch-check.sh を実行してアーキテクチャ適合を検証し、
 * 結果を checks.jsonl に追記する(atf arch)。
 *
 * 検証の実体は言語ごとのツール(ArchUnit など)で、atf は実行・記録・集計だけを担う。
 * @param now 検証時刻(ISO 8601)。テストから固定値を渡せるようにしている
 */
export function verifyArch(
  repoPath: string,
  opts: { now?: string; agent?: string; runner?: string } = {},
): ArchVerifyReport {
  const rules = loadArchRules(repoPath);
  const ruleIds = (rules?.rules ?? []).map((r: ArchRule) => r.id);
  const checkedAt = opts.now ?? new Date().toISOString();
  const agent = opts.agent ?? "atf arch";
  const runner = opts.runner ?? archRunnerPath(repoPath);

  if (!existsSync(runner)) {
    return {
      runner: undefined,
      executed: false,
      checks: [],
      unchecked: ruleIds,
      output: ARCH_RUNNER_HELP,
      passed: false,
    };
  }

  const proc = spawnSync("bash", [runner], { cwd: repoPath, encoding: "utf8" });
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  if (proc.error) {
    return {
      runner,
      executed: false,
      checks: [],
      unchecked: ruleIds,
      output: `検証スクリプトを起動できませんでした: ${proc.error.message}`,
      passed: false,
    };
  }

  const checks: ArchCheckRecord[] = parseArchOutput(output).map((r) => ({
    ...r,
    ...(rules?.tool ? { tool: rules.tool } : {}),
    checkedAt,
    agent,
  }));
  // 1 行も解釈できなかった場合は、終了コードから実行単位の結果を記録する
  // (検証ツールが共通形式を出していない = 設定が未完了のことが多い)
  if (checks.length === 0) {
    checks.push({
      rule: "(実行)",
      result: proc.status === 0 ? "unknown" : "error",
      detail:
        output
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-1)[0] ?? `exit ${proc.status}`,
      ...(rules?.tool ? { tool: rules.tool } : {}),
      checkedAt,
      agent,
    });
  }
  appendArchChecks(repoPath, checks);

  const unchecked = ruleIds.filter((id) => !checks.some((c) => c.rule === id));
  return {
    runner,
    executed: true,
    checks,
    unchecked,
    output,
    passed:
      ruleIds.length > 0 &&
      unchecked.length === 0 &&
      checks.filter((c) => ruleIds.includes(c.rule)).every((c) => isArchPass(c.result)),
  };
}

/**
 * 記録済みの検証結果から、実装を進めてよいか(適合ゲート)を判定する。
 * ダッシュボードと CLI・orchestrator への説明で同じ判定を使う。
 */
export function archGateStatus(
  rules: ArchRuleSet | undefined,
  checks: ArchCheckRecord[],
): { violated: number; unchecked: number; passed: number; ok: boolean } {
  const ruleList = rules?.rules ?? [];
  let violated = 0;
  let unchecked = 0;
  let passed = 0;
  for (const rule of ruleList) {
    const check = latestArchCheck(checks, rule.id);
    if (!check) unchecked++;
    else if (isArchPass(check.result)) passed++;
    else violated++;
  }
  return {
    violated,
    unchecked,
    passed,
    ok: ruleList.length > 0 && violated === 0 && unchecked === 0,
  };
}
