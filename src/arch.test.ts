import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendArchChecks,
  archChecksPath,
  archDir,
  archGateStatus,
  archRulesPath,
  isArchPass,
  latestArchCheck,
  loadArchChecks,
  loadArchRules,
  parseArchOutput,
  verifyArch,
} from "./arch.js";
import type { ArchRuleSet } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-arch-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const RULES: ArchRuleSet = {
  project: "example",
  tool: "dependency-cruiser",
  layers: [
    { id: "domain", name: "ドメイン", patterns: ["src/domain/**"] },
    { id: "infra", name: "インフラ", patterns: ["src/infra/**"] },
  ],
  rules: [
    {
      id: "ARCH-01",
      kind: "forbid",
      from: "domain",
      to: ["infra"],
      description: "ドメインはインフラに依存しない",
      tool: "no-domain-to-infra",
    },
    { id: "ARCH-02", kind: "no-cycle", description: "循環依存を禁止する", tool: "no-circular" },
  ],
  notes: ["トランザクション境界はレビューで担保する"],
};

function writeRules(rules: unknown = RULES): void {
  mkdirSync(archDir(repoDir), { recursive: true });
  writeFileSync(archRulesPath(repoDir), JSON.stringify(rules, null, 2));
}

/** 出力を固定した検証スクリプトを置く(検証ツールの代わり) */
function writeRunner(lines: string[], exitCode = 0): void {
  mkdirSync(archDir(repoDir), { recursive: true });
  const path = join(archDir(repoDir), "run-arch-check.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${lines.map((l) => `echo "${l}"`).join("\n")}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
}

describe("loadArchRules", () => {
  it("rules.json を読む", () => {
    writeRules();
    const rules = loadArchRules(repoDir);
    expect(rules?.rules.map((r) => r.id)).toEqual(["ARCH-01", "ARCH-02"]);
    expect(rules?.layers).toHaveLength(2);
  });

  it("未定義・壊れた JSON は undefined を返す(ダッシュボードを落とさない)", () => {
    expect(loadArchRules(repoDir)).toBeUndefined();
    mkdirSync(archDir(repoDir), { recursive: true });
    writeFileSync(archRulesPath(repoDir), "{ 壊れた");
    expect(loadArchRules(repoDir)).toBeUndefined();
  });

  it("rules が配列でない定義は undefined として扱う", () => {
    writeRules({ layers: [], rules: "invalid" });
    expect(loadArchRules(repoDir)).toBeUndefined();
  });
});

describe("parseArchOutput", () => {
  it("規約ごとの判定・違反件数・詳細を読む", () => {
    const records = parseArchOutput(
      [
        "ARCH ARCH-01 PASS",
        "ARCH ARCH-02 VIOLATION 3 src/app/service.ts が src/web/ に依存している",
        "ARCH ARCH-03 ERROR dependency-cruiser が未導入",
        "",
        "何か別の出力行(無視される)",
      ].join("\n"),
    );
    expect(records).toEqual([
      { rule: "ARCH-01", result: "pass" },
      {
        rule: "ARCH-02",
        result: "violation",
        violations: 3,
        detail: "src/app/service.ts が src/web/ に依存している",
      },
      { rule: "ARCH-03", result: "error", detail: "dependency-cruiser が未導入" },
    ]);
  });

  it("タブ区切りの出力も読む", () => {
    const records = parseArchOutput("ARCH\tARCH-01\tVIOLATION\t2\tdomain -> infra が 2 件");
    expect(records).toEqual([
      { rule: "ARCH-01", result: "violation", violations: 2, detail: "domain -> infra が 2 件" },
    ]);
  });

  it("ツールごとの語彙差(OK / FAIL / SKIP)を吸収する", () => {
    const records = parseArchOutput(
      ["ARCH A OK", "ARCH B FAIL", "ARCH C SKIP", "ARCH D なにか"].join("\n"),
    );
    expect(records.map((r) => r.result)).toEqual(["pass", "violation", "error", "unknown"]);
  });
});

describe("verifyArch", () => {
  it("検証スクリプトを実行して結果を checks.jsonl に記録する", () => {
    writeRules();
    writeRunner(["ARCH ARCH-01 PASS", "ARCH ARCH-02 PASS"]);

    const report = verifyArch(repoDir, { now: "2026-01-01T00:00:00Z" });

    expect(report.executed).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.unchecked).toEqual([]);
    expect(report.checks.map((c) => [c.rule, c.result])).toEqual([
      ["ARCH-01", "pass"],
      ["ARCH-02", "pass"],
    ]);
    // ツール名と検証時刻が記録される
    expect(report.checks[0]).toMatchObject({
      tool: "dependency-cruiser",
      checkedAt: "2026-01-01T00:00:00Z",
      agent: "atf arch",
    });
    const recorded = loadArchChecks(repoDir);
    expect(recorded).toHaveLength(2);
  });

  it("違反があれば未通過になる", () => {
    writeRules();
    writeRunner(["ARCH ARCH-01 VIOLATION 1 src/domain/order.ts", "ARCH ARCH-02 PASS"], 1);

    const report = verifyArch(repoDir);

    expect(report.executed).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.checks[0]).toMatchObject({ result: "violation", violations: 1 });
  });

  it("規約の行が欠けていれば未検証として未通過にする", () => {
    writeRules();
    writeRunner(["ARCH ARCH-01 PASS"]);

    const report = verifyArch(repoDir);

    expect(report.unchecked).toEqual(["ARCH-02"]);
    expect(report.passed).toBe(false);
  });

  it("共通形式を出さないスクリプトは終了コードから実行単位の結果を記録する", () => {
    writeRules();
    writeRunner(["検証ツールがありません"], 2);

    const report = verifyArch(repoDir);

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ rule: "(実行)", result: "error" });
    expect(report.passed).toBe(false);
  });

  it("検証スクリプトがなければ実行せず案内を返す", () => {
    writeRules();

    const report = verifyArch(repoDir);

    expect(report.executed).toBe(false);
    expect(report.runner).toBeUndefined();
    expect(report.unchecked).toEqual(["ARCH-01", "ARCH-02"]);
    expect(report.output).toContain("run-arch-check.sh");
  });
});

