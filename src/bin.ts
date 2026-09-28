import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { narrationDir } from "./alloy.js";
import type { Requirements } from "./types.js";

/**
 * atf が管理する実行スクリプトの置き場(対象プロジェクトの直下)。
 *
 * ここに置くのは「atf が内容を決めて配る、どのプロジェクトでも同じ中身」のスクリプトだけ。
 * プロジェクトごとに中身が変わりエージェントが書き込むスクリプト
 * (.claude/atf-arch/run-arch-check.sh・spec/run-alloy.sh)は
 * 元の場所に残す。上書きしてよいものと、してはいけないものを混ぜないため。
 */
export function atfBinDir(repoPath: string): string {
  return join(repoPath, "atf-bin");
}

/** このマシンにある agent-team-factory のルート(dist/ からも src/ からも 1 つ上) */
export function atfHomeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

/** マシン固有の絶対パスを持つため commit しないファイル */
export const LOCAL_SCRIPT = "atf.local.sh";

/** .gitignore に追記するパターン(マシン固有の設定) */
export const LOCAL_IGNORE_PATTERN = "atf-bin/atf.local.sh";

/**
 * 形式仕様モードで .gitignore に入れるパターン。
 *
 * 生成物(weave の出力)と非決定的な出力(反例のインスタンス・LLM のナレーション)は
 * commit しない。人が編集する余地をゼロにするのが、SSOT を守るいちばん確実な方法。
 */
export const FORMAL_IGNORE_PATTERNS = [
  "docs/generated/",
  "spec/.alloy-out/",
  `${relative(".", narrationDir("."))}/`,
];

const README = `# atf-bin

agent-team-factory(\`atf\`)が生成・管理する実行スクリプト。
チーム全員と CI が同じ入口を使えるように **commit する**。

## 使い方

\`\`\`bash
bash atf-bin/status.sh    # 有効な機能と実体の点検
bash atf-bin/report.sh    # ダッシュボード(.claude/atf-dashboard.html)の再生成
bash atf-bin/formal.sh    # 形式仕様(Alloy)の検証 — 実装前ゲート
bash atf-bin/lint.sh      # 形式仕様の運用規約の検査 — SSOT が割れていないか
bash atf-bin/weave.sh     # 形式仕様から自然言語の文書を生成(docs/generated/)
bash atf-bin/arch.sh      # アーキテクチャ適合検証 — 実装後ゲート
bash atf-bin/docs.sh      # リバースドキュメントの追随状況
bash atf-bin/eval.sh      # ルーブリック評価の集計 — 完了前ゲート
\`\`\`

リポジトリのどこから実行してもよい(スクリプトが自分の位置からルートを割り出す)。
実行権限に依存しないよう、必ず \`bash atf-bin/*.sh\` の形で呼ぶこと。
有効な機能に対応するスクリプトだけが置かれる。

## 編集してはいけない

このディレクトリのファイルは \`atf init\` のたびに最新版で上書きされる。
手で書き換えても次の生成で消える。挙動を変えたいときは agent-team-factory 側を直すこと。

検証の中身(どのツールをどう呼ぶか)を書くのはここではなく、
\`.claude/atf-arch/run-arch-check.sh\`(arch-guard が実装する)。あちらは上書きされない。
\`spec/run-alloy.sh\`(Alloy の呼び出し)も同じく上書きされない側。

## atf の解決順

\`_resolve.sh\` が次の順で \`atf\` を探す。

1. 環境変数 \`ATF\`(例: \`ATF="node /path/to/atf/dist/cli.js"\`)
2. PATH 上の \`atf\`
3. \`atf.local.sh\` が記録したこのマシンの atf(\`init\` 時に書かれる。絶対パスを含むため commit しない)

すべて外れた場合は、解決方法を示して終了コード 127 で終わる。
`;

