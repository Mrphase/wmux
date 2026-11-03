import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/Layout/AppLayout.tsx'),
  'utf8',
);

describe('AppLayout agent-toolbar strip', () => {
  it('never intercepts clicks on the panes underneath', () => {
    // The strip spans the bottom 40px of the whole pane column. Without
    // pointer-events-none it swallowed clicks on the bottom pane rows — the
    // terminal's scroll-to-bottom button sits exactly there and stopped working.
    const attr = source.indexOf('data-agent-toolbar-strip');
    const open = source.lastIndexOf('<div', attr);
    expect(attr).toBeGreaterThan(-1);
    expect(source.slice(open, attr)).toMatch(/className="[^"]*\bpointer-events-none\b[^"]*"/);
  });
});
