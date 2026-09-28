import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSpecChecks,
  checksPath,
  decisionsPath,
  formalDir,
  legacySpecLeftovers,
  migrateLegacySpecs,
  isSatisfied,
  loadSpecChecks,
  loadSpecDecisions,
  loadSpecModels,
  loadSpecState,
  parseAlloyOutput,
  parseDocComment,
  parseSpecModel,
  rootModel,
  specDir,
  specSigs,
  specUseCases,
  specGateStatus,
  tagValue,
  tagValues,
  unconfirmedDecisions,
  verifySpecs,
} from "./alloy.js";

const MODEL = `/**
 * 注文の状態と出荷の関係。
 * @module order
 * @scope  注文と出荷。
 */
module order

/**
 * 顧客。
 * @term 顧客 / Customer
 */
sig Customer {}

/**
 * 注文。顧客なしでは存在できない。
 * @term 注文 / Order
 * @rationale 下書きを別 sig にすると状態遷移が二重化する。
 */
sig Order {
  /** @term 注文者 / Customer */
  customer: one Customer
}

/**
 * @req R-01  すべての注文はちょうど 1 人の顧客に属する
 */
assert NoOrphanOrder { all o: Order | one o.customer }

/**
 * @req R-01
 * @validation 注文データの整合性に対する機械的証拠
 */
check NoOrphanOrder for 5

/**
 * @req R-02  注文が 1 件も存在しない仕様にはしない
 */
pred Consistent { some Order }

/**
 * @req R-02
 */
run Consistent for 5 but 3 Customer
`;

describe("parseDocComment", () => {
  it("散文とタグに分け、折り返した値を連結する", () => {
    const doc = parseDocComment([
      " * 主体。人間とサービスアカウントを区別しない。",
      " *",
      " * @term 主体 / Principal",
      " * @rationale サービスアカウント固有の制約がなく、",
      " *   分離すると権限判定が二重化するため。",
    ]);
    expect(doc.prose[0]).toBe("主体。人間とサービスアカウントを区別しない。");
    expect(tagValue(doc, "term")).toBe("主体 / Principal");
    expect(tagValue(doc, "rationale")).toBe(
      "サービスアカウント固有の制約がなく、 分離すると権限判定が二重化するため。",
    );
  });

  it("同じタグが複数回書かれてもすべて拾う", () => {
    const doc = parseDocComment([" * @out-of-scope 認証", " * @out-of-scope 監査ログ"]);
    expect(tagValues(doc, "out-of-scope")).toEqual(["認証", "監査ログ"]);
  });
});

describe("parseSpecModel", () => {
  const model = parseSpecModel("order.als", MODEL);

  it("module 名と module の doc comment を抽出する", () => {
    expect(model.module).toBe("order");
    expect(tagValue(model.doc, "scope")).toBe("注文と出荷。");
  });

  it("doc comment を直後の宣言に対応付ける", () => {
    const order = model.declarations.find((d) => d.kind === "sig" && d.name === "Order")!;
    expect(order.doc?.prose[0]).toBe("注文。顧客なしでは存在できない。");
    expect(tagValue(order.doc, "term")).toBe("注文 / Order");
    expect(order.code).toContain("customer: one Customer");
  });

  it("@req から要件を集め、文は最初に書かれたものを採る", () => {
    expect(model.requirements.map((r) => [r.id, r.text])).toEqual([
      ["R-01", "すべての注文はちょうど 1 人の顧客に属する"],
      ["R-02", "注文が 1 件も存在しない仕様にはしない"],
    ]);
    // 同じ名前の assert と check は 1 つの宣言として数える
    expect(model.requirements[0].declarations).toEqual(["NoOrphanOrder"]);
    expect(model.requirements[1].declarations).toEqual(["Consistent"]);
  });

  it("check / run コマンドを、その doc comment の @req に紐付けて抽出する", () => {
    expect(model.commands).toEqual([
      {
        kind: "check",
        name: "NoOrphanOrder",
        scope: "for 5",
        requirements: ["R-01"],
        validation: "注文データの整合性に対する機械的証拠",
        line: expect.any(Number),
      },
      {
        kind: "run",
        name: "Consistent",
        scope: "for 5 but 3 Customer",
        requirements: ["R-02"],
        line: expect.any(Number),
      },
    ]);
  });

  it("行コメント(--)は注釈として読まない(doc comment だけが仕様の情報源)", () => {
    const model = parseSpecModel("x.als", "-- REQ-01: 旧書式のコメント\nsig A {}\n");
    expect(model.requirements).toEqual([]);
    expect(model.declarations.map((d) => d.name)).toEqual(["A"]);
  });

  it("module 宣言がなければファイル名を使う", () => {
    expect(parseSpecModel("auth.als", "sig User {}").module).toBe("auth");
  });
});