const RESOLVE_SH = `#!/usr/bin/env bash
# atf(agent-team-factory)の実行系を解決する。
# このファイルは source 専用で、単体では何もしない。
# atf が生成・管理するファイル。手で編集しても atf init で上書きされる。

# 呼び出し元が ATF_BIN_DIR を設定していることを前提にする
atf_resolve() {
  ATF_CMD=()

  # 1. 環境変数(例: ATF="node /path/to/atf/dist/cli.js")
  if [ -n "\${ATF:-}" ]; then
    read -r -a ATF_CMD <<<"\$ATF"
    return 0
  fi

  # 2. PATH 上の atf
  if command -v atf >/dev/null 2>&1; then
    ATF_CMD=(atf)
    return 0
  fi

  # 3. init 時に記録したこのマシンの atf
  if [ -f "\$ATF_BIN_DIR/${LOCAL_SCRIPT}" ]; then
    # shellcheck source=/dev/null
    . "\$ATF_BIN_DIR/${LOCAL_SCRIPT}"
  fi
  if [ -n "\${ATF_HOME_DIR:-}" ]; then
    if [ -f "\$ATF_HOME_DIR/dist/cli.js" ] && command -v node >/dev/null 2>&1; then
      ATF_CMD=(node "\$ATF_HOME_DIR/dist/cli.js")
      return 0
    fi
    if [ -f "\$ATF_HOME_DIR/src/cli.ts" ] && command -v npx >/dev/null 2>&1; then
      ATF_CMD=(npx --yes tsx "\$ATF_HOME_DIR/src/cli.ts")
      return 0
    fi
  fi

  return 1
}

atf_run() {
  if ! atf_resolve; then
    {
      echo "atf を実行できませんでした。次のいずれかで解決してください:"
      echo "  - agent-team-factory を PATH に通す(npm link / npm i -g)"
      echo "  - 環境変数 ATF で実行方法を指定する(例: ATF=\\"node /path/to/atf/dist/cli.js\\")"
      echo "  - atf-bin/${LOCAL_SCRIPT} の ATF_HOME_DIR を、このマシンの agent-team-factory に向ける"
      echo "  - env-builder エージェントに atf の実行環境の整備を依頼する"
    } >&2
    return 127
  fi
  "\${ATF_CMD[@]}" "\$@"
}
`;

const localScript = (home: string) => `#!/usr/bin/env bash
# このマシンでの agent-team-factory の場所。atf init が書き出す。
# 絶対パスを含みマシンごとに異なるため **commit しない**(.gitignore 済み)。
# 別のマシンでは、このファイルを書き換えるか、環境変数 ATF を使うこと。

ATF_HOME_DIR="${home}"
`;

/** atf のサブコマンドを 1 つ呼ぶだけのラッパを組み立てる */
const commandScript = (sub: string, summary: string) => `#!/usr/bin/env bash
# ${summary}
#   使い方: bash atf-bin/${sub}.sh [atf ${sub} への追加引数]
#
# atf が生成・管理するファイル。手で編集しても atf init で上書きされる。
set -uo pipefail

ATF_BIN_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
ATF_PROJECT_DIR="\$(cd "\$ATF_BIN_DIR/.." && pwd)"

# shellcheck source=/dev/null
. "\$ATF_BIN_DIR/_resolve.sh"

atf_run ${sub} "\$ATF_PROJECT_DIR" "\$@"
`;

/** 常に配るスクリプト(チームが導入されていれば必ず使える) */
const ALWAYS_SCRIPTS: Array<[string, string]> = [
  ["status", "導入済みチームで有効な機能と、その実体を点検する。"],
  ["report", "チーム構成と実行記録の HTML ダッシュボードを再生成する。"],
];

/**
 * 名前を変えた機能の、旧名のスクリプト。
 * 残しておくと「もう無いサブコマンド」を呼んで必ず失敗するため、見つけたら消す
 * (verify → formal: 形式仕様の実行スクリプト)。
 */
const LEGACY_SCRIPTS = ["verify.sh"];

