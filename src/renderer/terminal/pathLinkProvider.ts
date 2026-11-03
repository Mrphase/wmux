/**
 * Path link provider — Ctrl+click (mac: Cmd+click) an absolute filesystem path in the
 * terminal to open it in Explorer / Finder / xdg-open.
 *
 * Layered with xterm's existing WebLinksAddon (URLs). The xterm adapter only
 * reads rows cell by cell into `PathRow`s; detection lives in the pure,
 * unit-tested `findPathMatches` (one line of text) and `findPathLinksInRows`
 * (wrap joining + cell-column mapping), so the xterm-coupled surface stays thin.
 *
 * Design notes:
 *   • Ranges are cell columns, not string offsets: a wide (CJK) char is one
 *     UTF-16 unit but two cells, so string offsets drift left after it.
 *   • Soft-wrapped rows (xterm `isWrapped`) are joined into one logical line,
 *     so a path crossing the row edge is one multi-row link.
 *   • Hard wraps (real newlines, e.g. Claude Code / Ink re-flowing a table
 *     cell or a long prose token) are joined heuristically, see
 *     `continuationOf`. Each row piece gets its own link so hover underlines
 *     only the path, not the table cells in between. A false join is cheap:
 *     main falls back to the nearest existing ancestor folder.
 *   • Only absolute paths are matched. Relative paths require a per-pane
 *     cwd we cannot read reliably, and false positives there are common
 *     (e.g. "foo/bar" in prose).
 *   • POSIX matching is intentionally conservative: anchored at a word
 *     boundary and requires ≥ 1 non-root segment, so `/etc/hosts` matches
 *     but `12:34` (time) or `http://example.com/path` (URL — handled by
 *     WebLinksAddon) do not.
 *   • Trailing punctuation (".,:;!?)]}>\"'`") is trimmed off matches so
 *     "see /etc/hosts." opens "/etc/hosts" not "/etc/hosts.".
 *   • Source-location suffixes like ":42" or ":42:10" are stripped before
 *     opening — Electron's shell.openPath does not understand them and
 *     would otherwise reject the path. The line/column is dropped silently
 *     (future IDE-integration hook can read them back from the raw match).
 */

import type { IBufferCell, IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

export interface PathMatch {
  /** Cleaned-up path (trailing punctuation + line:col suffix removed). */
  text: string;
  /** Inclusive start offset within the line text (0-based). */
  start: number;
  /** Exclusive end offset within the line text (0-based). */
  end: number;
}

/** Trailing characters trimmed off the right edge of a candidate path. */
const TRAILING_PUNCTUATION = /[.,:;!?)\]}>"'`]+$/;

// Trailing numeric/version-shaped suffix. Covers source locations
// (":42", ":42:10") and semver-shaped trailers (":1.2.3"). The class
// `[:.]` lets the second-and-later segments be joined by either `:` or
// `.`, so all of these strip in a single regex match:
//   /foo.ts:42          → /foo.ts
//   /foo.ts:42:10       → /foo.ts
//   /foo.ts:1.2.3       → /foo.ts
// The first separator is required to be `:` so plain filenames with dots
// ("/foo.tar.gz") are not eaten.
const SOURCE_LOCATION_SUFFIX = /:\d+(?:[:.]\d+)*$/;

// Characters that end a path token (body of a negated class): the
// path-illegal Windows characters plus whitespace/control so a path
// embedded in prose ends at the next space; box-drawing so a table border
// is never glued on; and the CJK punctuation that CJK prose writes with no
// space after a path ("…\diag.zip（15 KB）"). Any byte < 0x20 ends a token
// too, hence the no-control-regex suppressions below.
const PATH_STOP = String.raw`\s"<>|?*\x00-\x1f\u2500-\u257f\u3000（）【】「」『』《》，。；：！？、`;

// Windows drive-letter path: `C:\foo\bar` or `c:/foo/bar`.
// eslint-disable-next-line no-control-regex
const WINDOWS_DRIVE_PATH = new RegExp(String.raw`\b[A-Za-z]:[\\/][^${PATH_STOP}]+`, 'g');

// UNC share path: `\\server\share\...`. Server + share segments must look
// like hostnames (alnum + dot/hyphen/underscore); everything after is
// treated as path body.
// eslint-disable-next-line no-control-regex
const WINDOWS_UNC_PATH = new RegExp(
  String.raw`\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+(?:\\[^${PATH_STOP}]*)?`,
  'g',
);