describe("parseAlloyOutput", () => {
  it("Alloy 6 の表形式から SAT / UNSAT を要件の充足に読み替える", () => {
    // 実際の `java -jar alloy.jar exec` の出力(check の UNSAT = 反例なし)
    const output = `00. check CancelledIsNeverShipped     0       UNSAT
01. run   Consistent               0    1/1     SAT
02. check AllCancelled             0    1/1     SAT
03. run   Impossible               0       UNSAT`;
    expect(parseAlloyOutput(output).map((r) => ({ command: r.command, kind: r.kind, result: r.result }))).toEqual([
      { command: "CancelledIsNeverShipped", kind: "check", result: "pass" },
      { command: "Consistent", kind: "run", result: "instance" },
      { command: "AllCancelled", kind: "check", result: "counterexample" },
      { command: "Impossible", kind: "run", result: "no-instance" },
    ]);
  });

  it("旧来の文章形式の出力も解釈する", () => {
    const output = `
Executing "Check NoOrphanOrder for 5"
   No counterexample found. Assertion may be valid. 12ms.

Executing "Run Consistent for 5"
   Instance found. Predicate is consistent. 8ms.
`;
    expect(parseAlloyOutput(output).map((r) => [r.command, r.result])).toEqual([
      ["NoOrphanOrder", "pass"],
      ["Consistent", "instance"],
    ]);
  });

  it("結論行が出ないコマンドは unknown として残す", () => {
    const results = parseAlloyOutput('Executing "Check A for 5"\nExecuting "Check B for 5"\n   No counterexample found.');
    expect(results.map((r) => [r.command, r.result])).toEqual([
      ["A", "unknown"],
      ["B", "pass"],
    ]);
  });

  it("構文エラーはスタックトレースで繰り返されても 1 件だけ error として記録する", () => {
    const output = `[main] ERROR alloy - excuting sub command CLI:exec error Syntax error in /tmp/bad.als at line 3 column 1:
Syntax error in /tmp/bad.als at line 3 column 1:
\tat edu.mit.csail.sdg.parser.CompParser.syntax_error(CompParser.java:2633)`;
    const results = parseAlloyOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("error");
    expect(results[0].detail).toContain("Syntax error");
  });

  it("充足の判定は check の反例なしと run のインスタンスあり", () => {
    expect(isSatisfied("pass")).toBe(true);
    expect(isSatisfied("instance")).toBe(true);
    expect(isSatisfied("counterexample")).toBe(false);
    expect(isSatisfied("no-instance")).toBe(false);
    expect(isSatisfied("error")).toBe(false);
  });
});

