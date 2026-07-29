import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTeam } from "./generator.js";
import { loadPresets } from "./presets.js";
import type { RepoProfile, Requirements, TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-test-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const profileFor = (path: string): RepoProfile => ({
  path,
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

describe("generateTeam (Issue 駆動)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
  };

  it("issue-manager を追加し、全エージェントに Issue 駆動の指示を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("issue-manager.md");
    const manifest: TeamManifest = JSON.parse(
      readFileSync(join(repoDir, ".claude", "team.json"), "utf8"),
    );
    // teamSize: minimal (3) の枠を消費せず 4 人目として追加される
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "issue-manager",
    ]);
    // issue-manager からチーム先頭エージェントへのフローが描かれる
    expect(manifest.flow).toContainEqual(["issue-manager", "code-reviewer"]);

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## Issue 駆動開発");
      expect(content).toContain("## 実行記録");
    }
  });

  it("githubRepo が指定されていれば Issue 駆動指示に起票先リポジトリを明記する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      githubRepo: "octocat/hello-world",
    });

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("使用するリポジトリ: octocat/hello-world");
      expect(content).toContain("-R octocat/hello-world");
    }
  });

  it("issueDriven でなければ issue-manager を追加しない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...requirements,
      issueDriven: false,
    });

    expect(result.written).not.toContain("issue-manager.md");
    expect(existsSync(join(result.agentsDir, "issue-manager.md"))).toBe(false);
    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).not.toContain("## Issue 駆動開発");
  });
});

describe("generateTeam (PR フロー・タッチポイント)", () => {
  const base: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
    githubRepo: "octocat/hello-world",
    prFlow: true,
  };

  it("prFlow が有効なら全エージェントに PR 作成の手順を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["pr-merge"],
    });

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## PR フロー(ブランチ・Pull Request)");
      expect(content).toContain("gh pr create -R octocat/hello-world");
      expect(content).toContain("Closes #123");
    }
  });

  it("タッチポイント pr-merge を選ぶとマージはユーザー担当になる(エージェントのマージ禁止)", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["pr-merge"],
    });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).toContain("マージはユーザーが行う(タッチポイント)");
    expect(content).toContain("実行してはならない");
    expect(content).not.toContain("gh pr merge -R");
  });

  it("pr-merge を選ばなければエージェントがマージまで実行する手順になる", () => {
    const result = generateTeam(preset(), profileFor(repoDir), { ...base, touchpoints: [] });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).toContain("マージはエージェントが行う");
    expect(content).toContain("gh pr merge -R octocat/hello-world --squash --delete-branch");
  });

  it("タッチポイント issue-approval を選ぶと Issue 承認後に着手する指示が付く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["issue-approval"],
    });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).toContain("ユーザーが内容を確認・承認してから着手する");
  });

  it("prFlow が無効なら PR フローの指示を付与しない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), { ...base, prFlow: false });

    const content = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(content).not.toContain("## PR フロー");
  });

  it("マニフェストの requirements に prFlow と touchpoints が記録される", () => {
    generateTeam(preset(), profileFor(repoDir), { ...base, touchpoints: ["pr-merge"] });

    const manifest: TeamManifest = JSON.parse(
      readFileSync(join(repoDir, ".claude", "team.json"), "utf8"),
    );
    expect(manifest.requirements.prFlow).toBe(true);
    expect(manifest.requirements.touchpoints).toEqual(["pr-merge"]);
  });
});
