# Hamoa local branch notes (`hamoa/main`)

Local fork of `openwong2kim/wmux`, rebased onto upstream `main`.

## Remotes / sync

- `origin` = https://github.com/openwong2kim/wmux (upstream)
- `fork`   = https://github.com/Mrphase/wmux (old 3.40.2 patch: `fix/terminal-resize-snapshot` @ 636f4dc)
- Sync: `git fetch origin && git rebase origin/main`. Keep local commits small and independent.

## Local commits on top of upstream

1. `style(scrollbar)`: wider, high-contrast scrollbars (kept from 636f4dc's globals.css).
2. `feat(cwd)`: network-share (UNC) working directories survive restarts:
   - Settings → Terminal → **Trusted network directories** (`trustedCwdRoots`, `;`-separated,
     e.g. `\\gaming-sh01-lnx\workspace\zehuixie`). Empty = upstream default (all UNC refused).
   - Trusted UNC cwd: bounded async wait (~6 s) for a share that is not up yet after boot,
     both in main `pty.create` and in daemon recovery (once per share root).
   - A fallback never loses the intended path: it is stored as `cwdFallbackFrom` on the
     daemon session (persisted in `~/.wmux/sessions.json`) and retried at the next recovery.
     Cleared once the pane's live cwd moves on.
   - `CwdRecoveryChip` (top-left of a pane, same style as the Resume chip): shows the last
     path, ⧉ copy, ↪ cd there (PowerShell `Set-Location -LiteralPath`, cmd `pushd`, bash `cd`;
     typed WITH Enter). The Resume chip waits until the pane is back in its directory.

## Dropped from 636f4dc (upstream fixed it)

- PaneContainer percentage sizes, useTerminal resize resync, HeadlessSnapshot tests.
- WebGL disable: not carried; revisit only if glyph ghosting reappears.

## Build on this machine (Windows ARM64, Node 22.11)

Node 22.11 needs `--experimental-require-module` (electron/vitest load ESM via require), and
`wasm-pack` has no win-arm64 binary, so:

```powershell
$env:NODE_OPTIONS='--experimental-require-module'
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run postinstall
npm run typecheck
npm run test:parallel
npm run package     # -> out\wmux-win32-arm64
```

(Upgrading Node to >= 22.12 removes the need for NODE_OPTIONS.)

## Deploy (side-by-side)

- Installed to `%LOCALAPPDATA%\wmux\app-4.1.0-hamoa`; `~\.local\bin\wmux-latest.cmd` points there.
- `app-3.40.2-main` is untouched. Backups of `session.json`, `~\.wmux\sessions.json` and the old
  launcher: `~\.codex\backups\wmux-v4-upgrade-<timestamp>`.
- Rollback: quit wmux, restore the `.cmd` and the two JSON files from the backup, relaunch.
- Known on this machine: several upstream test files (worktask, fan-out, worktree, win32Probe,
  some runtime tests) fail or flake here on clean `origin/main` too (Windows temp-dir locks,
  `AttachConsole failed`); not caused by local commits.
