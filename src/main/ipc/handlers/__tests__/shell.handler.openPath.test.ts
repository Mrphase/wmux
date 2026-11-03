/**
 * shell.handler — `openPath` channel.
 *
 * Verifies that:
 *   • absolute paths are forwarded to Electron's shell.openPath
 *   • relative paths, NUL bytes, non-strings, length overflow are rejected
 *   • path.normalize is applied (so `..` collapses before isAbsolute check)
 *   • openPath returning an error string triggers showItemInFolder fallback
 *     for an existing target, and opens the nearest existing ancestor folder
 *     for a missing one (bounded by a lookup timeout)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake filesystem for the failed-open fallback: path → what stat reports.
// 'hang' never settles, like a UNC path on an unreachable server.
const fsEntries = vi.hoisted(() => new Map<string, 'dir' | 'file' | 'hang'>());

// ── Module mocks (hoisted; cannot reference outer test variables) ──────────

vi.mock('fs/promises', () => ({
  stat: vi.fn((p: string) => {
    const kind = fsEntries.get(p);
    if (kind === 'hang') return new Promise(() => { /* never settles */ });
    if (!kind) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    return Promise.resolve({ isDirectory: () => kind === 'dir' });
  }),
}));

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const openPath = vi.fn();
  const showItemInFolder = vi.fn();
  const openExternal = vi.fn();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return {
    ipcMain,
    shell: { openPath, showItemInFolder, openExternal },
    __handlers: handlers,
    __openPath: openPath,
    __showItemInFolder: showItemInFolder,
  };
});

// ShellDetector is constructed at handler registration time. Stub the
// constructor so the test doesn't drag in pty discovery side effects.
// Use a plain class — vi.fn().mockImplementation does not produce a real
// constructor and would fail `new ShellDetector()`.
vi.mock('../../../../shared/ShellDetector', () => ({
  ShellDetector: class {
    detect() {
      return Promise.resolve([]);
    }
  },
}));

import * as electron from 'electron';
import { registerShellHandlers } from '../shell.handler';
import { IPC } from '../../../../shared/constants';

