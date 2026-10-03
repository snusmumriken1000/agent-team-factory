import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_DEVTOOLS_SERVER,
  UI_POINTING_SERVERS,
  UI_POINTING_SERVER_NAMES,
  mcpConfigPath,
  uiPointingReady,
  uiPointingStatus,
  writeUiPointingMcp,
} from "./mcp.js";

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "atf-mcp-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

const configFile = () => mcpConfigPath(repoDir);
const readConfig = () => JSON.parse(readFileSync(configFile(), "utf8"));

describe("writeUiPointingMcp", () => {
  it(".mcp.json が無ければ作り、chrome-devtools MCP を mcpServers に入れる", () => {
    const path = writeUiPointingMcp(repoDir);

    expect(path).toBe(configFile());
    expect(existsSync(path)).toBe(true);
    expect(readConfig().mcpServers).toEqual(UI_POINTING_SERVERS);
    // 未インストールの確認プロンプトで MCP の起動が止まらないよう npx -y で呼ぶ
    expect(readConfig().mcpServers[CHROME_DEVTOOLS_SERVER]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
    });
  });

  it("mcpServers の既存サーバーと、それ以外の既存設定を壊さない", () => {
    writeFileSync(
      configFile(),
      JSON.stringify({
        $schema: "https://example.com/mcp.json",
        mcpServers: { playwright: { type: "stdio", command: "npx", args: ["playwright-mcp"] } },
      }),
    );

    writeUiPointingMcp(repoDir);

    const config = readConfig();
    // ユーザーの設定はそのまま
    expect(config.$schema).toBe("https://example.com/mcp.json");
    expect(config.mcpServers.playwright).toEqual({
      type: "stdio",
      command: "npx",
      args: ["playwright-mcp"],
    });
    // 無いサーバーだけが足される
    expect(config.mcpServers[CHROME_DEVTOOLS_SERVER]).toEqual(
      UI_POINTING_SERVERS[CHROME_DEVTOOLS_SERVER],
    );
  });

  it("同じ名前のサーバーが既にあれば、起動方法を書き換えない", () => {
    writeFileSync(
      configFile(),
      JSON.stringify({
        mcpServers: {
          [CHROME_DEVTOOLS_SERVER]: { type: "stdio", command: "chrome-devtools-mcp", args: [] },
        },
      }),
    );

    writeUiPointingMcp(repoDir);

    expect(readConfig().mcpServers[CHROME_DEVTOOLS_SERVER]).toEqual({
      type: "stdio",
      command: "chrome-devtools-mcp",
      args: [],
    });
  });

  it("再実行しても内容が変わらない(増殖しない)", () => {
    writeUiPointingMcp(repoDir);
    const first = readFileSync(configFile(), "utf8");
    writeUiPointingMcp(repoDir);
    expect(readFileSync(configFile(), "utf8")).toBe(first);
  });

  it("壊れた JSON には追記せず、どこが悪いか分かるエラーにする", () => {
    writeFileSync(configFile(), "{ broken");

    expect(() => writeUiPointingMcp(repoDir)).toThrow(/JSON として読めません/);
    // 壊れたファイルはそのまま(勝手に上書きしない)
    expect(readFileSync(configFile(), "utf8")).toBe("{ broken");
  });

  it("mcpServers がオブジェクトでなければ、設定の不備として知らせる", () => {
    writeFileSync(configFile(), JSON.stringify({ mcpServers: [] }));

    expect(() => writeUiPointingMcp(repoDir)).toThrow(/mcpServers がオブジェクトではありません/);
  });
});

describe("uiPointingStatus / uiPointingReady", () => {
  it("配布前は必須のサーバーが missing になる", () => {
    const status = uiPointingStatus(repoDir);
    expect(status.exists).toBe(false);
    expect(status.missing).toEqual(UI_POINTING_SERVER_NAMES);
    expect(status.missing).toContain(CHROME_DEVTOOLS_SERVER);
    expect(status.command).toBeUndefined();
    expect(uiPointingReady(repoDir)).toBe(false);
  });

  it("配布後は missing が無くなり、起動コマンドを報告する", () => {
    writeUiPointingMcp(repoDir);

    const status = uiPointingStatus(repoDir);
    expect(status.missing).toEqual([]);
    expect(status.command).toBe("npx -y chrome-devtools-mcp@latest");
    expect(uiPointingReady(repoDir)).toBe(true);
  });

  it("起動方法を変えた設定も「揃っている」として尊重する", () => {
    writeFileSync(
      configFile(),
      JSON.stringify({
        mcpServers: {
          [CHROME_DEVTOOLS_SERVER]: {
            type: "stdio",
            command: "node",
            args: ["./vendor/chrome-devtools-mcp/index.js"],
          },
        },
      }),
    );

    const status = uiPointingStatus(repoDir);
    expect(status.missing).toEqual([]);
    expect(status.command).toBe("node ./vendor/chrome-devtools-mcp/index.js");
    expect(uiPointingReady(repoDir)).toBe(true);
  });

  it("壊れた JSON では点検を落とさず「無い」扱いにする", () => {
    writeFileSync(configFile(), "{ broken");

    expect(uiPointingStatus(repoDir).missing).toEqual(UI_POINTING_SERVER_NAMES);
  });
});
