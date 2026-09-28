import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isMap, isSeq, parse, parseDocument } from "yaml";
import type { TeamManifest } from "./types.js";

/** チーム設定のファイル名(対象プロジェクトのルート直下に置く) */
export const SETTINGS_FILE = "atf-settings.yaml";

/** 書式のバージョン(将来の移行用) */
export const SETTINGS_VERSION = 1;

/** チーム設定のパス(<project-dir>/atf-settings.yaml) */
export function settingsPath(repoPath: string): string {
  return join(repoPath, SETTINGS_FILE);
}

/** 旧マニフェスト(.claude/team.json)のパス。読み込み時に自動移行して削除する */
export function legacyManifestPath(repoPath: string): string {
  return join(repoPath, ".claude", "team.json");
}

/** チームが導入されているか(旧 team.json しかない場合も true = 移行できる) */
export function hasTeamSettings(repoPath: string): boolean {
  return existsSync(settingsPath(repoPath)) || existsSync(legacyManifestPath(repoPath));
}

/**
 * 旧 `.claude/team.json` を `atf-settings.yaml` に移行する(移行したらそのパスを返す)。
 *
 * team.json は廃止したが、既に導入済みのプロジェクトを手作業なしで動かし続けるため、
 * 読み書きのどちらでも通る位置でこれを呼ぶ。移行後の team.json は残さない
 * (2 つの情報源が並存すると、どちらが正なのか分からなくなるため)。
 */
export function migrateLegacyManifest(repoPath: string): string | undefined {
  const legacy = legacyManifestPath(repoPath);
  if (!existsSync(legacy)) return undefined;
  const path = settingsPath(repoPath);
  if (!existsSync(path)) {
    let manifest: TeamManifest;
    try {
      manifest = JSON.parse(readFileSync(legacy, "utf8")) as TeamManifest;
    } catch (e) {
      throw new Error(`${legacy} を解釈できません(JSON の構文エラー: ${(e as Error).message})`);
    }
    writeFileSync(path, buildSettingsYaml(manifest));
  }
  rmSync(legacy, { force: true });
  return path;
}

/**
 * チーム設定(atf-settings.yaml)を読む。
 * 旧 `.claude/team.json` しかなければ移行してから読む。
 *
 * このファイルは人が手で編集するため、壊れている場合は「どこが悪いのか」が分かる
 * エラーにする(cli.ts が受け取って終了コード 1 で報告する)。
 */
export function loadTeamSettings(repoPath: string): TeamManifest {
  migrateLegacyManifest(repoPath);
  const path = settingsPath(repoPath);
  if (!existsSync(path)) {
    throw new Error(
      `チームが導入されていません(${path} がありません)。先に atf init を実行してください。`,
    );
  }

  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} を解釈できません(YAML の構文エラー: ${(e as Error).message})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error(`${path} の中身がマッピングではありません(atf init で作り直せます)`);
  }

  const manifest = doc as Partial<TeamManifest>;
  const missing = (["project", "preset", "requirements", "agents"] as const).filter(
    (key) => manifest[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(`${path} に必須の項目がありません: ${missing.join(", ")}`);
  }

  return {
    generatedBy: manifest.generatedBy ?? "agent-team-factory",
    preset: manifest.preset!,
    presetName: manifest.presetName ?? manifest.preset!,
    project: manifest.project!,
    requirements: manifest.requirements!,
    agents: manifest.agents ?? [],
    flow: manifest.flow ?? [],
    ...(manifest.skills ? { skills: manifest.skills } : {}),
  };
}

/**
 * チーム設定を atf-settings.yaml に書き出す(旧 team.json が残っていれば消す)。
 * init / apply はこれを通して更新する。
 */
export function saveTeamSettings(repoPath: string, manifest: TeamManifest): string {
  const path = settingsPath(repoPath);
  writeFileSync(path, buildSettingsYaml(manifest));
  rmSync(legacyManifestPath(repoPath), { force: true });
  return path;
}

/**
 * マニフェストを atf-settings.yaml の本文にする。
 *
 * 冒頭に「何のファイルで、どこを書き換えてよいのか」をコメントで置く。
 * requirements は人が読み書きする設定、agents / flow / skills は atf が書く実体の記録で、
 * 役割が違うことが分からないと手編集の事故につながるため。
 */
