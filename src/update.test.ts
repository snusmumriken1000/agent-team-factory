import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFeatures } from "./apply.js";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import { loadTeamSettings } from "./settings.js";
import { planUpdate, runUpdate, updateTargets } from "./update.js";
import type { RepoProfile, Requirements, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-update-"));
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

const preset = () => {
  const p = loadPresets().find((p) => p.id === "quality-review");
  if (!p) throw new Error("quality-review preset not found");
  return p;
};

/** 機能をひとつも有効にしていないチームを導入する */
function team(over: Partial<Requirements> = {}): void {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    ...over,
  };
  generateTeam(preset(), profile(), requirements);
}

const manifest = (): TeamManifest => loadTeamSettings(repoDir);
const agentPath = (file: string) => join(repoDir, ".claude", "agents", file);
const read = (path: string) => readFileSync(path, "utf8");

/** 計画を立てて、そのまま実行する(CLI の承認後と同じ流れ) */
function update(opts: { force?: boolean } = {}) {
  const plan = planUpdate(repoDir, opts);
  return { plan, result: runUpdate(repoDir, plan, opts) };
}

describe("updateTargets", () => {
  it("有効な機能とダッシュボードだけを対象にする(無効な機能は含めない)", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    const ids = updateTargets(manifest()).map((f) => f.id);
    expect(ids).toContain("arch");
    // ダッシュボードはチームがあれば常に使えるので対象
    expect(ids).toContain("report");
    expect(ids).not.toContain("formal");
    expect(ids).not.toContain("eval");
  });
});

describe("planUpdate", () => {
  it("導入直後は更新するものがない", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    const plan = planUpdate(repoDir);
    expect(plan.hasChanges).toBe(false);
    expect(plan.common).toEqual([]);
  });

  it("atf が内容を決める足場(書式ガイド・変換スクリプト)が古ければ更新対象になる", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    const readme = join(repoDir, ".claude", "atf-arch", "README.md");
    writeFileSync(readme, "# 古い書式ガイド\n");

    const plan = planUpdate(repoDir);
    const arch = plan.features.find((f) => f.id === "arch");
    expect(plan.hasChanges).toBe(true);
    expect(arch?.assets).toContainEqual(
      expect.objectContaining({ kind: "scaffold", status: "update" }),
    );
  });

  it("エージェント定義の atf セクションが古ければ更新対象になる", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    const path = agentPath("orchestrator.md");
    // 見出しはそのままに、本文だけを古い内容にする(atf が差し替える単位は見出し)
    writeFileSync(path, read(path).replace("違反を残したまま次の作業に進まない。", "古い指示。"));

    const plan = planUpdate(repoDir);
    const arch = plan.features.find((f) => f.id === "arch");
    expect(arch?.assets).toContainEqual(
      expect.objectContaining({ kind: "section", status: "update", label: expect.stringContaining("orchestrator.md") }),
    );
  });

  it("担当エージェント定義が欠けていれば作り直す対象になる", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    rmSync(agentPath("arch-guard.md"));

    const plan = planUpdate(repoDir);
    const arch = plan.features.find((f) => f.id === "arch");
    expect(arch?.assets).toContainEqual(expect.objectContaining({ kind: "agent", status: "create" }));
  });

  it("実行スクリプトが消えていれば共通アセットとして配り直す", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    rmSync(join(repoDir, "atf-bin", "arch.sh"));

    const plan = planUpdate(repoDir);
    expect(plan.common).toContainEqual(
      expect.objectContaining({ kind: "bin", label: expect.stringContaining("arch.sh") }),
    );
  });

  it("手編集されたスキルは据え置きにし、更新ありとは数えない", () => {
    team();
    applyFeatures(repoDir, ["docs"]);
    const skill = join(repoDir, ".claude", "skills", "archify", "SKILL.md");
    writeFileSync(skill, `${read(skill)}\n<!-- 手で足したメモ -->\n`);

    const plan = planUpdate(repoDir);
    const docs = plan.features.find((f) => f.id === "docs");
    expect(docs?.assets).toContainEqual(expect.objectContaining({ kind: "skill", status: "kept" }));
    expect(plan.hasChanges).toBe(false);
  });

  it("--force なら手編集されたスキルも入れ替え対象になる", () => {
    team();
    applyFeatures(repoDir, ["docs"]);
    const skill = join(repoDir, ".claude", "skills", "archify", "SKILL.md");
    writeFileSync(skill, "# 手で書き換えたスキル\n");

    const plan = planUpdate(repoDir, { force: true });
    const docs = plan.features.find((f) => f.id === "docs");
    expect(docs?.skillUpdates).toContain("archify");
    expect(plan.hasChanges).toBe(true);
  });
});