describe("形式仕様ファイルの読み書き", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "atf-alloy-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("spec/*.als を読み込む(ディレクトリがなければ空)", () => {
    expect(loadSpecModels(repoDir)).toEqual([]);
    mkdirSync(specDir(repoDir), { recursive: true });
    writeFileSync(join(specDir(repoDir), "order.als"), MODEL);
    writeFileSync(join(specDir(repoDir), "README.md"), "# not a model");

    const models = loadSpecModels(repoDir);
    expect(models).toHaveLength(1);
    expect(models[0].file).toBe("order.als");
  });

  it("ルートモジュールは main.als(なければ undefined)", () => {
    mkdirSync(specDir(repoDir), { recursive: true });
    writeFileSync(join(specDir(repoDir), "order.als"), MODEL);
    expect(rootModel(loadSpecModels(repoDir))).toBeUndefined();
    writeFileSync(
      join(specDir(repoDir), "main.als"),
      "/**\n * @title 注文システム\n */\nmodule main\n",
    );
    expect(tagValue(rootModel(loadSpecModels(repoDir))?.doc, "title")).toBe("注文システム");
  });

  it("検証記録を追記し、壊れた行を無視して読み込む", () => {
    expect(loadSpecChecks(repoDir)).toEqual([]);
    appendSpecChecks(repoDir, [
      { model: "order.als", command: "NoOrphanOrder", result: "pass", checkedAt: "2026-01-01T00:00:00Z" },
    ]);
    appendSpecChecks(repoDir, [{ model: "order.als", command: "Consistent", result: "instance" }]);
    writeFileSync(checksPath(repoDir), readFileSync(checksPath(repoDir), "utf8") + "{壊れた行}\n");

    expect(loadSpecChecks(repoDir).map((c) => c.command)).toEqual(["NoOrphanOrder", "Consistent"]);
  });

  it("モデルが 1 件もなければ検証は未充足として扱う(Alloy は起動しない)", () => {
    const report = verifySpecs(repoDir, { jar: "/nonexistent/alloy.jar" });
    expect(report.results).toEqual([]);
    expect(report.satisfied).toBe(false);
  });
});

describe("specGateStatus", () => {
  const models = [parseSpecModel("order.als", MODEL)];

  it("検証記録がなければ未検証(pending)", () => {
    expect(specGateStatus(models, [])).toEqual({
      satisfied: 0,
      unsatisfied: 0,
      unchecked: 2,
      state: "pending",
    });
  });

  it("最新の記録で判定し、未充足があれば fail にする", () => {
    const checks = [
      { model: "order.als", command: "NoOrphanOrder", result: "counterexample" as const },
      { model: "order.als", command: "NoOrphanOrder", result: "pass" as const },
      { model: "order.als", command: "Consistent", result: "no-instance" as const },
    ];
    expect(specGateStatus(models, checks)).toMatchObject({
      satisfied: 1,
      unsatisfied: 1,
      unchecked: 0,
      state: "fail",
    });
  });

  it("すべて充足していれば pass", () => {
    const checks = [
      { model: "order.als", command: "NoOrphanOrder", result: "pass" as const },
      { model: "order.als", command: "Consistent", result: "instance" as const },
    ];
    expect(specGateStatus(models, checks).state).toBe("pass");
  });
});

describe("decisions.jsonl(反例から確定した仕様)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-decisions-"));
    mkdirSync(specDir(dir), { recursive: true });
    mkdirSync(formalDir(dir), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("記録がなければ空", () => {
    expect(loadSpecDecisions(dir)).toEqual([]);
  });

  it("壊れた行・必須項目が欠けた行を落として読む", () => {
    writeFileSync(
      decisionsPath(dir),
      [
        JSON.stringify({
          requirement: "REQ-02",
          finding: "反例が出た",
          decision: "出荷済みはキャンセルできない",
          rationale: "整合性が崩れる案しかない",
          status: "auto",
        }),
        "{壊れた行",
        JSON.stringify({ finding: "要件 ID も決定もない" }),
        JSON.stringify({
          requirement: "REQ-03",
          finding: "充足不能",
          decision: "上限を 10 にする",
          rationale: "設計書 4.1 から一意に決まる",
          status: "confirmed",
        }),
        "",
      ].join("\n"),
    );
    const decisions = loadSpecDecisions(dir);
    expect(decisions.map((d) => d.requirement)).toEqual(["REQ-02", "REQ-03"]);
  });

  it("status が auto(未記載を含む)のものだけを未確認として返す", () => {
    const decisions = [
      { requirement: "REQ-01", finding: "f", decision: "d", rationale: "r" },
      { requirement: "REQ-02", finding: "f", decision: "d", rationale: "r", status: "auto" as const },
      { requirement: "REQ-03", finding: "f", decision: "d", rationale: "r", status: "confirmed" as const },
    ];
    expect(unconfirmedDecisions(decisions).map((d) => d.requirement)).toEqual(["REQ-01", "REQ-02"]);
  });

  it("loadSpecState はモデル・検証記録・判断の記録をまとめて返す", () => {
    writeFileSync(join(specDir(dir), "order.als"), MODEL);
    appendSpecChecks(dir, [{ model: "order.als", command: "NoOrphanOrder", result: "pass" }]);
    const state = loadSpecState(dir);
    expect(state.models).toHaveLength(1);
    expect(state.checks).toHaveLength(1);
    expect(state.decisions).toEqual([]);
  });
});

