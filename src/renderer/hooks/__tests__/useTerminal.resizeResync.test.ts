import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('resize snapshot resync', () => {
  it('debounces resync and waits for the confirmed resize RPC', () => {
    expect(source).toMatch(/RESIZE_RESYNC_DEBOUNCE_MS = 350/);

    const start = source.indexOf('const scheduleResizeResync =');
    const end = source.indexOf('// The container-resize fit', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    expect(block).toMatch(/isDaemonModeActive\(\)/);
    expect(block).toMatch(/window\.electronAPI\.pty\.resize\(targetPtyId, cols, rows\)\.then/);
    expect(block).toMatch(/startResync\('resize-layout'\)/);
    expect(block).toMatch(/RESIZE_RESYNC_DEBOUNCE_MS/);
  });

  it('queues the snapshot only after an actual geometry change and cancels it on teardown', () => {
    const fitStart = source.indexOf('const runFit = () => {');
    const fitEnd = source.indexOf('const autoCopy = createAutoSelectionCopy', fitStart);
    const fitBlock = source.slice(fitStart, fitEnd);
    expect(fitBlock).toMatch(/scheduleResizeResync\(currentPtyId, cols, rows\)/);
    expect(source).toMatch(/if \(resizeResyncTimer\) clearTimeout\(resizeResyncTimer\);/);
  });
});