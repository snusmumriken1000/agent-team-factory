import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * エージェントログ可視化(`atf apply agent-log`)。
 *
 * Claude Code の OpenTelemetry 出力を otel-desktop-viewer へ転送するための
 * 環境変数を、対象プロジェクトの `.claude/settings.json` の `env` に配る。
 * atf が配るのは**設定だけ**で、otel-desktop-viewer の導入・起動はユーザー
 * (または env-builder)の仕事(ツールを直接叩かない arch.ts と同じ切り分け)。
 *
 * `.claude/settings.json` はユーザーも書くファイルなので、扱いは writeIfAbsent 側:
 * 無いキーだけを足し、既にある値は(atf の既定と違っても)上書きしない。
 * `atf update` の managed にも入れない。
 */

/** otel-desktop-viewer の既定の OTLP gRPC 受け口 */
export const AGENT_LOG_ENDPOINT = "http://localhost:4317";

/** otel-desktop-viewer の閲覧 UI(既定ポート) */
export const AGENT_LOG_VIEWER_URL = "http://localhost:8000";

/**
 * ログ転送に必要な環境変数(.claude/settings.json の env に入れる)。
 * Claude Code は CLAUDE_CODE_ENABLE_TELEMETRY=1 のときだけ OTLP へ出力する。
 * OTEL_SERVICE_NAME はプロジェクトごとに変わるため agentLogEnv で足す。
 */
export const AGENT_LOG_BASE_ENV: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
  OTEL_EXPORTER_OTLP_ENDPOINT: AGENT_LOG_ENDPOINT,
};

/** 必須キー(OTEL_SERVICE_NAME を含む。status の点検と ready 判定の単一情報源) */
export const AGENT_LOG_KEYS: string[] = [...Object.keys(AGENT_LOG_BASE_ENV), "OTEL_SERVICE_NAME"];

/**
 * 配る環境変数一式。OTEL_SERVICE_NAME にプロジェクト名を入れることで、
 * otel-desktop-viewer の Service 列がプロジェクト名になり、
 * 複数プロジェクトのログを 1 つのビューアで見分けられる。
 */
export function agentLogEnv(project: string): Record<string, string> {
  return { ...AGENT_LOG_BASE_ENV, OTEL_SERVICE_NAME: project };
}

/** 配布先(Claude Code のプロジェクト設定。チームで共有するので commit する側) */
export function claudeSettingsPath(repoPath: string): string {
  return join(repoPath, ".claude", "settings.json");
}

/** settings.json を読む。無ければ空、壊れていればどこが悪いか分かるエラーにする */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${path} を JSON として読めません(${(e as Error).message})。壊れた設定に追記すると Claude Code が設定全体を読めなくなるため、先に直してください。`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} のトップレベルがオブジェクトではありません。先に直してください。`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * ログ転送の環境変数を `.claude/settings.json` にマージする(足場の用意)。
 *
 * - env に無いキーだけを足す。既にあるキーはユーザーの選択なので値を変えない
 *   (別の転送先を使っている設定を壊さない)
 * - env 以外の項目(permissions など)には触らない
 * - 変更が無ければ書き込まない(mtime を無駄に動かさない)
 *
 * 返り値は配布先のパス(apply の「成果物」表示に使う)。
 * project は atf-settings.yaml の project(OTEL_SERVICE_NAME の値になる)。
 */
export function writeAgentLogSettings(repoPath: string, project: string): string {
  const path = claudeSettingsPath(repoPath);
  const settings = readSettings(path);
  const env = (settings.env ?? {}) as Record<string, unknown>;
  if (settings.env !== undefined && (typeof settings.env !== "object" || Array.isArray(settings.env))) {
    throw new Error(`${path} の env がオブジェクトではありません。先に直してください。`);
  }

  let changed = false;
  for (const [key, value] of Object.entries(agentLogEnv(project))) {
    if (env[key] === undefined) {
      env[key] = value;
      changed = true;
    }
  }
  if (changed || !existsSync(path)) {
    settings.env = env;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return path;
}

/** 配布した設定の実体(atf status と ready 判定の入力) */
export interface AgentLogStatus {
  /** 配布先のパス */
  path: string;
  /** settings.json が存在するか */
  exists: boolean;
  /** env に無い必須キー */
  missing: string[];
  /** 現在の転送先(OTEL_EXPORTER_OTLP_ENDPOINT。未設定なら undefined) */
  endpoint?: string;
  /** ビューアの Service 列に出る名前(OTEL_SERVICE_NAME。未設定なら undefined) */
  service?: string;
}

/**
 * `.claude/settings.json` にログ転送の設定が揃っているかを調べる。
 * 値までは合わせない(転送先を変えた設定は「揃っている」として尊重する)。
 * 壊れた JSON は「無い」扱いにして、点検(atf status)を落とさない。
 */
export function agentLogStatus(repoPath: string): AgentLogStatus {
  const path = claudeSettingsPath(repoPath);
  let settings: Record<string, unknown> = {};
  const exists = existsSync(path);
  if (exists) {
    try {
      settings = readSettings(path);
    } catch {
      settings = {};
    }
  }
  const env =
    settings.env !== null && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  const missing = AGENT_LOG_KEYS.filter((key) => env[key] === undefined);
  const endpoint =
    typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === "string" ? env.OTEL_EXPORTER_OTLP_ENDPOINT : undefined;
  const service = typeof env.OTEL_SERVICE_NAME === "string" ? env.OTEL_SERVICE_NAME : undefined;
  return { path, exists, missing, endpoint, service };
}

/** ログ転送の設定が揃っているか(apply --run の pending 判定と同じ意味の ready) */
export function agentLogReady(repoPath: string): boolean {
  return agentLogStatus(repoPath).missing.length === 0;
}
