/**
 * Main-side mirror of the renderer's trusted-cwd-roots setting.
 *
 * validatePtyCwd blocks every UNC path (\\server\share) by default. Users who
 * develop on a network share list its root here in Settings; a UNC cwd at or
 * under one of these roots is then treated like any local directory. Same
 * push pattern as defaultWslDistro: the renderer owns the persisted copy in
 * session.json and pushes it on load and on every change.
 */

let trustedCwdRoots: string[] = [];

/** Normalise a root for prefix comparison: backslashes, no trailing separator, lower-case. */
function normaliseRoot(root: string): string {
  return root.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function setTrustedCwdRoots(roots: unknown): void {
  if (!Array.isArray(roots)) {
    trustedCwdRoots = [];
    return;
  }
  trustedCwdRoots = roots
    .filter((r): r is string => typeof r === 'string')
    .map(normaliseRoot)
    // Only full \\server\share (or deeper) roots — a bare "\\" or "\\server"
    // would trust every share on the network.
    .filter((r) => /^\\\\[^\\]+\\[^\\]+/.test(r));
}

export function getTrustedCwdRoots(): readonly string[] {
  return trustedCwdRoots;
}

/**
 * True when `resolved` (an absolute path) is a UNC path at or under a trusted
 * root. Case-insensitive, with a separator boundary so `\\srv\share2` never
 * matches the root `\\srv\share`.
 */
export function isTrustedUncCwd(resolved: string, roots: readonly string[] = trustedCwdRoots): boolean {
  if (!resolved.startsWith('\\\\')) return false;
  const candidate = normaliseRoot(resolved);
  return roots.some((root) => candidate === root || candidate.startsWith(root + '\\'));
}
