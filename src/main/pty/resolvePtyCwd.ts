import fs from 'node:fs';
import { isLinuxCwd, isWslShell } from '../../shared/wsl';
import path from 'node:path';
import type { DeadPaneRecovery } from '../../shared/ptyRecovery';
import { isTrustedUncCwd } from './trustedCwdRoots';

export type PtyCwdSource = 'requested' | 'recovery-spawnCwd' | 'recovery-cwd' | 'recovery-home';

export interface ResolvedPtyCwd {
  incomingCwd?: string;
  safeCwd?: string;
  source: PtyCwdSource;
}

/** Validate and resolve a renderer-provided cwd. Returns undefined if invalid. */
export function validatePtyCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  // Block UNC paths (e.g. \\server\share) unless the user trusted their root.
  if (resolved.startsWith('\\\\') && (!isTrustedUncCwd(resolved) || isKnownUnreachable(resolved))) return undefined;
  try {
    if (!fs.statSync(resolved).isDirectory()) return undefined;
  } catch {
    // Missing, inaccessible, or removed between resolution and stat: let the
    // caller continue to the next recovery candidate or home fallback.
    return undefined;
  }
  return resolved;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Trusted UNC paths that just failed a bounded wait, with an expiry. While
 * listed, validatePtyCwd rejects them without a synchronous stat — a stat
 * against an unreachable SMB server can block the main process for many
 * seconds, and every pane of a restored workspace would pay it again.
 */
const unreachableUntil = new Map<string, number>();
const UNREACHABLE_TTL_MS = 15_000;

function isKnownUnreachable(resolved: string, now = Date.now()): boolean {
  const until = unreachableUntil.get(resolved.toLowerCase());
  if (until === undefined) return false;
  if (until > now) return true;
  unreachableUntil.delete(resolved.toLowerCase());
  return false;
}

/** Test seam. */
export function resetUnreachableCwdCache(): void {
  unreachableUntil.clear();
}

async function isDirectoryAsync(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; }
}

/**
 * A share mounted over the network may not answer yet right after boot or
 * wake. For trusted UNC candidates only, give it a bounded grace period
 * (async, so the main process keeps running) before the caller validates and
 * possibly falls back. Never throws. Returns as soon as one candidate is
 * reachable, none is trusted, or the deadline passes — a single slow stat
 * that eats the whole budget ends the wait rather than being retried.
 */
export async function waitForTrustedUncCwds(
  candidates: Array<string | undefined>,
  { deadlineMs = 6000, delayMs = 2000, stat = isDirectoryAsync }: {
    deadlineMs?: number;
    delayMs?: number;
    stat?: (p: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const trusted = [...new Set(candidates
    .filter((c): c is string => !!c)
    .map((c) => path.resolve(c))
    .filter((c) => isTrustedUncCwd(c) && !isKnownUnreachable(c)))];
  if (trusted.length === 0) return;
  const start = Date.now();
  for (;;) {
    for (const c of trusted) {
      if (await stat(c)) return;
    }
    if (Date.now() - start + delayMs >= deadlineMs) break;
    await sleep(delayMs);
  }
  const until = Date.now() + UNREACHABLE_TTL_MS;
  for (const c of trusted) unreachableUntil.set(c.toLowerCase(), until);
}

/**
 * The directory to offer a one-click `cd` back to, when the resolved spawn
 * cwd is not where the pane was meant to be. Undefined when nothing was lost.
 *  - a requested cwd that failed validation;
 *  - a recovery that fell all the way to home;
 *  - a recovery that took the (valid) spawnCwd while the pane's last live cwd
 *    was a network share that could not be used — otherwise the remote
 *    directory the user had cd'd into would vanish without a trace.
 * WSL panes are out of scope (their cwd shapes are Linux paths).
 */
export function cwdFallbackFrom(
  resolution: ResolvedPtyCwd,
  recovery: Pick<DeadPaneRecovery, 'spawnCwd' | 'cwd'> | undefined,
  shell?: string,
): string | undefined {
  if (isWslShell(shell)) return undefined;
  if (!resolution.safeCwd) return resolution.incomingCwd || undefined;
  if (
    resolution.source === 'recovery-spawnCwd'
    && recovery?.cwd?.startsWith('\\\\')
    && recovery.cwd.toLowerCase() !== resolution.safeCwd.toLowerCase()
    && !validatePtyCwd(recovery.cwd)
  ) {
    return recovery.cwd;
  }
  return undefined;
}

export function validatePtyCwdForShell(cwd: string | undefined, shell?: string): string | undefined {
  if (isWslShell(shell) && isLinuxCwd(cwd)) return cwd;
  return validatePtyCwd(cwd);
}

/**
 * Resolve create-time cwd without letting renderer metadata become authority.
 * A known dead-session replacement tries persisted spawnCwd, then its last live
 * cwd; when neither validates, the caller deliberately falls back to home.
 * Ordinary creates retain their existing single-cwd behavior.
 */
export function resolvePtyCreateCwd(
  requestedCwd: string | undefined,
  recovery: Pick<DeadPaneRecovery, 'spawnCwd' | 'cwd'> | undefined,
  validate: (cwd: string | undefined) => string | undefined = validatePtyCwd,
): ResolvedPtyCwd {
  if (recovery !== undefined) {
    const spawnCwd = validate(recovery.spawnCwd);
    if (spawnCwd) {
      return { incomingCwd: recovery.spawnCwd, safeCwd: spawnCwd, source: 'recovery-spawnCwd' };
    }

    const liveCwd = validate(recovery.cwd);
    if (liveCwd) {
      return { incomingCwd: recovery.cwd, safeCwd: liveCwd, source: 'recovery-cwd' };
    }

    return {
      incomingCwd: recovery.spawnCwd ?? recovery.cwd,
      source: 'recovery-home',
    };
  }

  return {
    incomingCwd: requestedCwd,
    safeCwd: validate(requestedCwd),
    source: 'requested',
  };
}

/** WSL recovery uses the last Linux cwd; legacy spawnCwd may be Windows home. */
export function resolvePtyCreateCwdForShell(
  requestedCwd: string | undefined,
  recovery: Pick<DeadPaneRecovery, 'spawnCwd' | 'cwd'> | undefined,
  shell?: string,
): ResolvedPtyCwd {
  if (isWslShell(shell) && recovery !== undefined) {
    if (isLinuxCwd(recovery.cwd)) {
      return { incomingCwd: recovery.cwd, safeCwd: recovery.cwd, source: 'recovery-cwd' };
    }
    if (isLinuxCwd(recovery.spawnCwd)) {
      return { incomingCwd: recovery.spawnCwd, safeCwd: recovery.spawnCwd, source: 'recovery-spawnCwd' };
    }
  }
  return resolvePtyCreateCwd(requestedCwd, recovery, (cwd) => validatePtyCwdForShell(cwd, shell));
}
