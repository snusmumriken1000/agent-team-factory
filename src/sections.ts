/**
 * エージェント定義(.claude/agents/*.md)のセクションを atf が出し入れするための共通処理。
 *
 * 見出し行から次の見出し(h1 / h2)までを 1 セクションとして扱うため、
 * ユーザーが書き足したセクションは残る。generator の指示文から見出しを導出して使うので、
 * 文面を変えても追従する(= 指示文の先頭は必ず `## 見出し` にすること)。
 */

/** 指示文の先頭にある `## 見出し` を取り出す */
export function sectionHeading(section: string): string {
  return section.split("\n").find((line) => line.startsWith("## "))?.trim() ?? "";
}

/** 実行記録セクション(generator が必ず末尾に置く)の見出し */
const RUN_LOG_HEADING = /^## 実行記録\s*$/m;

/**
 * 指定した見出しのセクションだけを取り出す(`stripSections` の裏返し)。
 * いま定義ファイルに入っている内容と、これから差し込む内容を比べるのに使う(`atf update`)。
 */
export function extractSections(body: string, headings: string[]): string {
  const picked: string[] = [];
  let keeping = false;
  for (const line of body.split("\n")) {
    if (/^#{1,2} /.test(line)) keeping = headings.includes(line.trim());
    if (keeping) picked.push(line);
  }
  return picked.join("\n");
}

/** 指定した見出しのセクションだけを取り除く */
export function stripSections(body: string, headings: string[]): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of body.split("\n")) {
    if (/^#{1,2} /.test(line)) skipping = headings.includes(line.trim());
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * 指定した見出しのセクションを差し替える(再適用しても増殖しない)。
 * 実行記録セクションは末尾に残したいので、その直前に挿入する。
 */
export function spliceSections(body: string, headings: string[], sections: string): string {
  const stripped = stripSections(body, headings);
  if (sections === "") return stripped.replace(/\s+$/, "") + "\n";
  const index = stripped.search(RUN_LOG_HEADING);
  if (index < 0) return stripped.replace(/\s+$/, "") + sections;
  return stripped.slice(0, index).replace(/\s+$/, "") + sections + "\n" + stripped.slice(index);
}
