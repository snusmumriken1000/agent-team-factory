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
    // teamSize: minimal (3) の枠を消費せず追加される(env-builder / orchestrator は全チーム共通)
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "issue-manager",
      "orchestrator",
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

describe("generateTeam (env-builder)", () => {
  const requirements: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
  };

  it("全チーム共通で env-builder を teamSize の枠外で追加する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.written).toContain("env-builder.md");
    const manifest: TeamManifest = JSON.parse(
      readFileSync(join(repoDir, ".claude", "team.json"), "utf8"),
    );
    expect(manifest.agents.map((a) => a.name)).toEqual([
      "code-reviewer",
      "test-engineer",
      "refactoring-advisor",
      "env-builder",
      "orchestrator",
    ]);

    const content = readFileSync(join(result.agentsDir, "env-builder.md"), "utf8");
    expect(content).toContain("ハーネス");
    expect(content).toContain("ガードレール");
    expect(content).toContain("フィードバックループ");
    // プレースホルダが置換され、実行記録の指示も付与される
    expect(content).toContain("example のエージェントチームの実行環境ビルダー");
    expect(content).toContain("## 実行記録");
  });
});

describe("generateTeam (orchestrator)", () => {
  const base: Requirements = {
    phase: "active",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: true,
    githubRepo: "octocat/hello-world",
    prFlow: true,
  };

  it("全チーム共通で orchestrator を teamSize の枠外で追加し、入口へのフローを描く", () => {
    const result = generateTeam(preset(), profileFor(repoDir), base);

    expect(result.written).toContain("orchestrator.md");
    const manifest: TeamManifest = JSON.parse(
      readFileSync(join(repoDir, ".claude", "team.json"), "utf8"),
    );
    // Issue 駆動なら orchestrator → issue-manager がタスクの入口になる
    expect(manifest.flow).toContainEqual(["orchestrator", "issue-manager"]);

    const content = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(content).toContain("example の開発オーケストレーター");
    expect(content).toContain("## 動作モード");
    // 既定は立ち上げ期向けのブートストラップモード、もう一方が Issue 駆動モード
    expect(content).toContain("既定はブートストラップモード");
    expect(content).toContain("### ブートストラップモード(既定)");
    expect(content).toContain("### Issue 駆動モード");
    expect(content).toContain("## 実行記録");
  });

  it("Issue 駆動でなければ orchestrator からチーム先頭エージェントへのフローを描く", () => {
    generateTeam(preset(), profileFor(repoDir), { ...base, issueDriven: false });

    const manifest: TeamManifest = JSON.parse(
      readFileSync(join(repoDir, ".claude", "team.json"), "utf8"),
    );
    expect(manifest.flow).toContainEqual(["orchestrator", "code-reviewer"]);
  });

  it("タッチポイントが設定されていれば一時停止して承認を仰ぐ指示を付与する", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      ...base,
      touchpoints: ["issue-approval", "pr-merge"],
    });

    const content = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(content).toContain("## タッチポイント(一時停止してユーザー承認を仰ぐ)");
    expect(content).toContain("必ずループを一時停止し、ユーザーの承認を得てから");
    expect(content).toContain("**Issue 承認**");
    expect(content).toContain("**PR マージ**");
    // タッチポイントの一時停止指示は orchestrator 専用(他エージェントには付与しない)
    const reviewer = readFileSync(join(result.agentsDir, "code-reviewer.md"), "utf8");
    expect(reviewer).not.toContain("## タッチポイント(一時停止してユーザー承認を仰ぐ)");
  });

  it("タッチポイントなしなら自動で進めてよい旨の指示になる", () => {
    const result = generateTeam(preset(), profileFor(repoDir), { ...base, touchpoints: [] });

    const content = readFileSync(join(result.agentsDir, "orchestrator.md"), "utf8");
    expect(content).toContain("タッチポイントは設定されていない");
    expect(content).not.toContain("**Issue 承認**");
    expect(content).not.toContain("**PR マージ**");
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

describe("generateTeam (新規開発のインセプションデッキ)", () => {
  const requirements: Requirements = {
    phase: "greenfield",
    focus: ["quality"],
    teamSize: "minimal",
    issueDriven: false,
    inception: {
      purpose: "手作業のチーム編成に時間がかかるため",
      targetUsers: "開発チームのリーダー",
      coreValue: "要件に合うエージェントチームを短時間で導入できる",
      mustHave: ["リポジトリ解析", "対話ヒアリング"],
      notList: ["実装タスクの自動着手"],
      successCriteria: "初回導入を10分以内に完了できる",
      risks: "要件の聞き漏らし",
      tradeoffPriority: "quality",
    },
  };

  it("回答内容を Markdown に書き出し、全エージェントに参照指示を付ける", () => {
    const result = generateTeam(preset(), profileFor(repoDir), requirements);

    expect(result.inceptionDeckPath).toBe(join(repoDir, ".claude", "inception-deck.md"));
    const deck = readFileSync(result.inceptionDeckPath!, "utf8");
    expect(deck).toContain("# example インセプションデッキ");
    expect(deck).toContain("- リポジトリ解析");
    expect(deck).toContain("- 実装タスクの自動着手");
    expect(deck).toContain("品質(品質を落とさない)");

    for (const file of result.written) {
      const content = readFileSync(join(result.agentsDir, file), "utf8");
      expect(content).toContain("## プロダクトの方向性(インセプションデッキ)");
      expect(content).toContain(".claude/inception-deck.md");
      expect(content).toContain("実装タスクの自動着手");
    }
  });

  it("既存プロジェクトではインセプションデッキを生成しない", () => {
    const result = generateTeam(preset(), profileFor(repoDir), {
      phase: "active",
      focus: ["quality"],
      teamSize: "minimal",
    });

    expect(result.inceptionDeckPath).toBeUndefined();
    expect(existsSync(join(repoDir, ".claude", "inception-deck.md"))).toBe(false);
  });
});
