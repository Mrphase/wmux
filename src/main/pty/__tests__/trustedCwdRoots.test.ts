import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTrustedUncCwd, setTrustedCwdRoots, getTrustedCwdRoots } from '../trustedCwdRoots';
import { cwdFallbackFrom, resetUnreachableCwdCache, validatePtyCwd, waitForTrustedUncCwds } from '../resolvePtyCwd';

const ROOT = '\\\\gaming-sh01-lnx\\workspace\\zehuixie';

afterEach(() => {
  vi.restoreAllMocks();
  setTrustedCwdRoots([]);
  resetUnreachableCwdCache();
});

describe('trusted cwd roots', () => {
  it('keeps only full \\\\server\\share roots, normalised', () => {
    setTrustedCwdRoots([`${ROOT}\\`, '\\\\server', '\\\\', 'C:\\local', 42, '//srv/share/']);
    expect(getTrustedCwdRoots()).toEqual([ROOT.toLowerCase(), '\\\\srv\\share']);
  });

  it('clears on a non-array value', () => {
    setTrustedCwdRoots([ROOT]);
    setTrustedCwdRoots('nope');
    expect(getTrustedCwdRoots()).toEqual([]);
  });

  it('matches the root and paths under it, case-insensitively, on a separator boundary', () => {
    setTrustedCwdRoots(['\\\\srv\\share']);
    expect(isTrustedUncCwd('\\\\srv\\share')).toBe(true);
    expect(isTrustedUncCwd('\\\\SRV\\Share\\proj\\x')).toBe(true);
    expect(isTrustedUncCwd('\\\\srv\\share2')).toBe(false);
    expect(isTrustedUncCwd('\\\\srv\\other')).toBe(false);
    expect(isTrustedUncCwd('C:\\srv\\share')).toBe(false);
  });
});

describe('validatePtyCwd with trusted UNC roots', () => {
  it('stats and accepts a trusted UNC directory, still rejects untrusted ones without a stat', () => {
    if (process.platform !== 'win32') return;
    setTrustedCwdRoots([ROOT]);
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as fs.Stats);
    expect(validatePtyCwd(`${ROOT}\\EnvSync`)).toBe(`${ROOT}\\EnvSync`);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(validatePtyCwd('\\\\other\\share\\x')).toBeUndefined();
    expect(stat).toHaveBeenCalledTimes(1);
  });
});

describe('waitForTrustedUncCwds', () => {
  it('returns at once when no candidate is trusted', async () => {
    const stat = vi.fn(async () => false);
    await waitForTrustedUncCwds(['\\\\other\\share', 'C:\\x', undefined], { stat });
    expect(stat).not.toHaveBeenCalled();
  });

  it('retries a trusted share until it answers', async () => {
    if (process.platform !== 'win32') return;
    setTrustedCwdRoots([ROOT]);
    const stat = vi.fn<(p: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await waitForTrustedUncCwds([`${ROOT}\\EnvSync`], { stat, delayMs: 1, deadlineMs: 1000 });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline and then rejects the share without a sync stat', async () => {
    if (process.platform !== 'win32') return;
    setTrustedCwdRoots([ROOT]);
    const stat = vi.fn(async () => false);
    await waitForTrustedUncCwds([`${ROOT}\\EnvSync`], { stat, delayMs: 5, deadlineMs: 12 });
    expect(stat.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(3);
    const sync = vi.spyOn(fs, 'statSync');
    expect(validatePtyCwd(`${ROOT}\\EnvSync`)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('cwdFallbackFrom', () => {
  it('reports the requested cwd when nothing valid was resolved', () => {
    expect(cwdFallbackFrom({ source: 'requested', incomingCwd: '\\\\srv\\share\\p' }, undefined, 'pwsh.exe'))
      .toBe('\\\\srv\\share\\p');
  });

  it('reports nothing when the requested cwd was used', () => {
    expect(cwdFallbackFrom({ source: 'requested', incomingCwd: 'D:\\p', safeCwd: 'D:\\p' }, undefined, 'pwsh.exe'))
      .toBeUndefined();
  });

  it('reports a lost UNC live cwd when recovery took the spawnCwd', () => {
    if (process.platform !== 'win32') return;
    expect(cwdFallbackFrom(
      { source: 'recovery-spawnCwd', incomingCwd: 'D:\\spawn', safeCwd: 'D:\\spawn' },
      { spawnCwd: 'D:\\spawn', cwd: '\\\\srv\\share\\p' },
      'pwsh.exe',
    )).toBe('\\\\srv\\share\\p');
  });

  it('is silent for WSL panes', () => {
    expect(cwdFallbackFrom({ source: 'requested', incomingCwd: '/home/me' }, undefined, 'wsl.exe')).toBeUndefined();
  });
});
