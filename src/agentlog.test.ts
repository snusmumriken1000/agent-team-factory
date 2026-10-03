import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_LOG_ENDPOINT,
  AGENT_LOG_KEYS,
  agentLogEnv,
  agentLogReady,
  agentLogStatus,
  claudeSettingsPath,
  writeAgentLogSettings,
} from "./agentlog.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-agentlog-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const settingsFile = () => claudeSettingsPath(repoDir);
const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

describe("writeAgentLogSettings", () => {
  it("settings.json が無ければ作り、ログ転送の環境変数を env に入れる", () => {
    const path = writeAgentLogSettings(repoDir, "example");

    expect(path).toBe(settingsFile());
    expect(existsSync(path)).toBe(true);
    expect(readSettings().env).toEqual(agentLogEnv("example"));
    // 転送先は otel-desktop-viewer の既定の OTLP 受け口
    expect(readSettings().env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(AGENT_LOG_ENDPOINT);
    // Service 列でプロジェクトを見分けられるよう、プロジェクト名が入る
    expect(readSettings().env.OTEL_SERVICE_NAME).toBe("example");
  });

  it("env 以外の既存設定と、env の既存キーを壊さない", () => {
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        permissions: { allow: ["Bash(npm test)"] },
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317",
          OTEL_SERVICE_NAME: "my-name",
          MY_VAR: "keep",
        },
      }),
    );

    writeAgentLogSettings(repoDir, "example");

    const settings = readSettings();
    // ユーザーの設定はそのまま
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(settings.env.MY_VAR).toBe("keep");
    // 既にあるキーは値を変えない(別の転送先・別の Service 名を使っている設定を壊さない)
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://collector:4317");
    expect(settings.env.OTEL_SERVICE_NAME).toBe("my-name");
    // 無いキーだけが足される
    expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(settings.env.OTEL_LOGS_EXPORTER).toBe("otlp");
  });

  it("再実行しても内容が変わらない(増殖しない)", () => {
    writeAgentLogSettings(repoDir, "example");
    const first = readFileSync(settingsFile(), "utf8");
    writeAgentLogSettings(repoDir, "example");
    expect(readFileSync(settingsFile(), "utf8")).toBe(first);
  });

  it("壊れた JSON には追記せず、どこが悪いか分かるエラーにする", () => {
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), "{ broken");

    expect(() => writeAgentLogSettings(repoDir, "example")).toThrow(/JSON として読めません/);
    // 壊れたファイルはそのまま(勝手に上書きしない)
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ broken");
  });
});

describe("agentLogStatus / agentLogReady", () => {
  it("配布前は必須キー(OTEL_SERVICE_NAME を含む)がすべて missing になる", () => {
    const status = agentLogStatus(repoDir);
    expect(status.exists).toBe(false);
    expect(status.missing).toEqual(AGENT_LOG_KEYS);
    expect(status.missing).toContain("OTEL_SERVICE_NAME");
    expect(agentLogReady(repoDir)).toBe(false);
  });

  it("配布後は missing が無くなり、転送先と Service 名を報告する", () => {
    writeAgentLogSettings(repoDir, "example");
    const status = agentLogStatus(repoDir);
    expect(status.missing).toEqual([]);
    expect(status.endpoint).toBe(AGENT_LOG_ENDPOINT);
    expect(status.service).toBe("example");
    expect(agentLogReady(repoDir)).toBe(true);
  });

  it("OTEL_SERVICE_NAME が無い旧配布は missing として検出される(配り直しの合図)", () => {
    writeAgentLogSettings(repoDir, "example");
    const settings = readSettings();
    delete settings.env.OTEL_SERVICE_NAME;
    writeFileSync(settingsFile(), JSON.stringify(settings));

    const status = agentLogStatus(repoDir);
    expect(status.missing).toEqual(["OTEL_SERVICE_NAME"]);
    expect(agentLogReady(repoDir)).toBe(false);
  });

  it("転送先・Service 名を変えた設定も「揃っている」として尊重する", () => {
    writeAgentLogSettings(repoDir, "example");
    const settings = readSettings();
    settings.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4317";
    settings.env.OTEL_SERVICE_NAME = "renamed";
    writeFileSync(settingsFile(), JSON.stringify(settings));

    const status = agentLogStatus(repoDir);
    expect(status.missing).toEqual([]);
    expect(status.endpoint).toBe("http://collector:4317");
    expect(status.service).toBe("renamed");
  });

  it("壊れた JSON では点検を落とさず「無い」扱いにする", () => {
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), "{ broken");
    const status = agentLogStatus(repoDir);
    expect(status.missing).toEqual(AGENT_LOG_KEYS);
  });
});
