import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrDir } from "./adr.js";
import { specDir } from "./alloy.js";
import { hasLintErrors, lintFormal } from "./lint.js";

const ROOT = `/**
 * @title  注文システム
 * @scope  注文の状態遷移。
 * @out-of-scope 決済ゲートウェイの内部
 * @stakeholder プロダクトオーナー (承認: 2026-01-01)
 * @tradeoff 品質
 */
module main
`;

const ORDER = `module order

/**
 * @req R-01  すべての注文はちょうど 1 人の顧客に属する
 */
fact OrderHasCustomer { all o: Order | one o.customer }

/**
 * @req R-01
 */
check NoOrphanOrder for 5
`;

describe("lintFormal", () => {
  let dir: string;
  const rules = (repo: string) => lintFormal(repo).map((f) => f.rule);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-lint-"));
    mkdirSync(specDir(dir), { recursive: true });
    mkdirSync(adrDir(dir), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "docs/generated/\n");
    writeFileSync(join(specDir(dir), "main.als"), ROOT);
    writeFileSync(join(specDir(dir), "order.als"), ORDER);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("規約を満たしていれば何も報告しない", () => {
    expect(lintFormal(dir)).toEqual([]);
  });

  it("@usecase が参照するアクターに @actor がなければ警告する", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      ORDER + "\n/**\n * @usecase 顧客 注文を確定する\n */\npred Place { some Order }\n",
    );
    const finding = lintFormal(dir).find((f) => f.rule === "usecase-actor");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("顧客");
    expect(hasLintErrors(lintFormal(dir))).toBe(false);
  });

  it("@actor が定義されていれば @usecase は警告しない", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      ORDER +
        "\n/**\n * @actor 顧客 注文を出す人\n */\nsig Customer {}\n" +
        "\n/**\n * @usecase 顧客 注文を確定する\n */\npred Place { some Order }\n",
    );
    expect(rules(dir)).not.toContain("usecase-actor");
  });

  it("アクターを書き忘れた @usecase を警告する", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      ORDER + "\n/**\n * @usecase 注文を確定する\n */\npred Place { some Order }\n",
    );
    const finding = lintFormal(dir).find((f) => f.rule === "usecase-actor");
    expect(finding?.message).toContain("アクターがありません");
  });

  it("ルートモジュールがなければ違反", () => {
    rmSync(join(specDir(dir), "main.als"));
    const findings = lintFormal(dir);
    expect(findings[0].rule).toBe("root-module");
    expect(hasLintErrors(findings)).toBe(true);
  });

  it("必須タグの欠落を違反として報告する", () => {
    writeFileSync(join(specDir(dir), "main.als"), "/**\n * @title 注文\n */\nmodule main\n");
    const messages = lintFormal(dir).map((f) => f.message);
    expect(messages).toContain("ルートモジュールに @scope がありません");
    expect(messages).toContain("ルートモジュールに @out-of-scope がありません");
    expect(messages).toContain("ルートモジュールに @stakeholder がありません");
  });

  it("雛形(TODO)のままの必須タグは「書いていない」のと同じに扱う", () => {
    writeFileSync(
      join(specDir(dir), "main.als"),
      "/**\n * @title  TODO: 名称\n * @scope  受注\n * @out-of-scope なし\n * @stakeholder PO\n */\nmodule main\n",
    );
    const findings = lintFormal(dir);
    expect(findings.some((f) => f.message.includes("@title が雛形(TODO)のままです"))).toBe(true);
    expect(hasLintErrors(findings)).toBe(true);
  });

  it("@tradeoff がなければ警告する(落とさない)", () => {
    writeFileSync(
      join(specDir(dir), "main.als"),
      "/**\n * @title 注文\n * @scope 受注\n * @out-of-scope なし\n * @stakeholder PO\n */\nmodule main\n",
    );
    const findings = lintFormal(dir);
    expect(findings.map((f) => f.rule)).toEqual(["root-tradeoff"]);
    expect(hasLintErrors(findings)).toBe(false);
  });

  it("要件の文が 2 か所で定義されていれば違反(参照は ID だけにする)", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      ORDER.replace("* @req R-01\n", "* @req R-01  すべての注文はちょうど 1 人の顧客に属する\n"),
    );
    const findings = lintFormal(dir);
    expect(findings[0].rule).toBe("req-duplicate");
    expect(findings[0].message).toContain("R-01");
  });

  it("check に @req がなければ違反", () => {
    writeFileSync(join(specDir(dir), "order.als"), "module order\n\ncheck NoOrphanOrder for 5\n");
    expect(rules(dir)).toContain("check-req");
  });

  it("無名の check / run は違反", () => {
    writeFileSync(join(specDir(dir), "order.als"), "module order\n\ncheck { some none } for 5\n");
    expect(rules(dir)).toContain("command-unnamed");
  });

  it("ADR の Refs が .als にない要件を指していれば孤児として違反", () => {
    writeFileSync(
      join(adrDir(dir), "0001-x.md"),
      "# ADR-0001: x\n\nStatus: accepted\nDate: 2026-01-01\nRefs: R-99\n\n## 決定\n\n〜と決定した。\n",
    );
    const findings = lintFormal(dir);
    expect(findings[0].rule).toBe("adr-orphan");
    expect(findings[0].message).toContain("R-99");
  });

  it("supersede 先が存在しなければ違反", () => {
    writeFileSync(
      join(adrDir(dir), "0001-x.md"),
      "# ADR-0001: x\n\nStatus: superseded by ADR-0009\nDate: 2026-01-01\nRefs: R-01\n",
    );
    expect(rules(dir)).toContain("adr-supersede");
  });

  it("ADR の「## 決定」に現行ルール(規範文)があれば警告する", () => {
    writeFileSync(
      join(adrDir(dir), "0001-x.md"),
      "# ADR-0001: x\n\nStatus: accepted\nDate: 2026-01-01\nRefs: R-01\n\n## 決定\n\n注文は必ず顧客を持たなければならない。\n",
    );
    const findings = lintFormal(dir);
    expect(findings.map((f) => f.rule)).toContain("adr-present-tense");
    expect(hasLintErrors(findings)).toBe(false);
  });

  it("手書きの docs/*.md に規範文があれば違反(仕様の置き場が割れるため)", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "spec.md"), "# 仕様\n\n注文は必ず顧客を持たなければならない。\n");
    const findings = lintFormal(dir);
    expect(findings[0].rule).toBe("doc-normative");
    expect(findings[0].file).toBe("docs/spec.md");
    expect(hasLintErrors(findings)).toBe(true);
  });

  it("生成物(docs/generated/)と ADR は規範文の検査から外す", () => {
    mkdirSync(join(dir, "docs", "generated"), { recursive: true });
    writeFileSync(join(dir, "docs", "generated", "spec.md"), "注文は必ず顧客を持たなければならない。\n");
    writeFileSync(
      join(adrDir(dir), "0001-x.md"),
      "# ADR-0001: x\n\nStatus: accepted\nDate: 2026-01-01\nRefs: R-01\n\n## 前提\n\n「必ず顧客を持たなければならない」という引用。\n",
    );
    expect(rules(dir)).not.toContain("doc-normative");
  });

  it("リバースドキュメントの規範文は警告にとどめる(単一情報源はコードのため)", () => {
    mkdirSync(join(dir, "docs", "architecture"), { recursive: true });
    writeFileSync(join(dir, "docs", "architecture", "overview.md"), "この層を経由すること。\n");
    const findings = lintFormal(dir);
    expect(findings.map((f) => f.rule)).toContain("doc-normative");
    expect(hasLintErrors(findings)).toBe(false);
  });

  it(".als の doc comment に履歴(過去形)が混ざっていれば警告する", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      "module order\n\n/**\n * 旧仕様では顧客を任意にしていた。\n */\nsig Order {}\n",
    );
    const findings = lintFormal(dir);
    expect(findings.map((f) => f.rule)).toContain("spec-history");
    expect(hasLintErrors(findings)).toBe(false);
  });

  it("未知のタグは書き間違いとして警告する", () => {
    writeFileSync(
      join(specDir(dir), "order.als"),
      "module order\n\n/**\n * @reqs R-01  書き間違い\n */\nsig Order {}\n",
    );
    expect(rules(dir)).toContain("unknown-tag");
  });

  it("docs/generated/ が .gitignore になければ警告する", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    const findings = lintFormal(dir);
    expect(findings.map((f) => f.rule)).toContain("generated-ignored");
    expect(hasLintErrors(findings)).toBe(false);
  });
});
