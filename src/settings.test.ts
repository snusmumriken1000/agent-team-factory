import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  buildSettingsYaml,
  hasTeamSettings,
  legacyManifestPath,
  loadTeamSettings,
  migrateLegacyManifest,
  saveTeamSettings,
  SETTINGS_FILE,
  settingsPath,
  updateTeamSettings,
} from "./settings.js";
import type { TeamManifest } from "./types.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-settings-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const manifest = (): TeamManifest => ({
  generatedBy: "agent-team-factory",
  preset: "quality-review",
  presetName: "品質レビューチーム",
  project: "example",
  requirements: { phase: "active", focus: ["quality"], teamSize: "minimal", archCheck: true },
  agents: [{ file: "code-reviewer.md", name: "code-reviewer", description: "レビュー担当" }],
  flow: [["orchestrator", "code-reviewer"]],
});

const writeSettings = (content: string) => writeFileSync(settingsPath(repoDir), content);

const writeLegacy = (value: unknown) => {
  mkdirSync(join(repoDir, ".claude"), { recursive: true });
  writeFileSync(legacyManifestPath(repoDir), JSON.stringify(value, null, 2));
};

describe("saveTeamSettings / loadTeamSettings", () => {
  it("書き出した設定をそのまま読み戻せる", () => {
    const path = saveTeamSettings(repoDir, manifest());

    expect(path).toBe(join(repoDir, SETTINGS_FILE));
    expect(loadTeamSettings(repoDir)).toEqual(manifest());
  });

  it("導入されていなければ、やることを書いたエラーにする", () => {
    expect(hasTeamSettings(repoDir)).toBe(false);
    expect(() => loadTeamSettings(repoDir)).toThrow(/atf init/);
  });

  it("手編集で壊れていたら、どこが悪いのか分かるエラーにする", () => {
    writeSettings("project: example\n  preset: broken\n");

    expect(() => loadTeamSettings(repoDir)).toThrow(/YAML の構文エラー/);
  });

  it("必須の項目が欠けていたら、欠けている項目を挙げる", () => {
    writeSettings("version: 1\nproject: example\n");

    expect(() => loadTeamSettings(repoDir)).toThrow(/必須の項目がありません: preset, requirements, agents/);
  });

  it("省略できる項目は既定値で補う(手で削られても落とさない)", () => {
    writeSettings(
      "version: 1\nproject: example\npreset: quality-review\nrequirements:\n  phase: active\n  focus: []\n  teamSize: minimal\nagents: []\n",
    );

    const loaded = loadTeamSettings(repoDir);

    expect(loaded.presetName).toBe("quality-review");
    expect(loaded.generatedBy).toBe("agent-team-factory");
    expect(loaded.flow).toEqual([]);
    expect(loaded.skills).toBeUndefined();
  });
});

describe("buildSettingsYaml", () => {
  it("冒頭に「何のファイルで、どこを書き換えてよいか」を書く", () => {
    const yaml = buildSettingsYaml(manifest());

    expect(yaml).toContain("example のチーム設定");
    expect(yaml).toContain("単一情報源");
    expect(yaml).toContain("requirements: ヒアリングの結果");
    expect(yaml).toContain("agents / flow / skills: atf が書き出す実体の記録");
  });

  it("フロー(from → to)は 1 行 1 辺で読める形にする", () => {
    const yaml = buildSettingsYaml(manifest());

    expect(yaml).toContain("- [ orchestrator, code-reviewer ]");
  });

  it("version つきのマッピングとして読める", () => {
    expect(parse(buildSettingsYaml(manifest()))).toEqual({ version: 1, ...manifest() });
  });
});