export function buildSettingsYaml(manifest: TeamManifest): string {
  const doc = new Document({ version: SETTINGS_VERSION, ...manifest });
  doc.commentBefore = [
    ` ${SETTINGS_FILE} — ${manifest.project} のチーム設定(agent-team-factory が生成)`,
    "",
    " このファイルがチーム構成の単一情報源です(旧 .claude/team.json は廃止しました)。",
    " atf status はここの requirements を根拠に「有効な機能」を判断し、実体",
    " (エージェント定義・成果物・記録)と突き合わせて食い違いを報告します。",
    "",
    " - requirements: ヒアリングの結果。手で書き換えてよい設定",
    " - agents / flow / skills: atf が書き出す実体の記録(手で書き換えない)",
    "",
    " requirements を変えただけでは、エージェント定義は入れ替わりません。",
    " 機能(formalSpec / archCheck / reverseDocs / rubricEval)の導入は `atf apply <formal|arch|docs|eval> <project-dir>`、撤去は `atf remove ...`、",
    " ルーブリック評価の対象(requirements.evalTargets)は手で true/false を書き換えたあと `atf apply eval` で反映します。",
    " それ以外の構成変更は `atf init <project-dir>` をやり直してください。",
  ].join("\n");

  applyFlowStyle(doc);
  return String(doc);
}

/** フロー(from → to のペア)は 1 行 1 辺のほうが読みやすいため流れ形式にする */
function applyFlowStyle(doc: Document): void {
  const flow = doc.get("flow");
  if (!isSeq(flow)) return;
  for (const edge of flow.items) {
    if (isSeq(edge)) edge.flow = true;
  }
}

/** 同じ内容か(YAML から読んだ値と、これから書く値の比較に使う) */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 既存の atf-settings.yaml を残したまま、変わった項目だけを書き換える。
 *
 * `atf apply` 系はチーム設定の一部だけを更新するため、ファイル全体を組み立て直すと
 * ユーザーが書き足したコメントや atf が知らない項目が消えてしまう。
 * ここでは YAML のドキュメントを読み込んで差分だけ当てるので、触っていない箇所は原文のまま残る。
 *
 * ファイルがない・壊れている場合は `saveTeamSettings` と同じく全体を書き出す。
 */
export function updateTeamSettings(repoPath: string, manifest: TeamManifest): string {
  const path = settingsPath(repoPath);
  if (!existsSync(path)) return saveTeamSettings(repoPath, manifest);

  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    // 壊れているものを部分更新すると壊れ方が増えるだけなので作り直す
    return saveTeamSettings(repoPath, manifest);
  }
  const current = doc.toJSON() as Record<string, unknown>;

  const setIfChanged = (key: string, value: unknown) => {
    if (value === undefined) {
      doc.delete(key);
      return;
    }
    if (!sameValue(current[key], value)) doc.set(key, doc.createNode(value));
  };

  setIfChanged("version", SETTINGS_VERSION);
  setIfChanged("generatedBy", manifest.generatedBy);
  setIfChanged("preset", manifest.preset);
  setIfChanged("presetName", manifest.presetName);
  setIfChanged("project", manifest.project);

  // requirements は人が手で書き換える設定。行ごとのコメントを残すため、
  // マップごと差し替えずに変わったキーだけを当てる
  const requirements = doc.get("requirements", true);
  if (isMap(requirements)) {
    const before = (current.requirements ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(manifest.requirements)) {
      if (!sameValue(before[key], value)) requirements.set(key, doc.createNode(value));
    }
    // 設定から外れた項目(デザインの解除など)は消す
    for (const key of Object.keys(before)) {
      if (!(key in manifest.requirements)) requirements.delete(key);
    }
  } else {
    doc.set("requirements", doc.createNode(manifest.requirements));
  }

  // agents / flow / skills は atf が書く実体の記録なので、まるごと入れ替える
  setIfChanged("agents", manifest.agents);
  setIfChanged("flow", manifest.flow);
  setIfChanged("skills", manifest.skills);

  applyFlowStyle(doc);
  writeFileSync(path, String(doc));
  rmSync(legacyManifestPath(repoPath), { force: true });
  return path;
}
