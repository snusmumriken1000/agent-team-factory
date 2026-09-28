/**
 * ターミナル向けの表組み。
 *
 * 日本語(全角)と絵文字を含む行を桁揃えするため、文字数ではなく**表示幅**で計算する。
 * セルは改行を含んでよく、列幅を超える場合は表示幅で折り返す。
 */

/** 表示幅 0(結合文字・異体字セレクタなど) */
function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // ZWSP
    cp === 0x200d || // ZWJ
    (cp >= 0x0300 && cp <= 0x036f) || // 結合ダイアクリティカルマーク
    (cp >= 0xfe00 && cp <= 0xfe0f) || // 異体字セレクタ(幅は直前の文字に含める)
    (cp >= 0x20d0 && cp <= 0x20ff)
  );
}

/** 表示幅 2(East Asian Wide / Fullwidth と絵文字) */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x2705 || // ✅
    cp === 0x274c || // ❌
    cp === 0x2b1b ||
    cp === 0x2b1c || // ⬜
    cp === 0x2b50 || // ⭐
    cp === 0x2b55 || // ⭕
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 文字列の表示幅(半角 = 1、全角・絵文字 = 2) */
export function displayWidth(text: string): number {
  let width = 0;
  const points = [...text];
  for (let i = 0; i < points.length; i++) {
    const cp = points[i].codePointAt(0) ?? 0;
    if (isZeroWidth(cp)) continue;
    // 異体字セレクタ付きの記号(⚠️ など)は絵文字表示になるので全角扱い
    const emojiStyle = points[i + 1]?.codePointAt(0) === 0xfe0f;
    width += isWide(cp) || emojiStyle ? 2 : 1;
  }
  return width;
}

/** 1 文字の表示幅 */
function charWidth(ch: string, next: string | undefined): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) || next?.codePointAt(0) === 0xfe0f ? 2 : 1;
}

/** この文字の直後で改行してよいか(空白と `/` = パス・URL の区切りだけ) */
function breakAfter(ch: string): boolean {
  // `-` では折らない: issue-manager のようなエージェント名が途中で切れて読みにくくなるため
  return ch === " " || ch === "/";
}

/**
 * 行を「折ってよい単位」に刻む。
 * 全角(日本語)は 1 文字 1 単位、半角は空白・`/` などの区切りまでを 1 単位にして、
 * URL やファイルパスが単語の途中で切れないようにする。
 */
function atoms(line: string): string[] {
  const points = [...line];
  const out: string[] = [];
  let buffer = "";
  for (let i = 0; i < points.length; i++) {
    const ch = points[i];
    const cp = ch.codePointAt(0) ?? 0;
    const wide = isWide(cp) || points[i + 1]?.codePointAt(0) === 0xfe0f;
    if (wide) {
      if (buffer !== "") {
        out.push(buffer);
        buffer = "";
      }
      // 異体字セレクタ・結合文字は同じ単位に含める
      let atom = ch;
      while (isZeroWidth(points[i + 1]?.codePointAt(0) ?? 0)) atom += points[++i];
      out.push(atom);
      continue;
    }
    buffer += ch;
    if (breakAfter(ch)) {
      out.push(buffer);
      buffer = "";
    }
  }
  if (buffer !== "") out.push(buffer);
  return out;
}

/** 表示幅 limit に収まるよう 1 行を折り返す */
function wrapLine(line: string, limit: number): string[] {
  if (displayWidth(line) <= limit) return [line];
  const out: string[] = [];
  let current = "";
  let width = 0;
  const push = (): void => {
    out.push(current.trimEnd());
    current = "";
    width = 0;
  };
  for (let atom of atoms(line)) {
    let atomWidth = displayWidth(atom);
    // 1 単位で列幅を超えるもの(長い連続文字列)は仕方なく途中で切る
    while (atomWidth > limit) {
      const points = [...atom];
      let taken = "";
      let takenWidth = width;
      let i = 0;
      for (; i < points.length; i++) {
        const w = charWidth(points[i], points[i + 1]);
        if (takenWidth + w > limit) break;
        taken += points[i];
        takenWidth += w;
      }
      // 全角 1 文字すら入らない極端に狭い列でも進むように、最低 1 文字は進める
      if (taken === "" && current === "") {
        taken = points[0];
        i = 1;
      }
      current += taken;
      push();
      atom = points.slice(i).join("");
      atomWidth = displayWidth(atom);
    }
    if (width + atomWidth > limit && current !== "") push();
    // 行頭の空白は落とす(区切りの空白が次の行にぶら下がらないように)
    if (current === "" && atom.trim() === "") continue;
    current += atom;
    width += atomWidth;
  }
  if (current.trim() !== "") out.push(current.trimEnd());
  return out;
}

/** セル(改行を含んでよい)を列幅に合わせた行の配列にする */
function cellLines(cell: string, limit: number): string[] {
  return cell
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapLine(line, limit)));
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export interface TableOptions {
  /** 表全体の最大表示幅(既定: ターミナル幅) */
  maxWidth?: number;
  /** 行の左に付ける字下げ */
  indent?: string;
}

/**
 * ヘッダ + 行から罫線付きの表を組む。
 *
 * 各セルは改行を含んでよく、最大幅を超える列は表示幅で折り返す。
 * 列幅は内容の自然幅を基準に、maxWidth に収まらない場合だけ広い列から削る。
 */
export function renderTable(headers: string[], rows: string[][], opts: TableOptions = {}): string {
  const indent = opts.indent ?? "";
  const maxWidth = Math.max(40, (opts.maxWidth ?? process.stdout.columns ?? 100) - displayWidth(indent));
  const columns = headers.length;

  // 自然幅(折り返さない場合に必要な幅)
  const natural = headers.map((header, i) => {
    const cells = rows.map((row) => row[i] ?? "");
    return Math.max(
      displayWidth(header),
      ...cells.map((cell) => Math.max(0, ...cell.split("\n").map(displayWidth))),
    );
  });

  // 罫線と余白("│ " + " │ " × (列数 - 1) + " │")が占める分
  const chrome = 3 * columns + 1;
  const widths = [...natural];
  let total = widths.reduce((a, b) => a + b, 0) + chrome;
  // 収まらない間、いちばん広い列を 1 桁ずつ削る(下限 8 桁)
  while (total > maxWidth) {
    let widest = 0;
    for (let i = 1; i < columns; i++) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 8) break;
    widths[widest] -= 1;
    total -= 1;
  }

  const line = (left: string, mid: string, right: string): string =>
    indent + left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;

  const renderRow = (cells: string[]): string => {
    const columnsLines = widths.map((w, i) => cellLines(cells[i] ?? "", w));
    const height = Math.max(1, ...columnsLines.map((l) => l.length));
    const out: string[] = [];
    for (let r = 0; r < height; r++) {
      const cell = widths.map((w, i) => pad(columnsLines[i][r] ?? "", w));
      out.push(`${indent}│ ${cell.join(" │ ")} │`);
    }
    return out.join("\n");
  };

  const out: string[] = [line("┌", "┬", "┐"), renderRow(headers), line("├", "┼", "┤")];
  for (const row of rows) out.push(renderRow(row));
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}
