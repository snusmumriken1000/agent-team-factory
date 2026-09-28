import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills, loadSkillCatalog, resolveSkills, skillsDir, skillsRoot } from "./skills.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-skill-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

/** テスト用の小さなカタログを一時ディレクトリに作る */
function fakeCatalogRoot(
  entries: { id: string; name: string; category?: string; meta?: unknown; body?: string }[],
): string {
  const root = join(repoDir, "catalog");
  for (const e of entries) {
    const dir = join(root, e.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${e.name}\ndescription: ${e.id} の説明\n---\n\n${e.body ?? "本文"}\n`,
    );
    writeFileSync(
      join(dir, "skill.json"),
      JSON.stringify(e.meta ?? { category: e.category ?? "workflow" }),
    );
  }
  return root;
}

describe("loadSkillCatalog", () => {
  it("同梱スキルをロードでき、名前と説明は SKILL.md の frontmatter から取る", () => {
    const catalog = loadSkillCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const skill of catalog) {
      expect(skill.name).not.toBe("");
      expect(skill.description).not.toBe("");
      expect(skill.dir.startsWith(skillsRoot())).toBe(true);
    }
    // カタログ id とインストール名は一致しない(taste-skill → design-taste-frontend)
    const taste = catalog.find((s) => s.id === "taste-skill");
    expect(taste?.name).toBe("design-taste-frontend");
    expect(taste?.category).toBe("aesthetic");
    expect(taste?.recommended).toBe(true);
    expect(taste?.source?.repo).toBe("Leonxlnx/taste-skill");
  });

  it("見た目の方向性(aesthetic)は 1 つだけ推奨が付く(ヒアリングの初期値になるため)", () => {
    const recommended = loadSkillCatalog().filter(
      (s) => s.category === "aesthetic" && s.recommended,
    );
    expect(recommended).toHaveLength(1);
  });

  it("SKILL.md か skill.json が欠けたディレクトリ・壊れた skill.json は無視する", () => {
    const root = fakeCatalogRoot([{ id: "ok", name: "ok-skill" }]);
    mkdirSync(join(root, "no-meta"), { recursive: true });
    writeFileSync(join(root, "no-meta", "SKILL.md"), "---\nname: x\n---\n");
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "SKILL.md"), "---\nname: y\n---\n");
    writeFileSync(join(root, "broken", "skill.json"), "{ これは JSON ではない");

    expect(loadSkillCatalog(root).map((s) => s.id)).toEqual(["ok"]);
  });

  it("カタログが存在しなければ空配列を返す(壊さずに未導入として扱う)", () => {
    expect(loadSkillCatalog(join(repoDir, "missing"))).toEqual([]);
  });
});

describe("resolveSkills", () => {
  it("未知の id は捨てる(手入力・古い設定への耐性)", () => {
    const catalog = loadSkillCatalog(fakeCatalogRoot([{ id: "a", name: "a-skill" }]));
    expect(resolveSkills(["a", "存在しない"], catalog).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("installSkills", () => {
  it("frontmatter の name をディレクトリ名にして SKILL.md を配置する", () => {
    const catalog = loadSkillCatalog(
      fakeCatalogRoot([{ id: "taste", name: "design-taste-frontend", category: "aesthetic" }]),
    );
    const result = installSkills(repoDir, ["taste"], { catalog, projectName: "example" });

    const dest = join(skillsDir(repoDir), "design-taste-frontend", "SKILL.md");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("name: design-taste-frontend");
    expect(result.written).toEqual(["design-taste-frontend"]);
    expect(result.installed[0]).toMatchObject({ id: "taste", name: "design-taste-frontend" });
  });

  it("同梱スキルの内容を改変せずそのままコピーする", () => {
    installSkills(repoDir, ["taste-skill"], { projectName: "example" });
    const src = readFileSync(join(skillsRoot(), "taste-skill", "SKILL.md"), "utf8");
    const dest = readFileSync(
      join(skillsDir(repoDir), "design-taste-frontend", "SKILL.md"),
      "utf8",
    );
    expect(dest).toBe(src);
  });

  it("既存の SKILL.md は force なしでは上書きしない(手を入れた定義を尊重する)", () => {
    const catalog = loadSkillCatalog(fakeCatalogRoot([{ id: "a", name: "a-skill" }]));
    const dest = join(skillsDir(repoDir), "a-skill", "SKILL.md");
    mkdirSync(join(skillsDir(repoDir), "a-skill"), { recursive: true });
    writeFileSync(dest, "ユーザーが手で書いた定義");

    const kept = installSkills(repoDir, ["a"], { catalog });
    expect(readFileSync(dest, "utf8")).toBe("ユーザーが手で書いた定義");
    expect(kept.written).toEqual([]);
    // マニフェスト用の一覧には載る(導入済みとして扱う)
    expect(kept.installed).toHaveLength(1);

    installSkills(repoDir, ["a"], { catalog, force: true });
    expect(readFileSync(dest, "utf8")).toContain("name: a-skill");
  });

  it("出典とライセンスを README.md に残す(MIT の再配布条件)", () => {
    installSkills(repoDir, ["taste-skill", "redesign-skill"], { projectName: "example" });
    const readme = readFileSync(join(skillsDir(repoDir), "README.md"), "utf8");
    expect(readme).toContain("example のスキル");
    expect(readme).toContain("Leonxlnx/taste-skill");
    expect(readme).toContain("MIT");
    expect(readme).toContain("design-taste-frontend");
  });

  it("未知の id は unknown に入れ、有効な id だけを配置する", () => {
    const result = installSkills(repoDir, ["taste-skill", "存在しないスキル"], {});
    expect(result.unknown).toEqual(["存在しないスキル"]);
    expect(result.installed).toHaveLength(1);
  });

  it("有効なスキルが 1 つもなければディレクトリを作らない", () => {
    const result = installSkills(repoDir, ["存在しないスキル"], {});
    expect(existsSync(skillsDir(repoDir))).toBe(false);
    expect(result.installed).toEqual([]);
  });
});

describe("installSkills(追加インストール)", () => {
  it("README の一覧は配置先に実在するスキル全体から作る(既存分の出典表示を消さない)", () => {
    installSkills(repoDir, ["taste-skill"], { projectName: "example" });
    installSkills(repoDir, ["minimalist-skill"], { projectName: "example" });

    const readme = readFileSync(join(skillsDir(repoDir), "README.md"), "utf8");
    expect(readme).toContain("design-taste-frontend");
    expect(readme).toContain("minimalist-ui");
  });

  it("ユーザーが自分で置いたスキルも一覧から落とさない", () => {
    const own = join(skillsDir(repoDir), "my-own-skill");
    mkdirSync(own, { recursive: true });
    writeFileSync(own + "/SKILL.md", "---\nname: my-own-skill\ndescription: 自作\n---\n");

    installSkills(repoDir, ["taste-skill"], { projectName: "example" });
    expect(readFileSync(join(skillsDir(repoDir), "README.md"), "utf8")).toContain("my-own-skill");
  });
});

describe("installSkills(複数ファイルのスキル)", () => {
  it("パッケージごと同梱したスキルはディレクトリ全体を配る(skill.json は配らない)", () => {
    const root = join(repoDir, "catalog");
    const dir = join(root, "diagram-tool");
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: diagram-tool\ndescription: 図を作る\n---\n\n本文\n",
    );
    writeFileSync(join(dir, "bin", "cli.mjs"), "// entry");
    writeFileSync(join(dir, "schemas", "x.schema.json"), "{}");
    writeFileSync(join(dir, "LICENSE"), "MIT License");
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ category: "diagram" }));

    const catalog = loadSkillCatalog(root);
    const result = installSkills(repoDir, ["diagram-tool"], { catalog, projectName: "example" });

    const dest = join(skillsDir(repoDir), "diagram-tool");
    expect(result.written).toEqual(["diagram-tool"]);
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(dest, "bin", "cli.mjs"), "utf8")).toBe("// entry");
    expect(existsSync(join(dest, "schemas", "x.schema.json"))).toBe(true);
    expect(existsSync(join(dest, "LICENSE"))).toBe(true);
    // atf 側のメタ情報は配布しない
    expect(existsSync(join(dest, "skill.json"))).toBe(false);
  });

  it("同梱の archify は実行に必要な一式ごと配られ、出典が README に残る", () => {
    const result = installSkills(repoDir, ["archify"], { projectName: "example" });

    expect(result.installed[0]).toMatchObject({ id: "archify", category: "diagram" });
    const dest = join(skillsDir(repoDir), "archify");
    expect(existsSync(join(dest, "bin", "archify.mjs"))).toBe(true);
    expect(existsSync(join(dest, "LICENSE"))).toBe(true);

    const readme = readFileSync(join(skillsDir(repoDir), "README.md"), "utf8");
    expect(readme).toContain("tt-a1i/archify");
    expect(readme).toContain("MIT");
    // commit ではなく版で pin していることが分かる表示
    expect(readme).toContain("取り込んだ版");
    expect(readme).toContain("同梱時に除外したパス");
  });
});