// POSIX absolute path: leading `/`, then ≥ 1 segment of non-whitespace.
// Lookbehind anchor keeps it from chewing up the path component of an
// http URL while ensuring the match starts AT the `/` (not at the
// boundary char before it), so the recorded offset lines up with the
// cleaned text. Note: ALSO matches inside double-slashes like `//foo`
// (rare in prose; intentional for protocol-less server paths).
// eslint-disable-next-line no-control-regex
const POSIX_PATH = new RegExp(String.raw`(?<=^|[\s"'([<])\/[A-Za-z0-9._~-][^${PATH_STOP}]*`, 'g');

/** One character a path body may contain (used to extend across wraps). */
// eslint-disable-next-line no-control-regex
const PATH_CHAR = new RegExp(`[^${PATH_STOP}]`);

/**
 * Extract absolute-path matches from a line of terminal text.
 *
 * Returns matches sorted by `start`. Overlapping matches are deduplicated
 * (longer match wins) so a Windows path inside a UNC-shaped string doesn't
 * double-emit.
 */
export function findPathMatches(line: string, platform: NodeJS.Platform): PathMatch[] {
  if (!line) return [];

  const raw: PathMatch[] = [];

  const collect = (regex: RegExp) => {
    // Reset lastIndex defensively — the regex is module-scoped, so a prior
    // partial iteration on another caller's line would otherwise skip
    // matches near the start of this line.
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      const cleaned = trimPunctuation(m[0]);
      if (cleaned.length === 0) continue;
      raw.push({
        text: cleaned,
        start: m.index,
        end: m.index + cleaned.length,
      });
    }
  };

  if (platform === 'win32') {
    collect(WINDOWS_UNC_PATH);
    collect(WINDOWS_DRIVE_PATH);
  } else {
    // On POSIX hosts, also match Windows-style drive paths when they appear
    // in shared logs / docs. Cheap, no false-positive risk on Unix.
    collect(WINDOWS_DRIVE_PATH);
  }

  // POSIX-shaped matches everywhere — Windows shells routinely print
  // forward-slash paths (git, WSL output, msys tools).
  collect(POSIX_PATH);

  return dedupe(raw);
}

function trimPunctuation(text: string): string {
  // Iterate to a fixed point so wrapped suffixes ("(see /foo.ts:42)") and
  // semver-shaped trailers ("/foo.ts:1.2.3", which SOURCE_LOCATION_SUFFIX
  // peels off one segment at a time) both fully unwrap. Bounded at 8
  // iterations as a defense against pathological input — typical paths
  // converge in 1–2 passes.
  let prev = text;
  for (let i = 0; i < 8; i++) {
    let out = prev.replace(TRAILING_PUNCTUATION, '');
    out = out.replace(SOURCE_LOCATION_SUFFIX, '');
    if (out === prev) return out;
    prev = out;
  }
  return prev;
}

function dedupe(matches: PathMatch[]): PathMatch[] {
  if (matches.length <= 1) return matches.slice();
  const sorted = matches.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // Same start → longer match first so the shorter (overlapping) one is
    // dropped by the loop below.
    return b.end - a.end;
  });
  const out: PathMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) {
      // Overlap. Keep the longer one — already first by sort, so drop `m`.
      continue;
    }
    out.push(m);
  }
  return out;
}

/** One terminal row as seen by `findPathLinksInRows`. */
export interface PathRow {
  /** Row text built cell by cell (wide-char spacer cells skipped, blank cells as ' '). */
  text: string;
  /**
   * 0-based cell column of each UTF-16 unit of `text`, plus one trailing
   * entry: the column just past the last cell. A wide char maps to its first
   * cell, so the array is non-decreasing but may skip columns.
   */
  cellX: number[];
  /** xterm soft-wrap flag: this row continues the previous one. */
  isWrapped: boolean;
}

/** Link range in `rows`-array coordinates; x is a 1-based cell column, end inclusive (xterm's convention). */
export interface PathLinkRange {
  startRow: number;
  startX: number;
  endRow: number;
  endX: number;
}

export interface RowPathLink {
  /** Path joined across every wrap, cleaned like `PathMatch.text`. */
  text: string;
  /** One range per hard-wrapped row piece; a soft-wrapped piece is one multi-row range. */
  ranges: PathLinkRange[];
}

/** Table cell border drawn by Claude Code / Ink markdown tables. */
const TABLE_BORDER = '│';
/** A path that fills a table cell leaves at most its 1 padding space before the border. */
const TABLE_MAX_PADDING = 1;
/** A prose path that Ink hard-wrapped ends within this many columns of the right edge. */
const EDGE_SLACK_COLS = 3;
/** Bound on rows one hard-wrapped path may span (also the provider's look-back). */
const MAX_WRAP_ROWS = 20;
// A row opening with a box border or a Claude Code gutter glyph (⏺ ● ⎿ …)
// starts a new block, never a path's tail.
const BLOCK_START = /[\u2300-\u23ff\u2500-\u25ff]/;