/** 機能が有効なときだけ配るスクリプト */
const FEATURE_SCRIPTS: Array<{
  sub: string;
  summary: string;
  enabled: (r: Requirements) => boolean;
}> = [
  {
    sub: "formal",
    summary: "形式仕様(spec/*.als)を Alloy で検証する(実装前ゲート)。",
    enabled: (r) => r.formalSpec === true,
  },
  {
    sub: "weave",
    summary: "形式仕様と ADR から自然言語の文書を生成する(docs/generated/。生成物なので commit しない)。",
    enabled: (r) => r.formalSpec === true,
  },
  {
    sub: "lint",
    summary: "形式仕様の運用規約を検査する(必須タグ・@req の重複と孤児・手書き文書への規範文の混入)。",
    enabled: (r) => r.formalSpec === true,
  },
  {
    sub: "arch",
    summary: "アーキテクチャ適合検証(.claude/atf-arch/rules.json)を実行する(実装後ゲート)。",
    enabled: (r) => r.archCheck === true,
  },
  {
    sub: "docs",
    summary: "リバースドキュメントの一覧と、実装への追随状況を表示する。",
    enabled: (r) => r.reverseDocs === true,
  },
  {
    sub: "eval",
    summary: "ルーブリック評価(.claude/atf-eval/)の集計と、評価ゲートの通過状況を表示する。",
    enabled: (r) => r.rubricEval === true,
  },
];

/**
 * その機能の実行スクリプトを atf-bin に配るか。
 * Issue 駆動のように「エージェントと指示だけ」の機能はスクリプトを持たない
 * (どのスクリプトが存在するかの単一情報源はこのファイル)。
 */
export function hasBinScript(sub: string): boolean {
  return ALWAYS_SCRIPTS.some(([s]) => s === sub) || FEATURE_SCRIPTS.some((f) => f.sub === sub);
}

/** atf-bin に配る 1 ファイル(内容は requirements だけで決まる) */
export interface AtfBinFile {
  file: string;
  content: string;
  mode?: number;
}

/**
 * atf-bin に配るファイル一式を組み立てる(書き込みはしない)。
 * 配布(`installAtfBin`)と、書き込み前の差分調査(`planAtfBin`)の単一情報源。
 */
export function atfBinFiles(
  requirements: Requirements,
  opts: { home?: string } = {},
): AtfBinFile[] {
  return [
    { file: "README.md", content: README },
    { file: "_resolve.sh", content: RESOLVE_SH, mode: 0o755 },
    { file: LOCAL_SCRIPT, content: localScript(opts.home ?? atfHomeDir()), mode: 0o755 },
    ...ALWAYS_SCRIPTS.map(([sub, summary]) => ({
      file: `${sub}.sh`,
      content: commandScript(sub, summary),
      mode: 0o755,
    })),
    ...FEATURE_SCRIPTS.filter((spec) => spec.enabled(requirements)).map((spec) => ({
      file: `${spec.sub}.sh`,
      content: commandScript(spec.sub, spec.summary),
      mode: 0o755,
    })),
  ];
}

/** 取り除く対象のファイル名(旧名のスクリプト + 無効な機能のスクリプト) */
function staleBinFiles(requirements: Requirements): string[] {
  return [
    ...LEGACY_SCRIPTS,
    ...FEATURE_SCRIPTS.filter((spec) => !spec.enabled(requirements)).map((spec) => `${spec.sub}.sh`),
  ];
}

/**
 * 書き込まずに、atf-bin をいま配り直したら何が変わるかを調べる(`atf update` の事前提示に使う)。
 * 内容が同じファイルは changed に入らない。
 */
export function planAtfBin(
  repoPath: string,
  requirements: Requirements,
  opts: { home?: string } = {},
): { dir: string; changed: string[]; removed: string[] } {
  const dir = atfBinDir(repoPath);
  const changed = atfBinFiles(requirements, opts)
    .filter(({ file, content }) => {
      const dest = join(dir, file);
      return !existsSync(dest) || readFileSync(dest, "utf8") !== content;
    })
    .map(({ file }) => file);
  const removed = staleBinFiles(requirements).filter((file) => existsSync(join(dir, file)));
  return { dir, changed, removed };
}

export interface AtfBinResult {
  /** atf-bin ディレクトリの絶対パス */
  dir: string;
  /** 書き出したファイル名 */
  written: string[];
  /** 無効になった機能のぶんで削除したファイル名 */
  removed: string[];
  /** .gitignore に追記したパターン(マシン固有の設定・形式仕様の生成物) */
  gitignoreAdded: string[];
}

