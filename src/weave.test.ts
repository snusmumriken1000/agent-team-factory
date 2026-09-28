import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrDir } from "./adr.js";
import { checksPath, formalDir, specDir } from "./alloy.js";
import { BANNER, generatedDir, planWeave, runWeave } from "./weave.js";

const ROOT = `/**
 * 注文システムのコア仕様。
 * @title  注文システム
 * @scope  注文の状態遷移と出荷の関係。
 * @out-of-scope 決済ゲートウェイの内部
 * @out-of-scope 通知の文面
 * @stakeholder プロダクトオーナー (承認: 2026-01-01)
 * @tradeoff 品質(品質を落としてまで期日を守らない)
 */
module main

open order
`;

const ORDER = `/**
 * @module order
 * @scope  注文と出荷。
 */
module order

sig Customer {}

/**
 * 注文。顧客なしでは存在できない。
 * @term 注文 / Order
 * @rationale 状態を別 sig にすると遷移が二重化する。
 */
sig Order {
  /** @term 注文者 / Customer */
  customer: one Customer
}

/**
 * @req R-01  すべての注文はちょうど 1 人の顧客に属する
 */
fact OrderHasCustomer { all o: Order | one o.customer }

/**
 * @req R-01
 * @validation 注文データの整合性に対する機械的証拠
 */
check NoOrphanOrder for 5

sig Undocumented {}
`;

describe("runWeave", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-weave-"));
    mkdirSync(specDir(dir), { recursive: true });
    mkdirSync(formalDir(dir), { recursive: true });
    mkdirSync(adrDir(dir), { recursive: true });
    writeFileSync(join(specDir(dir), "main.als"), ROOT);
    writeFileSync(join(specDir(dir), "order.als"), ORDER);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (name: string) => readFileSync(join(generatedDir(dir), name), "utf8");

  it("4 つの文書とモデルごとの解説ページを docs/generated/ に出す", () => {
    const result = runWeave(dir, "demo");
    expect(result.dir).toBe(generatedDir(dir));
    expect(result.written.sort()).toEqual(
      [
        "glossary.md",
        "main.explain.html",
        "order.explain.html",
        "overview.md",
        "spec.md",
        "traceability.md",
      ].sort(),
    );
  });

  it("すべての生成物に DO NOT EDIT の表示を付ける", () => {
    runWeave(dir, "demo");
    for (const name of ["overview.md", "spec.md", "glossary.md", "traceability.md"]) {
      expect(read(name).startsWith(BANNER)).toBe(true);
    }
  });

  it("overview はルートモジュールのタグから作る", () => {
    runWeave(dir, "demo");
    const overview = read("overview.md");
    expect(overview).toContain("# 注文システム");
    expect(overview).toContain("注文の状態遷移と出荷の関係。");
    expect(overview).toContain("- 決済ゲートウェイの内部");
    expect(overview).toContain("- 通知の文面");
    expect(overview).toContain("プロダクトオーナー (承認: 2026-01-01)");
    expect(overview).toContain("品質(品質を落としてまで期日を守らない)");
    // モジュール一覧はルートが先頭
    expect(overview.indexOf("spec/main.als")).toBeLessThan(overview.indexOf("spec/order.als"));
  });

  it("spec.md は doc comment とシグネチャを並べ、注釈のない宣言を洗い出す", () => {
    runWeave(dir, "demo");
    const spec = read("spec.md");
    expect(spec).toContain("すべての注文はちょうど 1 人の顧客に属する");
    expect(spec).toContain("- なぜこの形か: 状態を別 sig にすると遷移が二重化する。");
    expect(spec).toContain("```alloy");
    expect(spec).toContain("fact OrderHasCustomer");
    expect(spec).toContain("注釈(doc comment)のない宣言");
    expect(spec).toContain("sig Undocumented");
  });

  it("glossary は @term から作る(フィールドの用語も含む)", () => {
    runWeave(dir, "demo");
    const glossary = read("glossary.md");
    expect(glossary).toContain("| 注文 / Order | `Order` |");
    expect(glossary).toContain("| 注文者 / Customer | `Order.customer` |");
  });

  it("traceability は要件 × 検証 × ADR を突き合わせる", () => {
    writeFileSync(
      join(adrDir(dir), "0001-order-customer.md"),
      "# ADR-0001: 注文に顧客を必須とする\n\nStatus: accepted\nDate: 2026-01-02\nRefs: R-01\n",
    );
    writeFileSync(
      checksPath(dir),
      JSON.stringify({ model: "order.als", command: "NoOrphanOrder", result: "pass" }) + "\n",
    );
    runWeave(dir, "demo");

    const trace = read("traceability.md");
    expect(trace).toContain("R-01");
    expect(trace).toContain("check NoOrphanOrder");
    expect(trace).toContain("反例なし");
    expect(trace).toContain("ADR-0001");
  });

  it("ADR が参照する未定義の要件を洗い出す", () => {
    writeFileSync(
      join(adrDir(dir), "0002-ghost.md"),
      "# ADR-0002: 幽霊\n\nStatus: accepted\nDate: 2026-01-02\nRefs: R-99\n",
    );
    runWeave(dir, "demo");
    expect(read("traceability.md")).toContain("R-99(ADR-0002)");
  });

  it("決定的に生成する(同じ入力なら 2 回目は変更なし)", () => {
    runWeave(dir, "demo");
    const second = runWeave(dir, "demo");
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  it("元の .als が消えた生成物は取り除く", () => {
    runWeave(dir, "demo");
    expect(existsSync(join(generatedDir(dir), "order.explain.html"))).toBe(true);

    rmSync(join(specDir(dir), "order.als"));
    const result = runWeave(dir, "demo");

    expect(result.removed).toEqual(["order.explain.html"]);
    expect(existsSync(join(generatedDir(dir), "order.explain.html"))).toBe(false);
  });

  it("ルートモジュールがなければ、その旨を overview に書く", () => {
    rmSync(join(specDir(dir), "main.als"));
    runWeave(dir, "demo");
    expect(read("overview.md")).toContain("ルートモジュール `spec/main.als` がありません");
  });
});

describe("planWeave", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-weave-plan-"));
    mkdirSync(specDir(dir), { recursive: true });
    writeFileSync(join(specDir(dir), "main.als"), ROOT);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("未生成なら変更ありとして返し、生成後は空になる", () => {
    expect(planWeave(dir, "demo").changed.length).toBeGreaterThan(0);
    runWeave(dir, "demo");
    expect(planWeave(dir, "demo")).toEqual({ changed: [], removed: [] });
  });

  it("書き込まない(調べるだけ)", () => {
    planWeave(dir, "demo");
    expect(existsSync(generatedDir(dir))).toBe(false);
  });
});
