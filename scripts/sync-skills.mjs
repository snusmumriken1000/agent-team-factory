#!/usr/bin/env node
/**
 * 外部リポジトリのスキル(SKILL.md)を templates/skills/ に取り込む開発者用スクリプト。
 *
 *   node scripts/sync-skills.mjs            # sources.json に pin された commit から取り込む
 *   node scripts/sync-skills.mjs --ref main # 上流の最新 commit に pin を更新して取り込む
 *   node scripts/sync-skills.mjs --check    # 取り込み済みの内容が pin と一致するか検証(書き込まない)
 *
 * atf の CLI 本体はネットワークを使わない。取得はこのスクリプトだけが行い、
 * 取り込んだ SKILL.md は無改変で配布する(改変すると差分検証が壊れる)。
 *
 * 複数ファイルからなるスキル(skill.json の source.vendored が true。archify など)は
 * パッケージごと同梱しているため取得の対象にしない。出典表示だけを NOTICE.md に載せ、
 * sources.json に載っていなくても掃除しない。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(root, "templates", "skills");
const sourcesPath = join(skillsRoot, "sources.json");

const args = process.argv.slice(2);
const check = args.includes("--check");
const refIndex = args.indexOf("--ref");
const refOverride = refIndex >= 0 ? args[refIndex + 1] : undefined;

/** frontmatter から name / description を読む(src/generator.ts の parseAgentMeta と同じ規則) */
function parseMeta(source) {
  const fm = source.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  for (const line of fm?.[1].split("\n") ?? []) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return await res.text();
}

/** ref(ブランチ名・タグ・SHA)を commit SHA に解決する */
async function resolveCommit(repo, ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`commit の解決に失敗しました (${res.status}): ${repo}@${ref}`);
  return (await res.json()).sha;
}

const config = JSON.parse(readFileSync(sourcesPath, "utf8"));
const changed = [];
const mismatched = [];
const notices = [];
const allIds = new Set();

for (const source of config.sources) {
  const ref = refOverride ?? source.ref;
  const commit = await resolveCommit(source.repo, ref);
  const raw = (path) => `https://raw.githubusercontent.com/${source.repo}/${commit}/${path}`;
  const license = await fetchText(raw(source.licensePath));
  const rows = [];

  for (const skill of source.skills) {
    allIds.add(skill.id);
    const content = await fetchText(raw(skill.path));
    const meta = parseMeta(content);
    if (!meta.name) throw new Error(`frontmatter に name がありません: ${skill.id}`);

    const dir = join(skillsRoot, skill.id);
    const skillMd = join(dir, "SKILL.md");
    const current = existsSync(skillMd) ? readFileSync(skillMd, "utf8") : undefined;

    if (check) {
      if (current !== content) mismatched.push(skill.id);
    } else {
      if (current !== content) changed.push(skill.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(skillMd, content);
      writeFileSync(
        join(dir, "skill.json"),
        JSON.stringify(
          {
            category: skill.category,
            ...(skill.recommended ? { recommended: true } : {}),
            source: {
              repo: source.repo,
              homepage: source.homepage,
              path: skill.path,
              commit,
              license: source.license,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
    rows.push(`| \`${meta.name}\` | ${skill.id} | ${skill.category} | ${meta.description ?? ""} |`);
  }

  notices.push(`## ${source.repo}

- 取得元: ${source.homepage}
- ライセンス: ${source.license}
- 取り込んだ commit: \`${commit}\`
- \`SKILL.md\` は無改変で同梱している(改変する場合は上流の派生物であることを明示すること)

| インストール名(frontmatter の name) | カタログ id | 分類 | 説明 |
| --- | --- | --- | --- |
${rows.join("\n")}

### ライセンス全文

\`\`\`
${license.trim()}
\`\`\`
`);

  if (!check) source.ref = commit;
}

/** パッケージごと同梱しているスキル(取得はせず、出典表示だけを残す) */
const vendored = [];
for (const entry of readdirSafe(skillsRoot)) {
  const metaPath = join(skillsRoot, entry, "skill.json");
  if (!existsSync(metaPath)) continue;
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!meta.source?.vendored) continue;
  const skillMd = join(skillsRoot, entry, "SKILL.md");
  if (!existsSync(skillMd)) {
    console.error(`SKILL.md がありません: ${entry}`);
    process.exit(1);
  }
  const licensePath = join(skillsRoot, entry, "LICENSE");
  if (!existsSync(licensePath)) {
    console.error(`同梱スキルに LICENSE がありません: ${entry}(再配布の条件を満たせません)`);
    process.exit(1);
  }
  vendored.push({
    id: entry,
    meta: parseMeta(readFileSync(skillMd, "utf8")),
    source: meta.source,
    category: meta.category,
    license: readFileSync(licensePath, "utf8"),
  });
}

for (const v of vendored) {
  notices.push(`## ${v.source.repo}(パッケージごと同梱)

- 取得元: ${v.source.homepage ?? `https://github.com/${v.source.repo}`}
- ライセンス: ${v.source.license ?? "(不明)"}
- 同梱した版: \`${v.source.version ?? "(不明)"}\`
- 除外したパス: ${(v.source.excluded ?? []).map((e) => `\`${e}\``).join(" / ") || "(なし)"}
- \`SKILL.md\` とスクリプト・スキーマ・テンプレートを無改変で同梱している(スキルの手順がスキル内のスクリプトを実行するため)

| インストール名(frontmatter の name) | カタログ id | 分類 | 説明 |
| --- | --- | --- | --- |
| \`${v.meta.name}\` | ${v.id} | ${v.category} | ${v.meta.description ?? ""} |

### ライセンス全文

\`\`\`
${v.license.trim()}
\`\`\`
`);
}

if (check) {
  if (mismatched.length > 0) {
    console.error(`pin と一致しないスキルがあります: ${mismatched.join(", ")}`);
    console.error("node scripts/sync-skills.mjs で取り込み直してください。");
    process.exit(1);
  }
  console.log(
    `一致を確認しました(取得 ${allIds.size} スキル` +
      (vendored.length > 0 ? ` / 同梱 ${vendored.length} スキル: ${vendored.map((v) => v.id).join(", ")}` : "") +
      ")。",
  );
  process.exit(0);
}

// sources.json から消えた「外部由来の」スキルのディレクトリを掃除する。
// atf 独自スキル(skill.json に source を持たない)は sources.json に載らないので消さない。
for (const entry of readdirSafe(skillsRoot)) {
  if (allIds.has(entry)) continue;
  const meta = join(skillsRoot, entry, "skill.json");
  if (!existsSync(meta)) continue;
  const source = JSON.parse(readFileSync(meta, "utf8")).source;
  if (!source) continue;
  if (source.vendored) continue; // パッケージごと同梱したスキルは sources.json の管理外
  rmSync(join(skillsRoot, entry), { recursive: true, force: true });
  console.log(`削除: ${entry}(sources.json にない外部スキル)`);
}

writeFileSync(sourcesPath, JSON.stringify(config, null, 2) + "\n");
writeFileSync(
  join(skillsRoot, "NOTICE.md"),
  `# 同梱スキルの出典とライセンス

agent-team-factory が同梱・再配布しているスキルの一覧。
このファイルは \`scripts/sync-skills.mjs\` が生成する(手で編集しない)。

${notices.join("\n")}`,
);

console.log(
  changed.length > 0
    ? `更新しました(${changed.length} / ${allIds.size} スキル): ${changed.join(", ")}`
    : `変更はありませんでした(${allIds.size} スキル)。`,
);

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
