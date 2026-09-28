import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archReportJunitPath } from "./arch.js";
import { writeArchScaffold } from "./generator.js";
import { parseArchOutput } from "./arch.js";

/**
 * ArchUnit 系(テスト形式)のツールを 1 本で配線するための変換スクリプトの検証。
 * 生成された実物を node で動かし、出力が atf arch の共通形式として解釈できることまで確かめる。
 */
describe("report-junit.mjs(JUnit XML → ARCH 行)", () => {
  let repoDir: string;
  let script: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "atf-junit-"));
    writeArchScaffold(repoDir, "example", ["typescript"]);
    script = archReportJunitPath(repoDir);
  });

  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  const write = (name: string, xml: string) => {
    const path = join(repoDir, name);
    writeFileSync(path, xml);
    return path;
  };

  const run = (...files: string[]) => {
    const result = spawnSync("node", [script, ...files], { encoding: "utf8" });
    return { ...result, lines: result.stdout.trim().split("\n").filter(Boolean) };
  };

  it("Vitest / Jest の出力を規約ごとの ARCH 行にする", () => {
    const xml = write(
      "vitest.xml",
      `<testsuites><testsuite name="arch">
        <testcase classname="src/arch.test.ts" name="ARCH-01: domain must not depend on infra"/>
        <testcase classname="src/arch.test.ts" name="ARCH-02: app may only depend on domain &amp; infra">
          <failure message="src/app/service.ts -&gt; src/web/ui.ts が規約に違反しています">AssertionError</failure>
        </testcase>
      </testsuite></testsuites>`,
    );

    const { lines, status } = run(xml);
    expect(status).toBe(0);
    expect(lines[0]).toBe("ARCH ARCH-01 PASS");
    expect(lines[1]).toContain("ARCH ARCH-02 VIOLATION 1");
    // XML エンティティを戻して詳細に載せる(修正の手がかりになる)
    expect(lines[1]).toContain("src/app/service.ts -> src/web/ui.ts");
  });

  it("pytest の関数名(_ 区切り)からも規約 id を取れる", () => {
    const xml = write(
      "pytest.xml",
      `<testsuites><testsuite name="pytest">
        <testcase classname="tests.test_architecture" name="test_arch_03_no_cycles"/>
        <testcase classname="tests.test_architecture" name="test_arch_04_naming">
          <error message="No module named 'archunitpython'"/>
        </testcase>
      </testsuite></testsuites>`,
    );

    const { lines } = run(xml);
    expect(lines).toEqual([
      "ARCH ARCH-03 PASS",
      "ARCH ARCH-04 ERROR No module named 'archunitpython'",
    ]);
  });

  it("規約 id を含まないテストは無視する(他のテストと混ざってよい)", () => {
    const xml = write(
      "mixed.xml",
      `<testsuite name="all">
        <testcase classname="ArchitectureTest" name="ARCH-01: layering"/>
        <testcase classname="tests.test_architecture" name="test_creates_user"/>
        <testcase classname="UserServiceTest" name="registers a user"/>
      </testsuite>`,
    );

    // test_architecture / ArchitectureTest を規約と誤認しないこと
    expect(run(xml).lines).toEqual(["ARCH ARCH-01 PASS"]);
  });

  it("スキップは未検証としてエラー扱いにする(ゲートを通さない)", () => {
    const xml = write(
      "skipped.xml",
      `<testsuite><testcase classname="X" name="ARCH-05 layering"><skipped message="requires gradle"/></testcase></testsuite>`,
    );
    expect(run(xml).lines).toEqual(["ARCH ARCH-05 ERROR requires gradle"]);
  });

  it("同じ規約の複数テストをまとめ、違反件数を数える", () => {
    const xml = write(
      "multi.xml",
      `<testsuite>
        <testcase classname="X" name="ARCH-02: rule a"><failure message="違反 A"/></testcase>
        <testcase classname="X" name="ARCH-02: rule b"><failure message="違反 B"/></testcase>
        <testcase classname="X" name="ARCH-02: rule c"/>
      </testsuite>`,
    );
    expect(run(xml).lines).toEqual(["ARCH ARCH-02 VIOLATION 2 違反 A"]);
  });

  it("複数ファイル(言語ごとのランナー)の結果を 1 つにまとめる", () => {
    const ts = write("ts.xml", `<testsuite><testcase classname="X" name="ARCH-01: ts"/></testsuite>`);
    const py = write(
      "py.xml",
      `<testsuite><testcase classname="Y" name="test_arch_02_python"/></testsuite>`,
    );
    expect(run(ts, py).lines).toEqual(["ARCH ARCH-01 PASS", "ARCH ARCH-02 PASS"]);
  });

  it("出力は atf arch が解釈できる共通形式になっている", () => {
    const xml = write(
      "gradle.xml",
      `<testsuite name="ArchitectureTest">
        <testcase classname="com.example.ArchitectureTest" name="ARCH-01: ドメインはインフラに依存しない"/>
        <testcase classname="com.example.ArchitectureTest" name="ARCH-02: 循環依存の禁止">
          <failure type="java.lang.AssertionError">Architecture Violation: 3 件</failure>
        </testcase>
      </testsuite>`,
    );

    const records = parseArchOutput(run(xml).stdout);
    expect(records).toEqual([
      { rule: "ARCH-01", result: "pass" },
      { rule: "ARCH-02", result: "violation", violations: 1, detail: "Architecture Violation: 3 件" },
    ]);
  });

  it("規約 id を含むテストが 1 件もなければ、配線ミスとして終了コード 1 で知らせる", () => {
    const xml = write("none.xml", `<testsuite><testcase classname="X" name="plain"/></testsuite>`);
    const result = run(xml);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("規約 id を含むテストが見つかりません");
  });

  it("読めるファイルがなければ使い方を出して終了コード 2", () => {
    const result = run(join(repoDir, "no-such-file.xml"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("使い方");
  });
});
