import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFeatures } from "./apply.js";
import { removeFeatures, REMOVABLE_IDS } from "./remove.js";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import { loadTeamSettings } from "./settings.js";
import type { RepoProfile, Requirements, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-remove-"));
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
  generateTeam(preset(), profile(), {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    ...over,
  });
}

const agentPath = (file: string) => join(repoDir, ".claude", "agents", file);
const read = (file: string) => readFileSync(agentPath(file), "utf8");
const manifest = (): TeamManifest => loadTeamSettings(repoDir);

describe("removeFeatures", () => {
  it("requirements を無効にし、担当エージェント定義と実行スクリプトを取り除く", () => {
    team();
    applyFeatures(repoDir, ["arch"]);

    const result = removeFeatures(repoDir, ["arch"]);

    expect(manifest().requirements.archCheck).toBe(false);
    expect(result.removed[0]).toMatchObject({ id: "arch", wasEnabled: true, agentFile: "arch-guard.md" });
    expect(existsSync(agentPath("arch-guard.md"))).toBe(false);
    expect(manifest().agents.some((a) => a.file === "arch-guard.md")).toBe(false);
    expect(existsSync(join(repoDir, "atf-bin", "arch.sh"))).toBe(false);
    expect(result.binScripts).toContain("arch.sh");
  });

  it("残るエージェント定義から機能の指示だけを取り除く(手で書いた節は残す)", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    writeFileSync(agentPath("orchestrator.md"), read("orchestrator.md") + "\n## 手書きのメモ\n\n残ること\n");

    removeFeatures(repoDir, ["arch"]);

    const body = read("orchestrator.md");
    expect(body).not.toContain("## アーキテクチャ適合検証(実装後に必ず通す)");
    expect(body).not.toContain("## アーキテクチャ適合ゲート");
    expect(body).toContain("## 手書きのメモ");
    // 実行記録セクション(generator が必ず置く)は残る
    expect(body).toContain("## 実行記録");
  });

  it("成果物は既定で残し、--purge のときだけ削除する", () => {
    team();
    applyFeatures(repoDir, ["arch"]);
    const dir = join(repoDir, ".claude", "atf-arch");

    const kept = removeFeatures(repoDir, ["arch"]);
    expect(existsSync(dir)).toBe(true);
    expect(kept.removed[0].purged).toBe(false);
    expect(kept.removed[0].artifactsDirs).toEqual([dir]);

    applyFeatures(repoDir, ["arch"]);
    const purged = removeFeatures(repoDir, ["arch"], { purge: true });
    expect(existsSync(dir)).toBe(false);
    expect(purged.removed[0].purged).toBe(true);
  });

  it("形式仕様の --purge は 仕様・ADR・記録・生成物をまとめて消す", () => {
    team();
    applyFeatures(repoDir, ["formal"]);
    const dirs = [
      join(repoDir, "spec"),
      join(repoDir, "docs", "adr"),
      join(repoDir, ".claude", "atf-formal"),
      join(repoDir, "docs", "generated"),
    ];

    const kept = removeFeatures(repoDir, ["formal"]);
    expect(kept.removed[0].artifactsDirs).toEqual(dirs);
    for (const dir of dirs) expect(existsSync(dir)).toBe(true);

    applyFeatures(repoDir, ["formal"]);
    removeFeatures(repoDir, ["formal"], { purge: true });
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("機能に付随するスキル(archify)も撤去する", () => {
    team();
    applyFeatures(repoDir, ["docs"]);
    expect(existsSync(join(repoDir, ".claude", "skills", "archify", "SKILL.md"))).toBe(true);

    const result = removeFeatures(repoDir, ["docs"]);

    expect(result.removed[0].removedSkills).toContain("archify");
    expect(existsSync(join(repoDir, ".claude", "skills", "archify"))).toBe(false);
    expect(manifest().skills).toBeUndefined();
  });

  it("手編集されたスキルは残して報告する", () => {
    team();
    applyFeatures(repoDir, ["docs"]);
    const skill = join(repoDir, ".claude", "skills", "archify", "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8") + "\n手で足した指示\n");

    const result = removeFeatures(repoDir, ["docs"]);

    expect(result.removed[0].keptSkills).toContain("archify");
    expect(existsSync(skill)).toBe(true);
  });

  it("構成図の辺を組み直す(撤去したエージェントへの辺が消える)", () => {
    team();
    applyFeatures(repoDir, ["arch", "docs"]);

    removeFeatures(repoDir, ["arch"]);

    const flow = manifest().flow.map((e) => e.join(" → "));
    expect(flow.some((edge) => edge.includes("arch-guard"))).toBe(false);
    expect(flow.some((edge) => edge.includes("doc-reverser"))).toBe(true);
  });

  it("もともと無効でも後片付けだけ行う", () => {
    team();

    const result = removeFeatures(repoDir, ["formal"]);

    expect(result.removed[0]).toMatchObject({ id: "formal", wasEnabled: false, agentFile: undefined });
    expect(manifest().requirements.formalSpec).toBe(false);
  });

  it("ルーブリック評価を撤去すると、evaluator と全エージェントの評価指示が消える", () => {
    team();
    applyFeatures(repoDir, ["eval"]);
    expect(read("code-reviewer.md")).toContain("## ルーブリック評価(成果物は評価を通す)");

    const result = removeFeatures(repoDir, ["eval"]);

    expect(manifest().requirements.rubricEval).toBe(false);
    expect(result.removed[0]).toMatchObject({ id: "eval", wasEnabled: true, agentFile: "evaluator.md" });
    expect(existsSync(agentPath("evaluator.md"))).toBe(false);
    expect(read("code-reviewer.md")).not.toContain("## ルーブリック評価(成果物は評価を通す)");
    expect(read("orchestrator.md")).not.toContain("## ルーブリック評価ゲート");
    expect(read("env-builder.md")).not.toContain("## ルーブリック評価の実行環境");
    expect(existsSync(join(repoDir, "atf-bin", "eval.sh"))).toBe(false);
    // 評価基準・評価記録はユーザーとエージェントの作業結果なので既定で残す
    expect(existsSync(join(repoDir, ".claude", "atf-eval", "rubric.json"))).toBe(true);
  });

  it("評価対象から外したエージェントも、撤去時にはまとめて掃除される", () => {
    team();
    applyFeatures(repoDir, ["eval"]);
    const settings = join(repoDir, "atf-settings.yaml");
    writeFileSync(
      settings,
      readFileSync(settings, "utf8").replace("code-reviewer: true", "code-reviewer: false"),
    );
    applyFeatures(repoDir, ["eval"]);

    removeFeatures(repoDir, ["eval"]);

    for (const file of ["code-reviewer.md", "test-engineer.md", "orchestrator.md"]) {
      expect(read(file)).not.toContain("ルーブリック評価");
    }
  });

  it("撤去できない機能 id は報告する(ダッシュボードは常に使えるため対象外)", () => {
    team();

    const result = removeFeatures(repoDir, ["report", "arch"]);

    expect(REMOVABLE_IDS).toEqual([
      "formal",
      "arch",
      "docs",
      "issue",
      "eval",
      "agent-log",
      "ui-pointing",
    ]);
    expect(result.unknown).toEqual(["report"]);
    expect(result.removed.map((r) => r.id)).toEqual(["arch"]);
  });
});