/**
 * 対象プロジェクトの直下に atf-bin/ を用意する。
 *
 * ここのファイルは atf が内容を決めるため **毎回上書きする**(force 不要)。
 * 手で編集する前提のスクリプトは置かない、という切り分けが前提になっている。
 */
export function installAtfBin(
  repoPath: string,
  requirements: Requirements,
  opts: { home?: string } = {},
): AtfBinResult {
  const dir = atfBinDir(repoPath);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const removed: string[] = [];

  for (const { file, content, mode } of atfBinFiles(requirements, opts)) {
    writeFileSync(join(dir, file), content);
    if (mode !== undefined) chmodSync(join(dir, file), mode);
    written.push(file);
  }

  // 旧名のスクリプトと、機能を切ったあとに残る「呼ぶと必ず失敗するスクリプト」を取り除く
  for (const file of staleBinFiles(requirements)) {
    const dest = join(dir, file);
    if (existsSync(dest)) {
      rmSync(dest);
      removed.push(file);
    }
  }

  return { dir, written, removed, gitignoreAdded: ensureGitignore(repoPath, requirements) };
}

/** atf-bin のスクリプトを 1 回実行した結果(合否の解釈は呼び出し側の責務) */
export interface BinRunResult {
  /** 実行した(しようとした)スクリプトのパス */
  script: string;
  /** スクリプトが配られていない */
  missing: boolean;
  /** 終了コード(起動そのものに失敗したときは undefined) */
  code?: number;
  /** _resolve.sh が atf を見つけられなかった(= 配線の不備。atf_run の 127) */
  unresolved: boolean;
  /** 標準出力 + 標準エラー(表示用) */
  output: string;
}

/**
 * `atf-bin/<sub>.sh` を 1 回実行する(導入直後のスモーク実行に使う)。
 *
 * ここが持つのは「起動できたか」と出力だけで、ゲートの合否は解釈しない
 * (判定の単一情報源は alloy.ts / arch.ts / reverse.ts のまま)。
 */
export function runBinScript(
  repoPath: string,
  sub: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): BinRunResult {
  const script = join(atfBinDir(repoPath), `${sub}.sh`);
  if (!existsSync(script)) return { script, missing: true, unresolved: false, output: "" };

  const run = spawnSync("bash", [script], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 10 * 60 * 1000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd();
  const code = run.status ?? undefined;
  return { script, missing: false, code, unresolved: code === 127, output };
}

/**
 * .gitignore に atf-bin/atf.local.sh を追記する(atf-bin/*.sh 自体は commit 対象)。
 * 既に無視されていれば何もしない。
 */
export function ensureGitignore(repoPath: string, requirements?: Requirements): string[] {
  const dest = join(repoPath, ".gitignore");
  const current = existsSync(dest) ? readFileSync(dest, "utf8") : "";
  const lines = current.split("\n").map((l) => l.trim());
  const has = (pattern: string) =>
    lines.includes(pattern) || lines.includes(pattern.replace(/\/$/, ""));

  const blocks: { comment: string; patterns: string[] }[] = [
    {
      comment:
        "# agent-team-factory: atf の場所はマシンごとに違うため共有しない(atf-bin/*.sh は commit する)",
      patterns: [LOCAL_IGNORE_PATTERN].filter((p) => !has(p)),
    },
    {
      comment:
        "# agent-team-factory: 形式仕様の生成物と非決定的な出力(正は spec/*.als と docs/adr/)",
      patterns:
        requirements?.formalSpec === true ? FORMAL_IGNORE_PATTERNS.filter((p) => !has(p)) : [],
    },
  ].filter((b) => b.patterns.length > 0);

  if (blocks.length === 0) return [];
  const appended = blocks.map((b) => `${b.comment}\n${b.patterns.join("\n")}\n`).join("\n");
  const body =
    current === "" ? appended : `${current.endsWith("\n") ? current : `${current}\n`}\n${appended}`;
  writeFileSync(dest, body);
  return blocks.flatMap((b) => b.patterns);
}