describe("loadArchChecks / appendArchChecks", () => {
  it("壊れた行・必須項目のない行を無視して読む", () => {
    mkdirSync(archDir(repoDir), { recursive: true });
    writeFileSync(
      archChecksPath(repoDir),
      [
        JSON.stringify({ rule: "ARCH-01", result: "pass" }),
        "{ 壊れた行",
        JSON.stringify({ result: "pass" }),
        "",
        JSON.stringify({ rule: "ARCH-01", result: "violation", violations: 2 }),
      ].join("\n"),
    );

    const checks = loadArchChecks(repoDir);
    expect(checks).toHaveLength(2);
    // 同じ規約は追記順に並び、最新は最後の行
    expect(latestArchCheck(checks, "ARCH-01")).toMatchObject({ result: "violation" });
  });

  it("追記でディレクトリを作る", () => {
    appendArchChecks(repoDir, [{ rule: "ARCH-01", result: "pass" }]);
    expect(readFileSync(archChecksPath(repoDir), "utf8")).toContain("ARCH-01");
  });
});

describe("archGateStatus", () => {
  it("違反・未検証・適合を数え、すべて適合のときだけ通過にする", () => {
    expect(archGateStatus(RULES, [])).toEqual({
      violated: 0,
      unchecked: 2,
      passed: 0,
      ok: false,
    });
    expect(
      archGateStatus(RULES, [
        { rule: "ARCH-01", result: "pass" },
        { rule: "ARCH-02", result: "violation" },
      ]),
    ).toEqual({ violated: 1, unchecked: 0, passed: 1, ok: false });
    expect(
      archGateStatus(RULES, [
        { rule: "ARCH-01", result: "pass" },
        { rule: "ARCH-02", result: "pass" },
      ]),
    ).toEqual({ violated: 0, unchecked: 0, passed: 2, ok: true });
  });

  it("規約が 1 件もなければ通過にしない", () => {
    expect(archGateStatus(undefined, []).ok).toBe(false);
  });

  it("適合は pass のみ(エラー・判定不能は未達)", () => {
    expect(isArchPass("pass")).toBe(true);
    expect(isArchPass("violation")).toBe(false);
    expect(isArchPass("error")).toBe(false);
    expect(isArchPass("unknown")).toBe(false);
  });
});
