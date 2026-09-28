import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archToolSummary,
  archToolsByLanguage,
  archToolsFor,
  formatArchTools,
  loadArchToolCatalog,
  recommendedArchTools,
} from "./archtools.js";

const catalog = loadArchToolCatalog();

describe("同梱カタログ(templates/arch-tools.json)", () => {
  it("ツールを読み込める", () => {
    expect(catalog.length).toBeGreaterThan(0);
    for (const tool of catalog) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.languages.length).toBeGreaterThan(0);
    }
  });

  it("id が重複しない", () => {
    const ids = catalog.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("推奨は言語ごとに 1 つだけ(ヒアリングも足場も迷わないように)", () => {
    for (const [language, tools] of archToolsByLanguage(catalog)) {
      const recommended = tools.filter((t) => t.recommended);
      expect(recommended.length, `${language} の推奨: ${recommended.map((t) => t.id).join(", ")}`)
        .toBeLessThanOrEqual(1);
    }
  });

  it("推奨ツールは配線に必要な情報(導入・実行・変換)を持つ", () => {
    for (const tool of catalog.filter((t) => t.recommended)) {
      expect(tool.install, tool.id).toBeTruthy();
      expect(tool.run, tool.id).toBeTruthy();
      expect(tool.report, tool.id).toBeTruthy();
    }
  });

  it("要望の 4 言語をカバーする", () => {
    const toolsOf = (language: string) => archToolsFor(catalog, [language]).map((t) => t.id);
    expect(toolsOf("java")).toContain("archunit");
    expect(toolsOf("kotlin")).toContain("archunit");
    expect(toolsOf("scala")).toContain("archunit");
    expect(toolsOf("typescript")).toContain("archunit-ts");
    expect(toolsOf("typescript")).toContain("ts-arch");
    // dependency-cruiser は置き換えではなく併記のまま残す
    expect(toolsOf("typescript")).toContain("dependency-cruiser");
    expect(toolsOf("python")).toContain("archunitpython");
    expect(toolsOf("go")).toContain("go-arch-lint");
  });
});

describe("archToolsFor", () => {
  it("推奨を先頭に並べる", () => {
    const tools = archToolsFor(catalog, ["typescript"]);
    expect(tools[0].id).toBe("archunit-ts");
  });

  it("複数言語のツールをまとめて返す(重複しない)", () => {
    const ids = archToolsFor(catalog, ["java", "kotlin"]).map((t) => t.id);
    expect(ids.filter((id) => id === "archunit")).toHaveLength(1);
    expect(ids).toContain("konsist");
  });

  it("言語が未検出なら空(呼び出し側が全件表示に切り替える)", () => {
    expect(archToolsFor(catalog, [])).toEqual([]);
  });

  it("知らない言語は空", () => {
    expect(archToolsFor(catalog, ["cobol"])).toEqual([]);
  });
});

describe("recommendedArchTools", () => {
  it("検出言語の推奨だけを返す", () => {
    expect(recommendedArchTools(catalog, ["python"]).map((t) => t.id)).toEqual(["archunitpython"]);
  });
});

describe("formatArchTools / archToolSummary", () => {
  it("同じツールの組み合わせになる言語をまとめる", () => {
    const groups = formatArchTools(catalog);
    const jvm = groups.find((g) => g.languages.includes("java"));
    expect(jvm?.languages).toEqual(["java", "scala"]); // kotlin は Konsist があるため別グループ
    expect(jvm?.tools).toEqual(["ArchUnit"]);
  });

  it("要約は表示名で組み立てる", () => {
    const summary = archToolSummary(catalog);
    expect(summary).toContain("Java/Scala: ArchUnit");
    expect(summary).toContain("ArchUnitTS");
    expect(summary).toContain("Python: ArchUnitPython");
  });
});

describe("loadArchToolCatalog", () => {
  it("ファイルがなければ空", () => {
    expect(loadArchToolCatalog(join(tmpdir(), "no-such-arch-tools.json"))).toEqual([]);
  });

  it("壊れていても落ちない", () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-archtools-"));
    const path = join(dir, "arch-tools.json");
    writeFileSync(path, "{ broken");
    expect(loadArchToolCatalog(path)).toEqual([]);
  });

  it("必須項目を欠いた項目は捨てる", () => {
    const dir = mkdtempSync(join(tmpdir(), "atf-archtools-"));
    const path = join(dir, "arch-tools.json");
    writeFileSync(
      path,
      JSON.stringify({
        tools: [{ id: "ok", name: "OK", languages: ["go"] }, { id: "no-languages", name: "NG" }],
      }),
    );
    expect(loadArchToolCatalog(path).map((t) => t.id)).toEqual(["ok"]);
  });
});
