import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDesign,
  applyDesignSections,
  currentDesign,
  DESIGN_SECTION_HEADINGS,
  normalizeDesignIds,
  stripDesignSections,
} from "./design.js";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import { loadSkillCatalog } from "./skills.js";
import { loadTeamSettings } from "./settings.js";
import type { RepoProfile, Requirements, SkillDef, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-design-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const profile = (): RepoProfile => ({
  path: repoDir,
  name: "example",
  languages: ["typescript"],
  frameworks: [],
  hasCI: false,
  hasTests: false,
  fileCount: 1,
});

const requirements: Requirements = {
  phase: "active",
  focus: ["quality"],
  teamSize: "minimal",
};

const preset = () => {
  const p = loadPresets().find((p) => p.id === "quality-review");
  if (!p) throw new Error("quality-review preset not found");
  return p;
};

/** テスト用の小さなカタログ(本物のスキルは大きいので中身は最小にする) */
function fakeCatalog(): SkillDef[] {
  const root = join(repoDir, "catalog");
  const entries = [
    { id: "style-a", name: "design-style-a", category: "aesthetic" as const },
    { id: "style-b", name: "design-style-b", category: "aesthetic" as const },
    { id: "flow-a", name: "design-flow-a", category: "workflow" as const },
  ];
  return entries.map((e) => {
    const dir = join(root, e.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${e.name}\ndescription: ${e.id} の説明\n---\n\n本文\n`,
    );
    return {
      id: e.id,
      name: e.name,
      description: `${e.id} の説明`,
      category: e.category,
      recommended: false,
      dir,
    };
  });
}

const agentPath = (file: string) => join(repoDir, ".claude", "agents", file);
const skillPath = (name: string) => join(repoDir, ".claude", "skills", name, "SKILL.md");
const manifest = (): TeamManifest => loadTeamSettings(repoDir);

describe("applyDesign", () => {
  it("スキルを配置し、全エージェントにデザイン指示を付与してマニフェストに記録する", () => {
    generateTeam(preset(), profile(), requirements);
    const catalog = fakeCatalog();

    const result = applyDesign(repoDir, ["style-a", "flow-a"], { catalog });

    expect(result.skills.map((s) => s.name)).toEqual(["design-style-a", "design-flow-a"]);
    expect(existsSync(skillPath("design-style-a"))).toBe(true);
    expect(existsSync(skillPath("design-flow-a"))).toBe(true);

    // 全エージェントに共通のデザイン指示が入り、役割別の指示は該当エージェントだけに入る
    expect(result.agents).toContain("code-reviewer.md");
    for (const file of result.agents) {
      expect(readFileSync(agentPath(file), "utf8")).toContain("## デザインスキル(UI 実装時に使う)");
    }
    expect(readFileSync(agentPath("orchestrator.md"), "utf8")).toContain("## デザインスキルの配分");
    expect(readFileSync(agentPath("env-builder.md"), "utf8")).toContain(
      "## デザインスキルの実行環境",
    );
    expect(readFileSync(agentPath("code-reviewer.md"), "utf8")).not.toContain(
      "## デザインスキルの配分",
    );

    // 実行記録セクションは末尾に残す(init したときと同じ並び)
    const body = readFileSync(agentPath("code-reviewer.md"), "utf8");
    expect(body.indexOf("## デザインスキル(UI 実装時に使う)")).toBeLessThan(
      body.indexOf("## 実行記録"),
    );

    expect(manifest().skills?.map((s) => s.id)).toEqual(["style-a", "flow-a"]);
    expect(manifest().requirements.designSkills).toEqual(["style-a", "flow-a"]);
    expect(currentDesign(repoDir)).toEqual(["style-a", "flow-a"]);
    expect(existsSync(result.dashboardPath)).toBe(true);
  });

  it("再適用しても指示が増殖しない(冪等)", () => {
    generateTeam(preset(), profile(), requirements);
    const catalog = fakeCatalog();

    applyDesign(repoDir, ["style-a"], { catalog });
    const once = readFileSync(agentPath("orchestrator.md"), "utf8");
    const second = applyDesign(repoDir, ["style-a"], { catalog });

    expect(second.agents).toEqual([]); // 変更なし
    expect(readFileSync(agentPath("orchestrator.md"), "utf8")).toBe(once);
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
    expect(count(once, "## デザインスキル(UI 実装時に使う)")).toBe(1);
    expect(count(once, "## デザインスキルの配分")).toBe(1);
  });

  it("選択から外れたスキルは撤去し、指示も差し替える", () => {
    generateTeam(preset(), profile(), requirements);
    const catalog = fakeCatalog();
    applyDesign(repoDir, ["style-a", "flow-a"], { catalog });

    const result = applyDesign(repoDir, ["style-b"], { catalog });

    expect(result.removed.sort()).toEqual(["design-flow-a", "design-style-a"]);
    expect(existsSync(skillPath("design-style-a"))).toBe(false);
    expect(existsSync(skillPath("design-style-b"))).toBe(true);
    const body = readFileSync(agentPath("code-reviewer.md"), "utf8");
    expect(body).toContain("design-style-b");
    expect(body).not.toContain("design-style-a");
    expect(manifest().skills?.map((s) => s.id)).toEqual(["style-b"]);
    // 残ったスキルだけで README を作り直す
    expect(readFileSync(join(repoDir, ".claude", "skills", "README.md"), "utf8")).not.toContain(
      "design-style-a",
    );
  });

  it("手を入れた SKILL.md は撤去せず kept で返す(--force で撤去する)", () => {
    generateTeam(preset(), profile(), requirements);
    const catalog = fakeCatalog();
    applyDesign(repoDir, ["style-a"], { catalog });
    writeFileSync(skillPath("design-style-a"), "---\nname: design-style-a\ndescription: 手編集\n---\n");

    const kept = applyDesign(repoDir, ["style-b"], { catalog });
    expect(kept.kept).toEqual(["design-style-a"]);
    expect(existsSync(skillPath("design-style-a"))).toBe(true);
    // デザインからは外れる(見た目の方向性が二重にならない)
    expect(manifest().skills?.map((s) => s.id)).toEqual(["style-b"]);

    const forced = applyDesign(repoDir, ["style-b"], { catalog, force: true });
    expect(forced.kept).toEqual([]);
  });

  it("空の選択でデザインを解除し、指示とマニフェストから取り除く", () => {
    generateTeam(preset(), profile(), requirements);
    const catalog = fakeCatalog();
    applyDesign(repoDir, ["style-a"], { catalog });

    const result = applyDesign(repoDir, [], { catalog });

    expect(result.skills).toEqual([]);
    expect(result.removed).toEqual(["design-style-a"]);
    expect(existsSync(join(repoDir, ".claude", "skills"))).toBe(false);
    for (const file of ["code-reviewer.md", "orchestrator.md", "env-builder.md"]) {
      const body = readFileSync(agentPath(file), "utf8");
      expect(body).not.toContain("## デザインスキル");
      expect(body).toContain("## 実行記録"); // 他のセクションは壊さない
    }
    expect(manifest().skills).toBeUndefined();
    expect(manifest().requirements.designSkills).toBeUndefined();
  });

  it("ユーザーが書き足したセクションは残す", () => {
    generateTeam(preset(), profile(), requirements);
    const catalog = fakeCatalog();
    const path = agentPath("code-reviewer.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n## 社内ルール\n\n手で足した指示。\n");

    applyDesign(repoDir, ["style-a"], { catalog });
    applyDesign(repoDir, [], { catalog });

    expect(readFileSync(path, "utf8")).toContain("## 社内ルール");
    expect(readFileSync(path, "utf8")).toContain("手で足した指示。");
  });

  it("チームが導入されていなければエラーになる", () => {
    expect(() => applyDesign(repoDir, [], { catalog: fakeCatalog() })).toThrow(
      /チームが導入されていません/,
    );
  });

  it("同梱カタログのスキルも適用できる", () => {
    generateTeam(preset(), profile(), requirements);
    const result = applyDesign(repoDir, ["minimalist-skill"]);
    expect(result.skills.map((s) => s.id)).toEqual(["minimalist-skill"]);
    expect(existsSync(join(result.skillsDir, result.skills[0].name, "SKILL.md"))).toBe(true);
  });
});

describe("stripDesignSections / applyDesignSections", () => {
  it("管理対象の見出しは generator の指示文から導出される", () => {
    expect(DESIGN_SECTION_HEADINGS).toEqual([
      "## デザインスキル(UI 実装時に使う)",
      "## デザインスキルの配分",
      "## デザインスキルの実行環境",
    ]);
  });

  it("デザイン節だけを取り除く", () => {
    const body = "# agent\n\n## 役割\n\nレビューする。\n\n## デザインスキルの配分\n\n古い指示。\n\n## 実行記録\n\n記録する。\n";
    expect(stripDesignSections(body)).toBe(
      "# agent\n\n## 役割\n\nレビューする。\n\n## 実行記録\n\n記録する。\n",
    );
  });

  it("実行記録セクションがなければ末尾に追加する", () => {
    const out = applyDesignSections("# agent\n\n## 役割\n\nレビューする。\n", "\n\n## デザインスキルの配分\n\n新しい指示。\n");
    expect(out).toBe("# agent\n\n## 役割\n\nレビューする。\n\n## デザインスキルの配分\n\n新しい指示。\n");
  });
});

describe("normalizeDesignIds", () => {
  const catalog = () => loadSkillCatalog();

  it("重複を落とし、見た目の方向性は先頭の 1 つに絞る", () => {
    expect(
      normalizeDesignIds(
        ["minimalist-skill", "minimalist-skill", "brutalist-skill", "redesign-skill"],
        catalog(),
      ),
    ).toEqual(["minimalist-skill", "redesign-skill"]);
  });

  it("カタログにない id はそのまま通す(呼び出し側が未知として扱えるように)", () => {
    expect(normalizeDesignIds(["nope"], catalog())).toEqual(["nope"]);
  });
});

describe("applyDesign(デザイン以外のスキル)", () => {
  it("リバースドキュメント用の archify はデザインの変更で撤去しない", () => {
    // リバースドキュメントモードで生成すると archify が入る
    generateTeam(preset(), profile(), { ...requirements, reverseDocs: true });
    expect(existsSync(skillPath("archify"))).toBe(true);
    const catalog = fakeCatalog();

    const result = applyDesign(repoDir, ["style-a"], { catalog });

    // デザインスキルだけが入れ替わり、図のスキルはファイルもマニフェストも残る
    expect(result.removed).toEqual([]);
    expect(existsSync(skillPath("archify"))).toBe(true);
    expect(existsSync(skillPath("design-style-a"))).toBe(true);
    expect(manifest().skills?.map((s) => s.id).sort()).toEqual(["archify", "style-a"]);

    expect(manifest().requirements.designSkills).toEqual(["style-a"]);
    // デザインとしては style-a だけが適用されている
    expect(result.skills.map((s) => s.id)).toEqual(["style-a"]);
    // 「現在のデザイン」には図のスキルを含めない(選択対象ではない)
    expect(currentDesign(repoDir)).toEqual(["style-a"]);
  });

  it("デザインを解除しても archify はマニフェストに残る", () => {
    generateTeam(preset(), profile(), { ...requirements, reverseDocs: true });
    const catalog = fakeCatalog();
    applyDesign(repoDir, ["style-a"], { catalog });

    const result = applyDesign(repoDir, [], { catalog });

    expect(result.skills).toEqual([]);
    expect(existsSync(skillPath("archify"))).toBe(true);
    expect(manifest().skills?.map((s) => s.id)).toEqual(["archify"]);
    expect(manifest().requirements.designSkills).toBeUndefined();
    // デザイン節は取り除かれる
    expect(readFileSync(agentPath("code-reviewer.md"), "utf8")).not.toContain(
      "## デザインスキル(UI 実装時に使う)",
    );
    // リバースドキュメントの指示は init 時のまま残る(デザインとは別の仕組み)
    expect(readFileSync(agentPath("code-reviewer.md"), "utf8")).toContain(
      "## リバースドキュメント(コードが単一情報源)",
    );
  });
});
