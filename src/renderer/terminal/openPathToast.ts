// Ctrl+click path → toast. Main's shell.openPath answers with an error code
// when the plain open didn't happen; each code maps to a toast that says what
// the click actually did (opened a folder instead, or nothing at all).

export type OpenPathToastKey =
  | 'terminal.openPathBlocked'
  | 'terminal.openPathFailed'
  | 'terminal.openPathMissingParent'
  | 'terminal.openPathNotFound';

export function openPathToastKey(error: string | undefined): OpenPathToastKey {
  switch (error) {
    case 'BLOCKED_EXTENSION': return 'terminal.openPathBlocked';
    // The path is gone; main opened its nearest existing ancestor folder.
    case 'NOT_FOUND_OPENED_PARENT': return 'terminal.openPathMissingParent';
    // Nothing reachable (or the share lookup timed out) — nothing opened.
    case 'NOT_FOUND':
    case 'LOOKUP_TIMEOUT': return 'terminal.openPathNotFound';
    // The file exists but couldn't be opened; main revealed it in its folder.
    default: return 'terminal.openPathFailed';
  }
}
