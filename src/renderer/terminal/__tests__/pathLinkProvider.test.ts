/**
 * Tests for `findPathMatches` and `createPathLinkProvider`.
 *
 * The matcher is the source of truth for which characters in a terminal
 * line are "a clickable path". It must:
 *   • detect absolute Windows / UNC / POSIX paths
 *   • strip trailing punctuation + source-location suffixes (`:42`, `:42:10`)
 *   • ignore relative paths, time strings, URL path components
 *   • be stable across repeated calls (no regex state bleed)
 *
 * The thin xterm wrapper (`createPathLinkProvider`) just maps matches into
 * ILink ranges, so we only test the matcher heavily and smoke-test the
 * provider for coordinate translation + range correctness.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  findPathMatches,
  findPathLinksInRows,
  createPathLinkProvider,
  type PathRow,
} from '../pathLinkProvider';

/** Terminal cell width of one code point: 2 for CJK / fullwidth, else 1. */
function charWidth(ch: string): number {
  return /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
    ? 2
    : 1;
}

/** Build a `PathRow` the way the xterm adapter does (wide chars take 2 cells). */
function row(text: string, isWrapped = false): PathRow {
  const cellX: number[] = [];
  let x = 0;
  for (const ch of text) {
    for (let i = 0; i < ch.length; i++) cellX.push(x);
    x += charWidth(ch);
  }
  cellX.push(x);
  return { text, cellX, isWrapped };
}

/** `│ a │ b │` with each cell padded to a display width (1-space padding each side). */
function tableRow(cells: string[], widths: number[]): string {
  const pad = (s: string, w: number) =>
    s + ' '.repeat(w - [...s].reduce((n, ch) => n + charWidth(ch), 0));
  return '│' + cells.map((c, i) => ` ${pad(c, widths[i])} │`).join('');
}

// Claude Code markdown table whose 2nd and 3rd cells hard-wrap a path.
// Cells: 0 `│`, 1-10 cell 1 (CJK), 11 `│`, 13-71 path 1, 73 `│`,
// 75-121 path 2, 123 `│` (0-based).
const TABLE_WIDTHS = [8, 59, 47];
const TABLE_ROWS = [
  tableRow(
    [
      '晨报',
      '\\\\gaming-sh01-lnx\\workspace\\zehuixie\\D_code2\\Workload-predi',
      '/local/mnt/workspace/zehuixie/Workload-predicti',
    ],
    TABLE_WIDTHS,
  ),
  tableRow(
    ['', 'ction\\runs\\night\\20261103_ipc_link\\MORNING_REPORT.md', 'on/runs_night/x.log'],
    TABLE_WIDTHS,
  ),
];
const TABLE_PATH_1 =
  '\\\\gaming-sh01-lnx\\workspace\\zehuixie\\D_code2\\Workload-prediction\\runs\\night\\20261103_ipc_link\\MORNING_REPORT.md';
const TABLE_PATH_2 = '/local/mnt/workspace/zehuixie/Workload-prediction/runs_night/x.log';