describe("runUpdate", () => {
  it("足場の書式ガイドを最新の内容に戻し、成果物には触れない", () => {
    team();
    applyFeatures(repoDir, ["arch", "eval"]);
    const readme = join(repoDir, ".claude", "atf-arch", "README.md");
    const original = read(readme);
    writeFileSync(readme, "# 古い書式ガイド\n");
    // ユーザーとエージェントが書くもの(規約・検証スクリプト・評価観点)は update の対象外
    const authored = [
      join(repoDir, ".claude", "atf-arch", "rules.json"),
      join(repoDir, ".claude", "atf-arch", "run-arch-check.sh"),
      join(repoDir, ".claude", "atf-eval", "rubric.json"),
    ].map((path) => {
      const body = `${read(path)}\n`; // 手を入れた状態にする(形式は保つ)
      writeFileSync(path, body);
      return [path, body] as const;
    });

    const { result } = update();

    expect(read(readme)).toBe(original);
    expect(result.managed.some((p) => p.endsWith("README.md"))).toBe(true);
    for (const [path, body] of authored) expect(read(path)).toBe(body);
  });

  it("解説ページのテンプレートは基本上書きで最新版に入れ替え、派生物も作り直す", () => {
    team({ formalSpec: true });
    applyFeatures(repoDir, ["formal"]);
    const template = join(repoDir, ".claude", "atf-formal", "explain-template.html");
    const bundled = read(template);
    // 手を入れた(あるいは古い)テンプレート。生成物にも旧形式が残っている状態を作る
    writeFileSync(template, "<h1>{{model}}</h1>\n{{blocks}}\n");
    // .als は手書きの成果物なので update が触れないことも同時に確かめる
    const model = join(repoDir, "spec", "main.als");
    const authored = `${read(model)}\n-- 手書きの追記\n`;
    writeFileSync(model, authored);

    const plan = planUpdate(repoDir);
    const formal = plan.features.find((f) => f.id === "formal");
    expect(formal?.assets).toContainEqual(
      expect.objectContaining({ kind: "scaffold", status: "update" }),
    );

    const { result } = update();

    expect(read(template)).toBe(bundled);
    expect(result.managed.some((p) => p.endsWith("explain-template.html"))).toBe(true);
    expect(read(model)).toBe(authored);
    // テンプレートを入れ替えたら weave が走り、生成物が新しい形式にそろう
    const explained = read(join(repoDir, "docs", "generated", "main.explain.html"));
    expect(explained).toContain('id="tab-usecase"');
  });

  it("エージェント定義の指示を最新に戻し、手で書き足した節は残す", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    const path = agentPath("orchestrator.md");
    writeFileSync(
      path,
      read(path).replace("違反を残したまま次の作業に進まない。", "古い指示。") +
        "\n## 手書きのメモ\n\n残ること\n",
    );

    update();

    const body = read(path);
    expect(body).not.toContain("古い指示");
    expect(body.match(/## アーキテクチャ適合ゲート/g)?.length).toBe(1);
    expect(body).toContain("## 手書きのメモ");
  });

  it("欠けた担当エージェント定義と実行スクリプトを作り直す", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    rmSync(agentPath("arch-guard.md"));
    rmSync(join(repoDir, "atf-bin", "arch.sh"));

    update();

    expect(existsSync(agentPath("arch-guard.md"))).toBe(true);
    expect(existsSync(join(repoDir, "atf-bin", "arch.sh"))).toBe(true);
  });

  it("機能の有効/無効は変えない(導入・撤去はしない)", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    update();

    const requirements = manifest().requirements;
    expect(requirements.archCheck).toBe(true);
    expect(requirements.formalSpec).toBeFalsy();
    expect(requirements.rubricEval).toBeFalsy();
    // 無効な機能のエージェント・足場が増えていないこと
    expect(existsSync(agentPath("spec-formalizer.md"))).toBe(false);
    expect(existsSync(join(repoDir, "spec"))).toBe(false);
  });

  it("手編集されたスキルは残し、--force のときだけ入れ替える", () => {
    team();
    applyFeatures(repoDir, ["docs"]);
    const skill = join(repoDir, ".claude", "skills", "archify", "SKILL.md");
    writeFileSync(skill, "# 手で書き換えたスキル\n");

    update();
    expect(read(skill)).toBe("# 手で書き換えたスキル\n");

    const { result } = update({ force: true });
    expect(read(skill)).not.toBe("# 手で書き換えたスキル\n");
    expect(result.skills).toContain("archify");
  });

  it("実行しきると、もう更新するものがなくなる", () => {
    team();
    applyFeatures(repoDir, ["arch", "docs", "eval"]);
    writeFileSync(join(repoDir, ".claude", "atf-arch", "README.md"), "# 古い\n");
    rmSync(join(repoDir, "atf-bin", "docs.sh"));

    update();

    expect(planUpdate(repoDir).hasChanges).toBe(false);
  });
});