const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;
const openPath = (electron as unknown as { __openPath: ReturnType<typeof vi.fn> }).__openPath;
const showItemInFolder = (electron as unknown as { __showItemInFolder: ReturnType<typeof vi.fn> }).__showItemInFolder;

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  handlers.clear();
  fsEntries.clear();
  openPath.mockReset();
  showItemInFolder.mockReset();
  // Default: openPath succeeds (empty error string).
  openPath.mockResolvedValue('');
  cleanup = registerShellHandlers();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('shell.handler — SHELL_OPEN_PATH', () => {
  const fakeEvent = {} as Electron.IpcMainInvokeEvent;

  it('forwards an absolute POSIX-style path on a POSIX host', async () => {
    if (process.platform === 'win32') return; // path.isAbsolute is OS-aware
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    const result = await handler(fakeEvent, '/etc/hosts');
    expect(openPath).toHaveBeenCalledWith('/etc/hosts');
    expect(result).toEqual({ ok: true, error: undefined });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('forwards a Windows drive path on a Windows host', async () => {
    if (process.platform !== 'win32') return;
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    const result = await handler(fakeEvent, 'C:\\Users\\rizz\\file.txt');
    expect(openPath).toHaveBeenCalledWith('C:\\Users\\rizz\\file.txt');
    expect(result).toEqual({ ok: true, error: undefined });
  });

  it('rejects a non-string argument', async () => {
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    await expect(handler(fakeEvent, 42 as unknown as string)).rejects.toThrow(/string/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects an empty string', async () => {
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    await expect(handler(fakeEvent, '')).rejects.toThrow(/length/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects an overlong path', async () => {
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    const huge = (process.platform === 'win32' ? 'C:\\' : '/') + 'a'.repeat(5000);
    await expect(handler(fakeEvent, huge)).rejects.toThrow(/length/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects a path with NUL bytes', async () => {
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    const evil = (process.platform === 'win32' ? 'C:\\foo\0bar' : '/foo\0bar');
    await expect(handler(fakeEvent, evil)).rejects.toThrow(/NUL/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rejects a relative path', async () => {
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    await expect(handler(fakeEvent, 'relative/path/file.txt')).rejects.toThrow(/absolute/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('normalizes the path before forwarding (collapses `..`)', async () => {
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    const input = process.platform === 'win32' ? 'C:\\foo\\..\\bar' : '/foo/../bar';
    const expected = process.platform === 'win32' ? 'C:\\bar' : '/bar';
    await handler(fakeEvent, input);
    expect(openPath).toHaveBeenCalledWith(expected);
  });

  it('falls back to showItemInFolder when an existing file fails to open', async () => {
    openPath.mockResolvedValueOnce('Failed to open path');
    const handler = getHandler(IPC.SHELL_OPEN_PATH);
    const input = process.platform === 'win32' ? 'C:\\no-handler.xyz' : '/no-handler.xyz';
    fsEntries.set(input, 'file');
    const result = await handler(fakeEvent, input);
    expect(showItemInFolder).toHaveBeenCalledWith(input);
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, error: 'Failed to open path' });
  });

  describe('missing target fallback', () => {
    const isWin = process.platform === 'win32';
    // Absolute path on the host OS from plain segments.
    const abs = (...segs: string[]) => (isWin ? 'C:\\' : '/') + segs.join(isWin ? '\\' : '/');
    const root = isWin ? 'C:\\' : '/';

    beforeEach(() => {
      // First call is the target itself; it fails because it does not exist.
      openPath.mockResolvedValueOnce('Failed to open path');
    });

    it('opens the parent folder when the file is missing but its folder exists', async () => {
      const dir = abs('Users', 'rizz', 'proj');
      fsEntries.set(dir, 'dir');
      const input = `${dir}${isWin ? '\\' : '/'}notes.md:12:5)`;
      const result = await getHandler(IPC.SHELL_OPEN_PATH)(fakeEvent, input);
      expect(openPath.mock.calls).toEqual([[input], [dir]]);
      expect(showItemInFolder).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND_OPENED_PARENT' });
    });

    it('opens the nearest existing ancestor of a deep missing path', async () => {
      fsEntries.set(root, 'dir');
      fsEntries.set(abs('Users'), 'dir');
      fsEntries.set(abs('Users', 'rizz'), 'dir');
      const input = abs('Users', 'rizz', 'a', 'b', 'c', 'd.txt');
      const result = await getHandler(IPC.SHELL_OPEN_PATH)(fakeEvent, input);
      expect(openPath.mock.calls).toEqual([[input], [abs('Users', 'rizz')]]);
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND_OPENED_PARENT' });
    });

    it('walks past an existing ancestor that is a file, not a folder', async () => {
      fsEntries.set(abs('proj'), 'dir');
      fsEntries.set(abs('proj', 'main.ts'), 'file');
      const input = abs('proj', 'main.ts', 'glued');
      const result = await getHandler(IPC.SHELL_OPEN_PATH)(fakeEvent, input);
      expect(openPath.mock.calls).toEqual([[input], [abs('proj')]]);
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND_OPENED_PARENT' });
    });

    it('returns NOT_FOUND and opens nothing when no ancestor exists', async () => {
      const input = abs('nowhere', 'file.txt');
      const result = await getHandler(IPC.SHELL_OPEN_PATH)(fakeEvent, input);
      expect(openPath).toHaveBeenCalledTimes(1);
      expect(showItemInFolder).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('stops at the UNC share root and never stats the bare server', async () => {
      if (!isWin) return; // UNC syntax only parses with win32 path rules
      const stat = vi.mocked((await import('fs/promises')).stat);
      stat.mockClear();
      const input = '\\\\srv\\share\\x\\y.txt';
      const result = await getHandler(IPC.SHELL_OPEN_PATH)(fakeEvent, input);
      expect(stat.mock.calls.map(c => c[0])).toEqual([
        input, '\\\\srv\\share\\x', '\\\\srv\\share\\',
      ]);
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('gives up without opening anything when stat hangs', async () => {
      vi.useFakeTimers();
      try {
        const input = isWin ? '\\\\deadhost\\share\\file.txt' : '/mnt/deadhost/file.txt';
        fsEntries.set(input, 'hang');
        let settled = false;
        const pending = (getHandler(IPC.SHELL_OPEN_PATH)(fakeEvent, input) as Promise<unknown>)
          .finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(2999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ ok: false, error: 'LOOKUP_TIMEOUT' });
        expect(openPath).toHaveBeenCalledTimes(1);
        expect(showItemInFolder).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('applies the same fallback to "Open with" File Explorer', async () => {
      fsEntries.set(abs('repos'), 'dir');
      const input = abs('repos', 'deleted-worktree');
      const result = await getHandler(IPC.SHELL_OPEN_WITH)(fakeEvent, { appId: 'explorer', folderPath: input });
      expect(openPath.mock.calls).toEqual([[input], [abs('repos')]]);
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND_OPENED_PARENT' });
    });
  });

  describe('executable extension blocklist', () => {
    // Each entry: the renderer-supplied path → the normalized form main
    // sends to showItemInFolder. Windows hosts normalize forward slashes
    // to backslashes; POSIX hosts leave the input unchanged.
    const expectNormalized = (input: string) =>
      process.platform === 'win32' ? input.replace(/\//g, '\\') : input;

    const blockedSamples = [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1',
      '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi',
      '.reg', '.lnk', '.hta', '.cpl',
      '.command', '.app', '.tool', '.terminal', '.workflow', '.sh',
    ];

    for (const ext of blockedSamples) {
      it(`blocks ${ext} extension and reveals folder`, async () => {
        const handler = getHandler(IPC.SHELL_OPEN_PATH);
        const input = process.platform === 'win32'
          ? `C:\\Users\\rizz\\evil${ext}`
          : `/home/rizz/evil${ext}`;
        const result = await handler(fakeEvent, input);
        expect(openPath).not.toHaveBeenCalled();
        expect(showItemInFolder).toHaveBeenCalledWith(expectNormalized(input));
        expect(result).toEqual({ ok: false, error: 'BLOCKED_EXTENSION' });
      });
    }

    it('matches blocked extension case-insensitively', async () => {
      const handler = getHandler(IPC.SHELL_OPEN_PATH);
      const input = process.platform === 'win32' ? 'C:\\foo.EXE' : '/foo.EXE';
      const result = await handler(fakeEvent, input);
      expect(openPath).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, error: 'BLOCKED_EXTENSION' });
    });

    it('allows non-executable extensions', async () => {
      const handler = getHandler(IPC.SHELL_OPEN_PATH);
      const input = process.platform === 'win32' ? 'C:\\foo.txt' : '/foo.txt';
      const result = await handler(fakeEvent, input);
      expect(openPath).toHaveBeenCalledWith(input);
      expect(result).toEqual({ ok: true, error: undefined });
    });

    it('allows extension-less paths (folders)', async () => {
      const handler = getHandler(IPC.SHELL_OPEN_PATH);
      const input = process.platform === 'win32' ? 'C:\\Users\\rizz' : '/home/rizz';
      const result = await handler(fakeEvent, input);
      expect(openPath).toHaveBeenCalledWith(input);
      expect(result).toEqual({ ok: true, error: undefined });
    });
  });
});