// A fragment that itself opens an absolute path is the next path (`find`
// output, a table column of paths), not a tail; that row keeps its own link.
const ABSOLUTE_START = /^(?:\/|~\/|\\\\|[A-Za-z]:[\\/])/;
// A fragment must look like part of a path, so the next row's first word
// ("and", "- item", "configuration", "(none)") is never glued on.
const PATH_PIECE = /[/\\]|\.[A-Za-z0-9]{1,10}/;
const BRACKET = /[()[\]]/;
// "…/a.md" + "config.yaml" / "src/main.ts": a finished filename followed by
// another filename or relative path is two tokens, not one split token.
const FINISHED_EXT = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;
const FILENAME_START = /^[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/;
const RELATIVE_START = /^[\w.-]+[/\\]/;
// A shell prompt after a printed path (`PS C:\…>`, `user@host:/…$`,
// `[user@host ~]$`).
const PROMPT_START = /^\s*(?:PS [A-Za-z]:\\|[\w.-]+@[\w.-]+[:~]|\[[\w.-]+@[\w.-]+[\s:\]])/;

interface LogicalLine {
  text: string;
  /** Source row of each UTF-16 unit of `text`. */
  rowOf: number[];
  /** Offset of each unit within its source row's text. */
  localOf: number[];
}

/** A contiguous slice [start, end) of one logical line. */
interface Piece {
  line: number;
  start: number;
  end: number;
}

interface RowContext {
  rows: PathRow[];
  lines: LogicalLine[];
  rowLine: number[];
  cols: number;
}

/** Facts about a chain's first piece that later hops are checked against. */
interface Chain {
  /** Cell length of the first piece. */
  firstCells: number;
  /** Column just past the first piece: the prose wrap edge. */
  edgeCol: number;
}

/**
 * Find path links across a window of rows: soft-wrapped rows are joined
 * into logical lines, and paths that a hard wrap split are chained into one
 * link (see `continuationOf`). A row's own matches that overlap a claimed
 * continuation piece are dropped, so a tail is never a second link.
 */
export function findPathLinksInRows(
  rows: PathRow[],
  cols: number,
  platform: NodeJS.Platform,
): RowPathLink[] {
  const lines: LogicalLine[] = [];
  const rowLine: number[] = [];
  rows.forEach((row, r) => {
    let line = lines[lines.length - 1];
    if (!line || !row.isWrapped) {
      line = { text: '', rowOf: [], localOf: [] };
      lines.push(line);
    }
    rowLine.push(lines.length - 1);
    line.text += row.text;
    for (let i = 0; i < row.text.length; i++) {
      line.rowOf.push(r);
      line.localOf.push(i);
    }
  });

  const ctx: RowContext = { rows, lines, rowLine, cols };
  const claimed: Array<Array<[number, number]>> = lines.map(() => []);
  const out: RowPathLink[] = [];
  lines.forEach((line, li) => {
    for (const m of findPathMatches(line.text, platform)) {
      if (claimed[li].some(([s, e]) => m.start < e && s < m.end)) continue;
      // Judge wraps on the untrimmed token: a wrap can split right after a
      // "." or ":" that trimPunctuation would drop from a finished path.
      let rawEnd = m.end;
      while (rawEnd < line.text.length && PATH_CHAR.test(line.text[rawEnd])) rawEnd++;
      const pieces: Piece[] = [{ line: li, start: m.start, end: rawEnd }];
      let joined = line.text.slice(m.start, rawEnd);
      const chain: Chain = {
        firstCells: pieceCells(ctx, pieces[0]),
        edgeCol: pieceRange(ctx, pieces[0]).endX,
      };
      for (let hop = 1; hop < MAX_WRAP_ROWS; hop++) {
        const next = continuationOf(ctx, pieces[pieces.length - 1], joined, hop === 1, chain);
        if (!next) break;
        pieces.push(next);
        joined += lines[next.line].text.slice(next.start, next.end);
        claimed[next.line].push([next.start, next.end]);
      }
      if (pieces.length === 1) {
        out.push({ text: m.text, ranges: [pieceRange(ctx, { line: li, start: m.start, end: m.end })] });
        continue;
      }
      const text = trimPunctuation(joined);
      // Clip whatever trimming removed off the tail pieces.
      let budget = text.length;
      const ranges: PathLinkRange[] = [];
      for (const p of pieces) {
        const len = Math.min(p.end - p.start, budget);
        if (len <= 0) break;
        ranges.push(pieceRange(ctx, { line: p.line, start: p.start, end: p.start + len }));
        budget -= len;
      }
      out.push({ text, ranges });
    }
  });
  return out;
}

/**
 * The next row's piece of a path Ink hard-wrapped after `piece`, or null.
 * `joined` is the path text so far. A false join opens the wrong target
 * while a miss only loses a click, so every hop is strict:
 *   • the fragment must pass `continuesPath` (path-shaped, not an absolute
 *     path or a second filename of its own);
 *   • first hop: wrap-ansi (`hard`) only splits a token longer than the
 *     width it wraps to, so first piece + fragment must exceed that width;
 *   • later hops: the row being continued is itself a fragment, and a real
 *     hard break fills it from the content start to the right edge.
 * Shapes:
 *   • Table cell: the piece ends with ≤ TABLE_MAX_PADDING spaces before a
 *     `│` (so it fills the cell); the next row has `│` at the same columns
 *     as this cell's left and right borders, which also proves no `├──┼`
 *     rule sits between the rows, and its content starts at the same column
 *     as this cell's content. Width = border to border minus 1 padding each
 *     side. Rich tables have no rule between data rows, so the fragment
 *     checks are what keep two rows' paths apart.
 *   • Prose: the piece is the row's last token and ends within
 *     EDGE_SLACK_COLS of the terminal edge (later hops: exactly at the first
 *     piece's edge); the next row is not a prompt and its first token after
 *     the indent is not a box/gutter glyph. Width = cols minus that indent.
 */
function continuationOf(
  ctx: RowContext,
  piece: Piece,
  joined: string,
  firstHop: boolean,
  chain: Chain,
): Piece | null {
  const line = ctx.lines[piece.line];
  const r = line.rowOf[piece.end - 1];
  const row = ctx.rows[r];
  const next = ctx.rows[r + 1];
  // A soft-wrapped next row is already part of this logical line.
  if (!next || next.isWrapped) return null;
  const nextLine = ctx.rowLine[r + 1];
  const end = line.localOf[piece.end - 1] + 1;

  let k = end;
  while (k - end < TABLE_MAX_PADDING && row.text[k] === ' ') k++;
  if (row.text[k] === TABLE_BORDER) {
    if (line.rowOf[piece.start] !== r) return null;
    const left = row.text.lastIndexOf(TABLE_BORDER, line.localOf[piece.start] - 1);
    if (left < 0) return null;
    let content = left + 1;
    while (row.text[content] === ' ') content++;
    const nl = next.cellX.indexOf(row.cellX[left]);
    const nr = next.cellX.indexOf(row.cellX[k]);
    if (nl < 0 || nr < 0 || next.text[nl] !== TABLE_BORDER || next.text[nr] !== TABLE_BORDER) {
      return null;
    }
    let j = nl + 1;
    while (j < nr && next.text[j] === ' ') j++;
    if (j >= nr || next.cellX[j] !== row.cellX[content]) return null;
    let e = j;
    while (e < nr && PATH_CHAR.test(next.text[e])) e++;
    // The run must be the whole cell content: an internal space means words.
    if (e === j || next.text.slice(e, nr).trim() !== '') return null;
    if (!continuesPath(joined, next.text.slice(j, e))) return null;
    // Row r + 1 starts its logical line, so row offsets are line offsets.
    const fragment = { line: nextLine, start: j, end: e };
    // Later hops: the padding check above already proved this row full.
    const width = row.cellX[k] - row.cellX[left] - 3;
    if (firstHop && chain.firstCells + pieceCells(ctx, fragment) <= width) return null;
    return fragment;
  }

  if (row.text.slice(end).trim() !== '') return null;
  const endCol = row.cellX[end];
  if (firstHop ? ctx.cols - endCol > EDGE_SLACK_COLS : endCol !== chain.edgeCol) return null;
  const text = ctx.lines[nextLine].text;
  if (PROMPT_START.test(text)) return null;
  let j = 0;
  while (text[j] === ' ') j++;
  if (j >= text.length || BLOCK_START.test(text[j])) return null;
  let e = j;
  while (e < text.length && PATH_CHAR.test(text[e])) e++;
  if (e === j || !continuesPath(joined, text.slice(j, e))) return null;
  const fragment = { line: nextLine, start: j, end: e };
  const width = ctx.cols - next.cellX[j];
  if (firstHop && chain.firstCells + pieceCells(ctx, fragment) <= width) return null;
  return fragment;
}

/** Whether `fragment` (a row's first token) can be the next piece of path `joined`. */
function continuesPath(joined: string, fragment: string): boolean {
  if (ABSOLUTE_START.test(fragment) || BRACKET.test(fragment)) return false;
  if (FINISHED_EXT.test(joined) && (FILENAME_START.test(fragment) || RELATIVE_START.test(fragment))) {
    return false;
  }
  // A split extension ("…/foo.c" + "pp") is a miss: it cannot be told apart
  // from "…/a.md" + "it".
  return PATH_PIECE.test(fragment);
}

/** Cell length of a piece (a soft-wrapped piece counts every row it spans). */
function pieceCells(ctx: RowContext, piece: Piece): number {
  const r = pieceRange(ctx, piece);
  if (r.startRow === r.endRow) return r.endX - r.startX + 1;
  return ctx.cols - r.startX + 1 + (r.endRow - r.startRow - 1) * ctx.cols + r.endX;
}

function pieceRange(ctx: RowContext, piece: Piece): PathLinkRange {
  const line = ctx.lines[piece.line];
  const startRow = line.rowOf[piece.start];
  const endRow = line.rowOf[piece.end - 1];
  return {
    startRow,
    startX: ctx.rows[startRow].cellX[line.localOf[piece.start]] + 1,
    endRow,
    // Column just past the last cell, 0-based == the last cell, 1-based.
    endX: ctx.rows[endRow].cellX[line.localOf[piece.end - 1] + 1],
  };
}

/** Read an xterm row into a `PathRow` (the inverse of xterm's cell layout). */
function readRow(line: IBufferLine, cols: number): PathRow {
  let text = '';
  const cellX: number[] = [];
  let used = 0;
  let usedCol = 0;
  let cell: IBufferCell | undefined;
  const width = Math.min(line.length, cols);
  for (let x = 0; x < width; x++) {
    cell = line.getCell(x, cell);
    if (!cell) break;
    const w = cell.getWidth();
    if (w === 0) continue; // right half of a wide char
    const chars = cell.getChars();
    const s = chars || ' ';
    for (let i = 0; i < s.length; i++) cellX.push(x);
    text += s;
    if (chars) {
      used = text.length;
      usedCol = x + w;
    }
  }
  // Drop never-written trailing cells, as translateToString(true) does.
  cellX.length = used;
  cellX.push(usedCol);
  return { text: text.slice(0, used), cellX, isWrapped: line.isWrapped };
}

/**
 * Build an xterm ILinkProvider that opens absolute paths via the provided
 * `openPath` callback (typically `window.electronAPI.shell.openPath`).
 *
 * `platform` selects the matcher set (Windows-aware on win32). Defaults to
 * `process.platform` when available, otherwise 'linux' — which still
 * detects Windows drive paths, just without UNC support.
 */
export function createPathLinkProvider(
  terminal: Terminal,
  openPath: (filePath: string) => void,
  platform: NodeJS.Platform = (typeof process !== 'undefined' && process.platform) || 'linux',
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      // xterm passes 1-based line numbers; getLine wants 0-based.
      const y = bufferLineNumber - 1;
      if (!buffer.getLine(y)) {
        callback(undefined);
        return;
      }
      // Read a window around the row: back far enough to see a hard-wrap
      // chain that reaches this row, ahead far enough to finish one that
      // passes through it. Both edges widen (bounded) to whole soft-wrapped
      // logical lines so a window edge never starts mid-path.
      let first = Math.max(0, y - MAX_WRAP_ROWS);
      for (let n = 0; n < MAX_WRAP_ROWS && first > 0 && buffer.getLine(first)?.isWrapped; n++) first--;
      const last = y + MAX_WRAP_ROWS;
      const rows: PathRow[] = [];
      for (let i = first; i <= last + MAX_WRAP_ROWS; i++) {
        const line = buffer.getLine(i);
        if (!line || (i > last && !line.isWrapped)) break;
        rows.push(readRow(line, terminal.cols));
      }
      const target = y - first;
      const links: ILink[] = [];
      for (const found of findPathLinksInRows(rows, terminal.cols, platform)) {
        for (const range of found.ranges) {
          // Only pieces on this row; other rows are asked for separately.
          if (range.startRow > target || range.endRow < target) continue;
          links.push({
            // xterm coordinates are 1-based; range.end is inclusive (the
            // last cell containing the link, not one past it).
            range: {
              start: { x: range.startX, y: range.startRow + first + 1 },
              end: { x: range.endX, y: range.endRow + first + 1 },
            },
            text: found.text,
            activate: () => openPath(found.text),
          });
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