describe('findPathMatches', () => {
  describe('Windows drive paths', () => {
    it('matches a bare drive path', () => {
      const matches = findPathMatches('C:\\Users\\rizz\\file.txt', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('C:\\Users\\rizz\\file.txt');
    });

    it('matches a forward-slash drive path', () => {
      const matches = findPathMatches('see c:/foo/bar.log for details', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('c:/foo/bar.log');
    });

    it('strips trailing period', () => {
      const matches = findPathMatches('Open C:\\Users\\rizz\\file.txt.', 'win32');
      expect(matches[0].text).toBe('C:\\Users\\rizz\\file.txt');
    });

    it('strips trailing comma + period combo', () => {
      const matches = findPathMatches('open C:\\foo\\bar.ts,.', 'win32');
      expect(matches[0].text).toBe('C:\\foo\\bar.ts');
    });

    it('strips source-location suffix `:42`', () => {
      const matches = findPathMatches('Error at D:\\wmux\\src\\index.ts:42', 'win32');
      expect(matches[0].text).toBe('D:\\wmux\\src\\index.ts');
    });

    it('strips source-location suffix `:42:10`', () => {
      const matches = findPathMatches('Error at D:\\wmux\\src\\index.ts:42:10', 'win32');
      expect(matches[0].text).toBe('D:\\wmux\\src\\index.ts');
    });

    it('handles wrapped (parens) source location', () => {
      const matches = findPathMatches('(see D:\\wmux\\src\\foo.ts:42)', 'win32');
      expect(matches[0].text).toBe('D:\\wmux\\src\\foo.ts');
    });

    it('strips multi-segment numeric trailer (semver-shaped, e.g. :1.2.3)', () => {
      // SOURCE_LOCATION_SUFFIX peels one `:NNN` at a time. The fixed-point
      // loop in trimPunctuation must keep iterating until nothing changes,
      // otherwise a path with a semver-shaped trailer keeps a stray `:N`
      // at the end and openPath rejects it.
      const matches = findPathMatches('release D:\\dist\\app.json:1.2.3', 'win32');
      expect(matches[0].text).toBe('D:\\dist\\app.json');
    });
  });

  describe('Windows UNC paths', () => {
    it('matches a basic UNC share', () => {
      const matches = findPathMatches('check \\\\server\\share\\file.txt', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('\\\\server\\share\\file.txt');
    });

    it('matches a hyphenated server name', () => {
      const matches = findPathMatches('\\\\file-srv-01\\share', 'win32');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('\\\\file-srv-01\\share');
    });
  });

  describe('POSIX paths', () => {
    it('matches a basic absolute path', () => {
      const matches = findPathMatches('see /etc/hosts for the entry', 'linux');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('/etc/hosts');
    });

    it('matches a home-dir-style path', () => {
      const matches = findPathMatches('open /home/rizz/.config/wmux/config.json', 'linux');
      expect(matches[0].text).toBe('/home/rizz/.config/wmux/config.json');
    });

    it('strips trailing period in prose', () => {
      const matches = findPathMatches('look at /var/log/syslog.', 'linux');
      expect(matches[0].text).toBe('/var/log/syslog');
    });

    it('does not match the path component of an http URL', () => {
      // POSIX rule requires a word boundary before `/`. http://host/path
      // has no whitespace before the second slash, so we expect zero hits.
      const matches = findPathMatches('see http://example.com/some/path here', 'linux');
      expect(matches).toHaveLength(0);
    });

    it('does not match plain time strings', () => {
      const matches = findPathMatches('meeting at 12:34 today', 'linux');
      expect(matches).toHaveLength(0);
    });

    it('does not match a bare slash', () => {
      const matches = findPathMatches('a / b', 'linux');
      expect(matches).toHaveLength(0);
    });
  });

  describe('multiple matches', () => {
    it('returns matches in order', () => {
      const matches = findPathMatches(
        'cp /etc/hosts /tmp/hosts.bak',
        'linux',
      );
      expect(matches.map((m) => m.text)).toEqual(['/etc/hosts', '/tmp/hosts.bak']);
      expect(matches[0].start).toBeLessThan(matches[1].start);
    });

    it('mixes Windows + POSIX paths on win32 host', () => {
      const matches = findPathMatches(
        'src D:\\foo\\a.ts dst /tmp/x',
        'win32',
      );
      expect(matches.map((m) => m.text)).toEqual(['D:\\foo\\a.ts', '/tmp/x']);
    });

    it('handles two UNC paths on the same line (dedupe stays ordered)', () => {
      const matches = findPathMatches(
        '\\\\srv-a\\share\\one \\\\srv-b\\share\\two',
        'win32',
      );
      expect(matches.map((m) => m.text)).toEqual([
        '\\\\srv-a\\share\\one',
        '\\\\srv-b\\share\\two',
      ]);
    });

    it('does not match the path component of a file:// URI', () => {
      // POSIX matcher's lookbehind requires whitespace / quote / paren /
      // angle before the `/`. The `:` in `file:` falls outside that set,
      // so we expect zero hits — the URI is left for WebLinksAddon to
      // handle if it recognises file://.
      const matches = findPathMatches('see file:///etc/hosts please', 'linux');
      expect(matches).toHaveLength(0);
    });
  });

  describe('regex state stability', () => {
    // Module-scoped regex instances retain `lastIndex`. The implementation
    // must reset it; otherwise the second call could miss matches near
    // the start of the line.
    it('returns identical results on repeated calls with the same input', () => {
      const input = 'cp /etc/hosts /tmp/x';
      const first = findPathMatches(input, 'linux');
      const second = findPathMatches(input, 'linux');
      expect(second).toEqual(first);
    });

    it('finds match at offset 0 after a prior longer call', () => {
      findPathMatches('xxxxxxxxxxxxxxxxxxxx /etc/hosts xxxxxxxxxxxx', 'linux');
      const matches = findPathMatches('/etc/hosts', 'linux');
      expect(matches).toHaveLength(1);
      expect(matches[0].start).toBe(0);
    });
  });

  describe('range correctness', () => {
    it('reports start/end aligned with the cleaned path', () => {
      const input = 'open /etc/hosts.';
      const matches = findPathMatches(input, 'linux');
      expect(matches[0].start).toBe(5);
      expect(matches[0].end).toBe(15); // /etc/hosts (10 chars), 5..15
      expect(input.slice(matches[0].start, matches[0].end)).toBe('/etc/hosts');
    });
  });

  describe('edge cases', () => {
    it('returns empty for empty input', () => {
      expect(findPathMatches('', 'linux')).toEqual([]);
    });

    it('returns empty for a single drive letter (no slash)', () => {
      expect(findPathMatches('C:', 'win32')).toEqual([]);
    });

    it('does not match a relative path', () => {
      expect(findPathMatches('foo/bar.txt', 'linux')).toEqual([]);
      expect(findPathMatches('./foo/bar.txt', 'linux')).toEqual([]);
    });
  });

  describe('CJK punctuation', () => {
    it('stops a UNC path at a fullwidth paren glued onto it', () => {
      const matches = findPathMatches(
        '已打包 \\\\happy\\QCT_ECOSYSTEM\\diag\\gameskill_diag_1102.zip（15 KB）',
        'win32',
      );
      expect(matches.map((m) => m.text)).toEqual([
        '\\\\happy\\QCT_ECOSYSTEM\\diag\\gameskill_diag_1102.zip',
      ]);
    });

    it('stops drive and POSIX paths at CJK commas, colons and ideographic space', () => {
      expect(findPathMatches('见 C:\\foo\\bar.txt，然后', 'win32')[0].text).toBe('C:\\foo\\bar.txt');
      expect(findPathMatches('in /etc/hosts。下一步', 'linux')[0].text).toBe('/etc/hosts');
      expect(findPathMatches('in /etc/hosts：ok', 'linux')[0].text).toBe('/etc/hosts');
      expect(findPathMatches('in /etc/hosts\u3000ok', 'linux')[0].text).toBe('/etc/hosts');
    });
  });
});

describe('findPathLinksInRows', () => {
  it('joins a Claude Code table cell that hard-wraps a path, in cell columns', () => {
    const links = findPathLinksInRows(TABLE_ROWS.map((t) => row(t)), 130, 'win32');
    expect(links).toEqual([
      {
        text: TABLE_PATH_1,
        ranges: [
          { startRow: 0, startX: 14, endRow: 0, endX: 72 },
          { startRow: 1, startX: 14, endRow: 1, endX: 65 },
        ],
      },
      {
        text: TABLE_PATH_2,
        ranges: [
          { startRow: 0, startX: 76, endRow: 0, endX: 122 },
          { startRow: 1, startX: 76, endRow: 1, endX: 94 },
        ],
      },
    ]);
  });

  it('does not join a table cell across a separator row', () => {
    const top = tableRow(['\\\\srv\\share\\abcdef'], [18]);
    const sep = '├' + '─'.repeat(20) + '┤';
    const links = findPathLinksInRows([row(top), row(sep)], 80, 'win32');
    expect(links).toEqual([
      { text: '\\\\srv\\share\\abcdef', ranges: [{ startRow: 0, startX: 3, endRow: 0, endX: 20 }] },
    ]);
  });

  it('does not join a table path that ends well before the border', () => {
    const rows = [
      row(tableRow(['/etc/hosts'], [16])),
      row(tableRow(['tail'], [16])),
    ];
    const links = findPathLinksInRows(rows, 80, 'linux');
    expect(links.map((l) => l.text)).toEqual(['/etc/hosts']);
  });

  it('joins a prose path hard-wrapped at the right edge', () => {
    // "结果: " is 6 cells, the 33-char piece fills cells 6-38 of 40.
    const rows = [
      row('结果: /local/mnt/workspace/zehuixie/run'),
      row('  s/night/20261103/report.md 已生成'),
    ];
    const links = findPathLinksInRows(rows, 40, 'linux');
    expect(links).toEqual([
      {
        text: '/local/mnt/workspace/zehuixie/runs/night/20261103/report.md',
        ranges: [
          { startRow: 0, startX: 7, endRow: 0, endX: 39 },
          { startRow: 1, startX: 3, endRow: 1, endX: 28 },
        ],
      },
    ]);
  });

  it('allows up to 3 columns of slack at the right edge, not 4', () => {
    const rows = [row('see /local/mnt/a'), row('bcdefghij/d.txt')]; // path ends at cell 16
    expect(findPathLinksInRows(rows, 19, 'linux').map((l) => l.text)).toEqual([
      '/local/mnt/abcdefghij/d.txt',
    ]);
    expect(findPathLinksInRows(rows, 20, 'linux').map((l) => l.text)).toEqual(['/local/mnt/a']);
  });

  it('joins only a token longer than the wrap width (wrap-ansi splits nothing shorter)', () => {
    // The 12-cell piece ends at the edge of 16 columns.
    const join = (tail: string) =>
      findPathLinksInRows([row('see /local/mnt/a'), row(tail)], 16, 'linux').map((l) => l.text);
    expect(join('b/c')).toEqual(['/local/mnt/a']); // 15 ≤ 16
    expect(join('b/cd')).toEqual(['/local/mnt/a']); // 16 ≤ 16, no slack
    expect(join('b/cde')).toEqual(['/local/mnt/ab/cde']); // 17 > 16
    expect(join('   b/c')).toEqual(['/local/mnt/ab/c']); // 15 > 16 - 3 indent
  });

  it('does not join a prose path that ends well before the edge', () => {
    const links = findPathLinksInRows([row('see /etc/hosts'), row('/tmp/x')], 80, 'linux');
    expect(links.map((l) => l.text)).toEqual(['/etc/hosts', '/tmp/x']);
  });

  it('does not join onto a row that opens with a box or gutter glyph', () => {
    const rows = [row('see /local/mnt/a'), row('⏺ next message')];
    expect(findPathLinksInRows(rows, 16, 'linux').map((l) => l.text)).toEqual(['/local/mnt/a']);
  });

  it('joins a soft-wrapped path into one multi-row range', () => {
    const rows = [row('open /local/mnt/work'), row('space/a.txt done', true)];
    expect(findPathLinksInRows(rows, 20, 'linux')).toEqual([
      {
        text: '/local/mnt/workspace/a.txt',
        ranges: [{ startRow: 0, startX: 6, endRow: 1, endX: 11 }],
      },
    ]);
  });

  it('trims punctuation off the joined path, not each piece', () => {
    // The wrap lands right after "." — the first piece keeps it, the tail
    // "2/notes.txt." loses its trailing period.
    const rows = [row('see /local/mnt/v1.'), row('2/notes.txt.')];
    const links = findPathLinksInRows(rows, 18, 'linux');
    expect(links).toEqual([
      {
        text: '/local/mnt/v1.2/notes.txt',
        ranges: [
          { startRow: 0, startX: 5, endRow: 0, endX: 18 },
          { startRow: 1, startX: 1, endRow: 1, endX: 11 },
        ],
      },
    ]);
  });

  it('joins a 3-row path cell in a Claude table with per-row rules', () => {
    // Live shape: 2-column indent, a ├┼┤ rule after every data row.
    const path = '\\\\srv\\share\\quality\\IDF_Quality_SinkTieredEncoding\\2026-09-26_review.pptx';
    const chunks = [path.slice(0, 30), path.slice(30, 60), path.slice(60)];
    const rule = '  ├' + '─'.repeat(10) + '┼' + '─'.repeat(32) + '┼' + '─'.repeat(5) + '┤';
    const rows = [
      rule,
      '  ' + tableRow(['Quality', chunks[0], '17'], [8, 30, 3]),
      '  ' + tableRow(['', chunks[1], ''], [8, 30, 3]),
      '  ' + tableRow(['', chunks[2], ''], [8, 30, 3]),
      rule,
    ];
    expect(findPathLinksInRows(rows.map((t) => row(t)), 120, 'win32')).toEqual([
      {
        text: path,
        ranges: [
          { startRow: 1, startX: 16, endRow: 1, endX: 45 },
          { startRow: 2, startX: 16, endRow: 2, endX: 45 },
          { startRow: 3, startX: 16, endRow: 3, endX: 28 },
        ],
      },
    ]);
  });

  it('joins a prose wrap that lands mid-name', () => {
    const rep = '  /local/mnt/workspace/zehuixie/MORNING_REP';
    expect(findPathLinksInRows([row(rep), row('  ORT.md done')], rep.length, 'linux').map((l) => l.text))
      .toEqual(['/local/mnt/workspace/zehuixie/MORNING_REPORT.md']);
  });

  describe('false-join regressions (each row keeps its own link)', () => {
    const texts = (rows: string[], cols: number, platform: NodeJS.Platform = 'linux') =>
      findPathLinksInRows(rows.map((t) => row(t)), cols, platform).map((l) => l.text);

    it('find output: consecutive absolute paths at the edge', () => {
      const out = ['a', 'b', 'c'].map((n) => `/local/mnt/workspace/zehuixie/runs/${n}.md`);
      expect(texts(out, 40)).toEqual(out);
    });

    it('prose: sentence after a path ending in "."', () => {
      expect(texts(['see /etc/hosts.', 'Then run it'], 16)).toEqual(['/etc/hosts']);
    });

    it('prose: next list item', () => {
      const top = '  - log: /local/mnt/a.md';
      expect(texts([top, '  - next item'], top.length)).toEqual(['/local/mnt/a.md']);
    });

    it('prose: Ink word wrap, path ends at cols - 2', () => {
      const top = '  the report is at /local/mnt/a.md';
      expect(texts([top, '  and it is ready'], top.length + 2)).toEqual(['/local/mnt/a.md']);
    });

    it('prose: PowerShell prompt after a printed path', () => {
      const cwd = 'C:\\Users\\zehuixie\\project';
      expect(texts([cwd, `PS ${cwd}> dir`], cwd.length, 'win32')).toEqual([cwd, cwd]);
    });

    it('prose: POSIX prompt after a printed path', () => {
      const top = '/local/mnt/workspace/zehuixie/project';
      expect(texts([top, 'zehuixie@host:/local/mnt$ ls'], top.length)).toEqual([top]);
    });

    it('table without separator rows: one path per row', () => {
      const rows = [tableRow(['/var/log/auth.log'], [17]), tableRow(['/var/log/syslog'], [17])];
      expect(texts(rows, 80)).toEqual(['/var/log/auth.log', '/var/log/syslog']);
    });

    it('typer panel: option row under a path that fits its cell', () => {
      const rows = [
        tableRow(['Config dir: /etc/app/conf.d'], [27]),
        tableRow(['--help  Show this message.'], [27]),
      ];
      expect(texts(rows, 80)).toEqual(['/etc/app/conf.d']);
    });

    it('word-wrapped table cell: next word, not a path piece', () => {
      const rows = [tableRow(['see /etc/hosts'], [14]), tableRow(['for details'], [14])];
      expect(texts(rows, 80)).toEqual(['/etc/hosts']);
    });

    it('Rich table (no rule between data rows): path row, then a relative-path row', () => {
      const rows = [
        tableRow(['Path'], [17]),
        '├' + '─'.repeat(19) + '┤',
        tableRow(['/var/log/auth.log'], [17]),
        tableRow(['logs/app.log'], [17]),
      ];
      expect(texts(rows, 80)).toEqual(['/var/log/auth.log']);
    });

    it('table: "(none)" under a path that fills its cell', () => {
      const rows = [tableRow(['/local/mnt/workspace/abc'], [24]), tableRow(['(none)'], [24])];
      expect(texts(rows, 80)).toEqual(['/local/mnt/workspace/abc']);
    });

    it('table: a plain word under a path that fills its cell', () => {
      const rows = [tableRow(['see /etc/hosts'], [14]), tableRow(['configuration'], [14])];
      expect(texts(rows, 80)).toEqual(['/etc/hosts']);
    });

    it('table, 3 rows: a full path row, then "is the report"', () => {
      const rows = [
        tableRow(['\\\\srv\\share\\Workload-predi'], [26]),
        tableRow(['ction\\runs\\night\\REPORT.md'], [26]),
        tableRow(['is the report'], [26]),
      ];
      expect(texts(rows, 80, 'win32')).toEqual([
        '\\\\srv\\share\\Workload-prediction\\runs\\night\\REPORT.md',
      ]);
    });

    it('prose: a finished filename, then another filename', () => {
      const top = '  /local/mnt/workspace/zehuixie/runs/a.md';
      expect(texts([top, 'config.yaml was updated'], top.length)).toEqual([
        '/local/mnt/workspace/zehuixie/runs/a.md',
      ]);
    });

    it('prose: a finished filename, then a compiler diagnostic', () => {
      const top = '  /local/mnt/workspace/zehuixie/runs/a.log';
      const path = '/local/mnt/workspace/zehuixie/runs/a.log';
      expect(texts([top, 'src/main.ts(3,4): error TS2304'], top.length)).toEqual([path]);
      expect(texts([top, 'src/main.ts:3:4 error TS2304'], top.length)).toEqual([path]);
    });

    it('prose: a bracketed bash prompt after a printed path', () => {
      const top = '/local/mnt/workspace/zehuixie/project';
      expect(texts([top, '[zehuixie@host.qualcomm.com ~]$ ls'], top.length)).toEqual([top]);
    });

    it('prose: a split extension is left as a miss ("foo.c" + "pp")', () => {
      const top = '  /local/mnt/workspace/zehuixie/src/foo.c';
      expect(texts([top, '  pp is the file'], top.length)).toEqual([
        '/local/mnt/workspace/zehuixie/src/foo.c',
      ]);
    });

    it('prose: a short word after a row-filling ".md" path ("….md" + "it")', () => {
      const top = '  /local/mnt/workspace/zehuixie/runs/a.md';
      expect(texts([top, 'it is ready'], top.length)).toEqual([
        '/local/mnt/workspace/zehuixie/runs/a.md',
      ]);
    });

    it('prose: an intermediate row that stops short of the edge ends the chain', () => {
      // Row 2 is a tail (ends 2 short of the 20-column edge), so row 3 is not.
      const rows = ['see /local/mnt/aaaaa', 'bbbbbbbbbbb/cccccc', 'dd/e.md'];
      expect(texts(rows, 20)).toEqual(['/local/mnt/aaaaabbbbbbbbbbb/cccccc']);
    });

    it('table: ≥ 2 spaces of padding before the border is not a filled cell', () => {
      // Same split as the real example, but the 26-cell path sits in a
      // 27-wide cell, leaving 2 spaces before the border.
      const rows = [
        tableRow(['\\\\srv\\share\\Workload-predi'], [27]),
        tableRow(['ction\\runs\\night\\MORNING_REPORT.md'.slice(0, 26)], [27]),
      ];
      expect(texts(rows, 80, 'win32')).toEqual(['\\\\srv\\share\\Workload-predi']);
    });
  });
});

describe('createPathLinkProvider', () => {
  /**
   * Minimal xterm Terminal stub. The provider only touches `cols`,
   * `buffer.active.getLine(n)` and, per line, `isWrapped`, `length` and
   * `getCell(x)` (`getWidth` / `getChars`), so a stub is faster + clearer
   * than mocking the full xterm interface. Wide chars get a width-0 spacer
   * cell after them, like xterm's buffer.
   */
  function makeTerminal(lines: { text: string; wrapped?: boolean }[], cols = 80) {
    return {
      cols,
      buffer: {
        active: {
          getLine: (i: number) => {
            const l = lines[i];
            if (!l) return undefined;
            const cells: { chars: string; width: number }[] = [];
            for (const ch of l.text) {
              const width = charWidth(ch);
              cells.push({ chars: ch, width });
              if (width === 2) cells.push({ chars: '', width: 0 });
            }
            return {
              isWrapped: !!l.wrapped,
              length: cells.length,
              getCell: (x: number) => {
                const c = cells[x];
                return c && { getWidth: () => c.width, getChars: () => c.chars };
              },
            };
          },
        },
      },
    } as unknown as import('@xterm/xterm').Terminal;
  }

  it('emits one link per match with 1-based xterm coordinates', () => {
    const terminal = makeTerminal([{ text: 'open /etc/hosts here' }]);
    const openPath = vi.fn();
    const provider = createPathLinkProvider(terminal, openPath, 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);

    expect(cb).toHaveBeenCalledTimes(1);
    const links = cb.mock.calls[0][0];
    expect(links).toHaveLength(1);
    // /etc/hosts starts at offset 5 (0-based) → xterm x=6 (1-based).
    expect(links[0].range.start).toEqual({ x: 6, y: 1 });
    // end is inclusive; /etc/hosts is 10 chars long ending at offset 15
    // (exclusive) → inclusive last cell = 15.
    expect(links[0].range.end).toEqual({ x: 15, y: 1 });
    expect(links[0].text).toBe('/etc/hosts');
  });

  it('joins a soft-wrapped path into one multi-row link from either row', () => {
    const terminal = makeTerminal(
      [{ text: 'open /local/mnt/work' }, { text: 'space/a.txt done', wrapped: true }],
      20,
    );
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    for (const row of [1, 2]) {
      const cb = vi.fn();
      provider.provideLinks(row, cb);
      const links = cb.mock.calls[0][0];
      // One link only: the wrapped row's "space/a.txt" is not a second match.
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe('/local/mnt/workspace/a.txt');
      expect(links[0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 11, y: 2 } });
    }
  });

  it('uses cell columns, not string offsets, after wide chars', () => {
    // "晨报" is 2 UTF-16 units but 4 cells, so the path starts at cell 10
    // (1-based), not at string offset 8 + 1.
    const terminal = makeTerminal([{ text: '│ 晨报 │ /etc/hosts │' }]);
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);
    const links = cb.mock.calls[0][0];
    expect(links).toHaveLength(1);
    expect(links[0].range).toEqual({ start: { x: 10, y: 1 }, end: { x: 19, y: 1 } });
  });

  it('emits per-row table pieces that all open the joined path', () => {
    const openPath = vi.fn();
    const terminal = makeTerminal(TABLE_ROWS.map((text) => ({ text })), 130);
    const provider = createPathLinkProvider(terminal, openPath, 'win32');

    const row1 = vi.fn();
    provider.provideLinks(1, row1);
    const top = row1.mock.calls[0][0];
    expect(top.map((l: { range: unknown }) => l.range)).toEqual([
      { start: { x: 14, y: 1 }, end: { x: 72, y: 1 } },
      { start: { x: 76, y: 1 }, end: { x: 122, y: 1 } },
    ]);

    const row2 = vi.fn();
    provider.provideLinks(2, row2);
    const bottom = row2.mock.calls[0][0];
    expect(bottom.map((l: { range: unknown }) => l.range)).toEqual([
      { start: { x: 14, y: 2 }, end: { x: 65, y: 2 } },
      { start: { x: 76, y: 2 }, end: { x: 94, y: 2 } },
    ]);
    expect(bottom.map((l: { text: string }) => l.text)).toEqual([TABLE_PATH_1, TABLE_PATH_2]);

    bottom[0].activate({} as unknown as MouseEvent, bottom[0].text);
    expect(openPath).toHaveBeenCalledWith(TABLE_PATH_1);
  });

  it('finds a continuation piece on row N for a chain that began rows earlier', () => {
    // Three-row prose chain; asking only for row 3 must still resolve the
    // whole path from row 1.
    const openPath = vi.fn();
    const terminal = makeTerminal(
      [
        { text: 'out: /local/mnt/workspace/aaaaaaaaaa' }, // 36 cells
        { text: '  ' + 'b'.repeat(29) + '/cccc' }, // 36 cells
        { text: '  c/report.md written' },
      ],
      36,
    );
    const provider = createPathLinkProvider(terminal, openPath, 'linux');
    const cb = vi.fn();
    provider.provideLinks(3, cb);
    const links = cb.mock.calls[0][0];
    expect(links).toHaveLength(1);
    expect(links[0].range).toEqual({ start: { x: 3, y: 3 }, end: { x: 13, y: 3 } });
    links[0].activate({} as unknown as MouseEvent, links[0].text);
    expect(openPath).toHaveBeenCalledWith(
      `/local/mnt/workspace/aaaaaaaaaa${'b'.repeat(29)}/ccccc/report.md`,
    );
  });

  it('passes undefined when the line is empty', () => {
    const terminal = makeTerminal([{ text: '' }]);
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);
    expect(cb).toHaveBeenCalledWith(undefined);
  });

  it('passes undefined when getLine returns nothing (line past the buffer)', () => {
    const terminal = makeTerminal([]);
    const provider = createPathLinkProvider(terminal, vi.fn(), 'linux');
    const cb = vi.fn();
    provider.provideLinks(999, cb);
    expect(cb).toHaveBeenCalledWith(undefined);
  });

  it('activate() forwards the cleaned path to openPath', () => {
    const terminal = makeTerminal([{ text: 'see /var/log/syslog.' }]);
    const openPath = vi.fn();
    const provider = createPathLinkProvider(terminal, openPath, 'linux');
    const cb = vi.fn();
    provider.provideLinks(1, cb);
    const link = cb.mock.calls[0][0][0];
    // MouseEvent is a DOM type; vitest's default node env doesn't provide
    // it. The provider's `activate` ignores the event arg, so an empty
    // object is fine for the test.
    link.activate({} as unknown as MouseEvent, link.text);
    expect(openPath).toHaveBeenCalledWith('/var/log/syslog');
  });
});