describe("migrateLegacyManifest(旧 .claude/team.json)", () => {
  it("team.json しかなければ YAML に移行し、team.json を消す", () => {
    writeLegacy(manifest());

    expect(hasTeamSettings(repoDir)).toBe(true);
    const path = migrateLegacyManifest(repoDir);

    expect(path).toBe(settingsPath(repoDir));
    expect(existsSync(legacyManifestPath(repoDir))).toBe(false);
    expect(loadTeamSettings(repoDir)).toEqual(manifest());
  });

  it("読み込みでも自動で移行する", () => {
    writeLegacy(manifest());

    expect(loadTeamSettings(repoDir).project).toBe("example");
    expect(existsSync(legacyManifestPath(repoDir))).toBe(false);
  });

  it("両方あれば YAML を正とし、team.json は消すだけ(上書きしない)", () => {
    saveTeamSettings(repoDir, manifest());
    writeLegacy({ ...manifest(), project: "古い記録" });

    expect(loadTeamSettings(repoDir).project).toBe("example");
    expect(existsSync(legacyManifestPath(repoDir))).toBe(false);
  });

  it("移行するものがなければ何もしない", () => {
    expect(migrateLegacyManifest(repoDir)).toBeUndefined();
    expect(existsSync(settingsPath(repoDir))).toBe(false);
  });

  it("壊れた team.json は握りつぶさずエラーにする", () => {
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(legacyManifestPath(repoDir), "{ 壊れている");

    expect(() => migrateLegacyManifest(repoDir)).toThrow(/JSON の構文エラー/);
    // 解釈できないファイルは消さない(手で救えるように)
    expect(existsSync(legacyManifestPath(repoDir))).toBe(true);
  });
});

describe("saveTeamSettings(更新)", () => {
  it("上書きしても書式(先頭のコメント)は保たれる", () => {
    saveTeamSettings(repoDir, manifest());
    const updated = { ...manifest(), skills: [{ id: "archify", name: "archify", category: "diagram" as const }] };
    saveTeamSettings(repoDir, updated);

    const yaml = readFileSync(settingsPath(repoDir), "utf8");
    expect(yaml.startsWith(`# ${SETTINGS_FILE}`)).toBe(true);
    expect(loadTeamSettings(repoDir).skills?.[0].name).toBe("archify");
  });

  it("書き出しのときにも旧 team.json を消す", () => {
    writeLegacy(manifest());
    rmSync(settingsPath(repoDir), { force: true });

    saveTeamSettings(repoDir, manifest());

    expect(existsSync(legacyManifestPath(repoDir))).toBe(false);
  });
});

describe("updateTeamSettings", () => {
  it("手で書いたコメントと atf が知らない項目を残したまま、変わった値だけ書き換える", () => {
    saveTeamSettings(repoDir, manifest());
    writeSettings(
      readFileSync(settingsPath(repoDir), "utf8")
        .replace("  focus:", "  # 重視観点のメモ\n  focus:") + "\n# 申し送り\nmemo: チーム内の連絡\n",
    );

    const next = manifest();
    next.requirements.reverseDocs = true;
    next.agents.push({ file: "doc-reverser.md", name: "doc-reverser", description: "文書化担当" });
    updateTeamSettings(repoDir, next);

    const body = readFileSync(settingsPath(repoDir), "utf8");
    expect(body).toContain("# 重視観点のメモ");
    expect(body).toContain("# 申し送り");
    expect(body).toContain("memo: チーム内の連絡");
    expect(parse(body).requirements.reverseDocs).toBe(true);
    expect(parse(body).agents).toHaveLength(2);
  });

  it("設定から外れた項目は消す(デザインの解除など)", () => {
    const before = manifest();
    before.requirements.designSkills = ["minimalist-skill"];
    saveTeamSettings(repoDir, before);

    const after = manifest();
    delete after.requirements.designSkills;
    updateTeamSettings(repoDir, after);

    expect(parse(readFileSync(settingsPath(repoDir), "utf8")).requirements.designSkills).toBeUndefined();
  });

  it("内容が変わらなければファイルも変わらない", () => {
    saveTeamSettings(repoDir, manifest());
    const before = readFileSync(settingsPath(repoDir), "utf8");

    updateTeamSettings(repoDir, manifest());

    expect(readFileSync(settingsPath(repoDir), "utf8")).toBe(before);
  });

  it("ファイルがなければ新規作成し、壊れていれば作り直す", () => {
    expect(existsSync(settingsPath(repoDir))).toBe(false);
    updateTeamSettings(repoDir, manifest());
    expect(loadTeamSettings(repoDir)).toEqual(manifest());

    writeSettings("preset: [壊れた\n");
    updateTeamSettings(repoDir, manifest());
    expect(loadTeamSettings(repoDir)).toEqual(manifest());
  });
});
