import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * UI 指差し確認(`atf apply ui-pointing`)。
 *
 * エージェントがブラウザの実画面を見ながら UI を確かめられるように、
 * chrome-devtools MCP を対象プロジェクトの `.mcp.json`
 * (Claude Code のプロジェクトスコープ MCP 設定)に配る。
 * atf が配るのは**設定だけ**で、Chrome や MCP サーバーの導入・起動はしない
 * (otel-desktop-viewer を起動しない agentlog.ts と同じ切り分け)。
 *
 * `.mcp.json` はユーザーも書くファイルなので、扱いは writeIfAbsent 側:
 * 無いサーバーだけを足し、既にある定義は(atf の既定と違っても)上書きしない。
 * `atf update` の managed にも入れない。
 */

/** MCP サーバー 1 件の定義(`.mcp.json` の mcpServers の値) */
export interface McpServer {
  /** 起動方式。ローカルのコマンドを起動する stdio だけを配る */
  type: "stdio";
  command: string;
  args: string[];
}

/** chrome-devtools MCP のサーバー名(`.mcp.json` のキー) */
export const CHROME_DEVTOOLS_SERVER = "chrome-devtools";

/**
 * 配る MCP サーバー一式(サーバー名 → 定義)。
 * status の点検と ready 判定の単一情報源でもある。
 *
 * `npx -y` にするのは、未インストールのときの確認プロンプトで
 * MCP サーバーの起動が止まらないようにするため。
 */
export const UI_POINTING_SERVERS: Record<string, McpServer> = {
  [CHROME_DEVTOOLS_SERVER]: {
    type: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
  },
};

/** 配布するサーバー名(必須キー) */
export const UI_POINTING_SERVER_NAMES: string[] = Object.keys(UI_POINTING_SERVERS);

/** 配布先(Claude Code のプロジェクトスコープ MCP 設定。チームで共有するので commit する側) */
export function mcpConfigPath(repoPath: string): string {
  return join(repoPath, ".mcp.json");
}

/** `.mcp.json` を読む。無ければ空、壊れていればどこが悪いか分かるエラーにする */
function readMcpConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${path} を JSON として読めません(${(e as Error).message})。壊れた設定に追記すると Claude Code が MCP 設定全体を読めなくなるため、先に直してください。`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} のトップレベルがオブジェクトではありません。先に直してください。`);
  }
  return parsed as Record<string, unknown>;
}

/** mcpServers を取り出す(無ければ空。オブジェクト以外なら設定の不備としてエラー) */
function readServers(path: string, config: Record<string, unknown>): Record<string, unknown> {
  const servers = config.mcpServers;
  if (servers === undefined) return {};
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`${path} の mcpServers がオブジェクトではありません。先に直してください。`);
  }
  return servers as Record<string, unknown>;
}

/**
 * chrome-devtools MCP を `.mcp.json` にマージする(足場の用意)。
 *
 * - mcpServers に無いサーバーだけを足す。既にある名前はユーザーの選択なので変えない
 *   (別の起動方法・別のバージョンを指している設定を壊さない)
 * - mcpServers 以外の項目には触らない
 * - 変更が無ければ書き込まない(mtime を無駄に動かさない)
 *
 * 返り値は配布先のパス(apply の「成果物」表示に使う)。
 */
export function writeUiPointingMcp(repoPath: string): string {
  const path = mcpConfigPath(repoPath);
  const config = readMcpConfig(path);
  const servers = readServers(path, config);

  let changed = false;
  for (const [name, server] of Object.entries(UI_POINTING_SERVERS)) {
    if (servers[name] === undefined) {
      servers[name] = server;
      changed = true;
    }
  }
  if (changed || !existsSync(path)) {
    config.mcpServers = servers;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return path;
}

/** 配布した設定の実体(atf status と ready 判定の入力) */
export interface UiPointingStatus {
  /** 配布先のパス */
  path: string;
  /** `.mcp.json` が存在するか */
  exists: boolean;
  /** mcpServers に無い必須のサーバー名 */
  missing: string[];
  /** chrome-devtools の起動コマンド(設定されていなければ undefined) */
  command?: string;
}

/**
 * `.mcp.json` に chrome-devtools MCP が揃っているかを調べる。
 * 定義の中身までは合わせない(起動方法を変えた設定は「揃っている」として尊重する)。
 * 壊れた JSON は「無い」扱いにして、点検(atf status)を落とさない。
 */
export function uiPointingStatus(repoPath: string): UiPointingStatus {
  const path = mcpConfigPath(repoPath);
  const exists = existsSync(path);
  let servers: Record<string, unknown> = {};
  if (exists) {
    try {
      const config = readMcpConfig(path);
      servers = readServers(path, config);
    } catch {
      servers = {};
    }
  }
  const missing = UI_POINTING_SERVER_NAMES.filter((name) => servers[name] === undefined);
  const chrome = servers[CHROME_DEVTOOLS_SERVER];
  const command =
    chrome !== null && typeof chrome === "object" && !Array.isArray(chrome)
      ? describeCommand(chrome as Record<string, unknown>)
      : undefined;
  return { path, exists, missing, command };
}

/** 起動コマンドを 1 行で表す(status の詳細表示に使う) */
function describeCommand(server: Record<string, unknown>): string | undefined {
  if (typeof server.command !== "string") return undefined;
  const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === "string") : [];
  return [server.command, ...args].join(" ");
}

/** chrome-devtools MCP の設定が揃っているか(apply --run の pending 判定と同じ意味の ready) */
export function uiPointingReady(repoPath: string): boolean {
  return uiPointingStatus(repoPath).missing.length === 0;
}