describe("removeFeatures(Issue 駆動)", () => {
  it("issue-manager と Issue の指示を取り除き、ドラフトは残す", () => {
    team({ githubRepo: "acme/app" });
    applyFeatures(repoDir, ["issue"]);
    const draft = join(repoDir, ".claude", "atf-issues", "draft-01-login.md");
    writeFileSync(draft, "# ログイン画面\n");

    const result = removeFeatures(repoDir, ["issue"]);

    expect(manifest().requirements.issueDriven).toBe(false);
    expect(result.removed[0]).toMatchObject({ id: "issue", wasEnabled: true, agentFile: "issue-manager.md" });
    expect(existsSync(agentPath("issue-manager.md"))).toBe(false);
    expect(read("code-reviewer.md")).not.toContain("## Issue 駆動開発");
    expect(read("orchestrator.md")).not.toContain("## Issue 駆動モードの運用");
    expect(read("env-builder.md")).not.toContain("## Issue 駆動の実行環境");
    // 構成図から issue-manager への辺が消える
    expect(manifest().flow.flat()).not.toContain("issue-manager");
    // ドラフトはユーザーとエージェントの作業結果なので既定では残す
    expect(existsSync(draft)).toBe(true);
  });

  it("--purge ならドラフトの置き場ごと削除する", () => {
    team();
    applyFeatures(repoDir, ["issue"]);

    removeFeatures(repoDir, ["issue"], { purge: true });

    expect(existsSync(join(repoDir, ".claude", "atf-issues"))).toBe(false);
  });

  it("実行スクリプトを持たないので、撤去してもスクリプトは増減しない", () => {
    team();
    applyFeatures(repoDir, ["issue"]);

    const result = removeFeatures(repoDir, ["issue"]);

    expect(result.binScripts).toEqual([]);
  });
});