describe("specSigs", () => {
  const SIGS = `module order

abstract sig State {}
one sig Pending, Shipped, Cancelled extends State {}
sig Customer {}

/**
 * 注文。
 * @term 注文 / Order
 */
sig Order {
  customer: one Customer,
  state: one State,
  items: set Item
}

sig Shipment { of: one Order }
sig Audit in Order {}

fact F { all o: Order | one o.customer }
pred P { some Order }
`;
  const sigs = specSigs(parseSpecModel("order.als", SIGS));
  const byName = (name: string) => sigs.find((s) => s.name === name)!;

  it("abstract / 多重度 / 継承を読み、まとめ書きの sig を展開する", () => {
    expect(byName("State").abstract).toBe(true);
    expect(byName("Pending")).toMatchObject({
      multiplicity: "one",
      parent: "State",
      parentKind: "extends",
    });
    expect(sigs.map((s) => s.name)).toContain("Cancelled");
    expect(byName("Audit")).toMatchObject({ parent: "Order", parentKind: "in" });
  });

  it("複数行の sig からフィールド(関係)を取り出す", () => {
    expect(byName("Order").fields).toEqual([
      { name: "customer", multiplicity: "one", target: "Customer", expression: "one Customer" },
      { name: "state", multiplicity: "one", target: "State", expression: "one State" },
      { name: "items", multiplicity: "set", target: "Item", expression: "set Item" },
    ]);
    expect(byName("Shipment").fields).toEqual([
      { name: "of", multiplicity: "one", target: "Order", expression: "one Order" },
    ]);
  });

  it("sig の doc comment を持ち回る(用語集の入力になる)", () => {
    expect(tagValue(byName("Order").doc, "term")).toBe("注文 / Order");
    expect(byName("Customer").doc).toBeUndefined();
  });

  it("fact / pred の本体は sig として拾わない", () => {
    expect(sigs.map((s) => s.name)).toEqual([
      "State",
      "Pending",
      "Shipped",
      "Cancelled",
      "Customer",
      "Order",
      "Shipment",
      "Audit",
    ]);
  });

  it("まとめ書きのフィールド(a, b: one C)を展開する", () => {
    const sigs = specSigs(parseSpecModel("a.als", "sig A { x, y: one B, z: lone C }\n"));
    expect(sigs[0].fields.map((f) => `${f.name}:${f.target}`)).toEqual(["x:B", "y:B", "z:C"]);
  });

  it("フィールドの直上の doc comment を拾う(@term が用語集に載る)", () => {
    const sigs = specSigs(
      parseSpecModel("a.als", "sig A {\n  /** @term 所有者 / Owner */\n  owner: one B\n}\n"),
    );
    expect(tagValue(sigs[0].fields[0].doc, "term")).toBe("所有者 / Owner");
  });
});

describe("specUseCases", () => {
  const USE_CASES = `module order

/**
 * @actor 顧客 注文を出す人
 */
sig Customer {}

/**
 * @actor 倉庫担当
 */
sig Warehouse {}

/**
 * @req R-01  注文は 1 人の顧客に属する
 * @usecase 顧客 注文を確定する
 */
assert NoOrphanOrder { all o: Order | one o.customer }

/**
 * @usecase 倉庫担当 出荷を登録する
 * @usecase 配送業者 配達を完了する
 */
pred Ship { some Order }
`;

  it("@actor を定義順に集め、説明と書いてある宣言を持つ", () => {
    const { actors } = specUseCases(parseSpecModel("order.als", USE_CASES));
    expect(actors.slice(0, 2)).toEqual([
      { name: "顧客", description: "注文を出す人", declaration: "Customer" },
      { name: "倉庫担当", declaration: "Warehouse" },
    ]);
  });

  it("@usecase をアクター・ユースケース名・出典の宣言に分けて拾う", () => {
    const { useCases } = specUseCases(parseSpecModel("order.als", USE_CASES));
    expect(useCases).toEqual([
      {
        actor: "顧客",
        name: "注文を確定する",
        declaration: "NoOrphanOrder",
        kind: "assert",
        requirements: ["R-01"],
      },
      {
        actor: "倉庫担当",
        name: "出荷を登録する",
        declaration: "Ship",
        kind: "pred",
        requirements: [],
      },
      {
        actor: "配送業者",
        name: "配達を完了する",
        declaration: "Ship",
        kind: "pred",
        requirements: [],
      },
    ]);
  });

  it("@actor の定義がないアクターも捨てずに返す(図から消さない)", () => {
    const { actors } = specUseCases(parseSpecModel("order.als", USE_CASES));
    expect(actors.map((a) => a.name)).toEqual(["顧客", "倉庫担当", "配送業者"]);
    expect(actors.find((a) => a.name === "配送業者")).toEqual({ name: "配送業者" });
  });

  it("1 語だけの @usecase はアクター未設定のユースケースとして扱う", () => {
    const { actors, useCases } = specUseCases(
      parseSpecModel("a.als", "/**\n * @usecase 注文する\n */\npred P { some A }\n"),
    );
    expect(actors).toEqual([]);
    expect(useCases[0]).toMatchObject({ name: "注文する", declaration: "P" });
    expect(useCases[0].actor).toBeUndefined();
  });

  it("タグがなければ空を返す", () => {
    expect(specUseCases(parseSpecModel("a.als", "sig A {}\n"))).toEqual({
      actors: [],
      useCases: [],
    });
  });
});

describe("migrateLegacySpecs", () => {
  let dir: string;
  const legacy = (repo: string) => join(repo, ".claude", "atf-specs");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atf-migrate-"));
    mkdirSync(legacy(dir), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("旧レイアウトのファイルを、いまの置き場へ移す", () => {
    writeFileSync(join(legacy(dir), "order.als"), MODEL);
    writeFileSync(join(legacy(dir), "run-alloy.sh"), "#!/bin/sh\n");
    writeFileSync(join(legacy(dir), "checks.jsonl"), "{}\n");
    writeFileSync(join(legacy(dir), "decisions.jsonl"), "{}\n");
    writeFileSync(join(legacy(dir), "explain-template.html"), "<html>");
    // 生成物と atf が配り直すものは捨てる
    writeFileSync(join(legacy(dir), "order.explain.html"), "<html>");
    writeFileSync(join(legacy(dir), "README.md"), "# 旧ガイド");

    const result = migrateLegacySpecs(dir);

    expect(existsSync(join(specDir(dir), "order.als"))).toBe(true);
    expect(existsSync(join(specDir(dir), "run-alloy.sh"))).toBe(true);
    expect(existsSync(join(formalDir(dir), "checks.jsonl"))).toBe(true);
    expect(existsSync(join(formalDir(dir), "decisions.jsonl"))).toBe(true);
    expect(existsSync(join(formalDir(dir), "explain-template.html"))).toBe(true);
    // 移し終わったら旧ディレクトリごと片付ける(情報源を 2 つ残さない)
    expect(legacySpecLeftovers(dir)).toEqual([]);
    expect(result.moved.length).toBe(5);
  });

  it("atf が知らないファイルは消さず、旧ディレクトリも残す", () => {
    writeFileSync(join(legacy(dir), "traceability.md"), "# エージェントが書いた表");

    const result = migrateLegacySpecs(dir);

    expect(result.remaining).toEqual(["traceability.md"]);
    expect(legacySpecLeftovers(dir)).toEqual(["traceability.md"]);
  });

  it("旧レイアウトがなければ何もしない", () => {
    rmSync(legacy(dir), { recursive: true });
    expect(migrateLegacySpecs(dir)).toEqual({ moved: [], remaining: [] });
  });
});
