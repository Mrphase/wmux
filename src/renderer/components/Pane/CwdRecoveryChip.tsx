import React, { useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { isWslShell } from '../../../shared/wsl';

/**
 * The command that moves `shell` into `dir`. Returns `null` when the shell
 * cannot reach a Windows network share at all (WSL), so the chip offers only
 * the copy button there.
 *   - PowerShell: `Set-Location -LiteralPath` — no wildcard expansion of `[`.
 *   - cmd: `pushd` — `cd` refuses a UNC path; pushd maps a temp drive.
 *   - POSIX shells (Git Bash, MSYS): forward slashes, single-quoted.
 * Single quotes inside the path are escaped per shell. Pure + exported for tests.
 */
export function buildCdCommand(dir: string, shell: string | undefined): string | null {
  const exe = (shell ?? '').toLowerCase().split(/[\\/]/).pop() ?? '';
  if (isWslShell(shell)) return null;
  if (/^(pwsh|powershell)(\.exe)?$/.test(exe)) {
    return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`;
  }
  if (/^cmd(\.exe)?$/.test(exe)) {
    return `pushd "${dir}"`;
  }
  if (/^(bash|zsh|sh|fish)(\.exe)?$/.test(exe)) {
    return `cd '${dir.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
  }
  // Unknown shell on Windows: PowerShell is the default ShellDetector pick.
  return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`;
}

/**
 * One-click way back to a network share this pane could not start in — the
 * sibling of ResumeInfoChip, same look (neutral surface, thin amber edge,
 * collapsed by default). Shown while the daemon/main reports a cwd fallback
 * for the pane's PTY. "cd" types the command WITH Enter (moving directories is
 * harmless, unlike a resume with permission flags); the daemon clears the
 * fallback once the shell reports the new cwd.
 */
export default function CwdRecoveryChip(props: {
  ptyId: string;
  from: string;
  shell: string | undefined;
}): React.ReactElement | null {
  const { ptyId, from, shell } = props;
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const command = buildCdCommand(from, shell);

  const onCd = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!command) return;
    window.electronAPI.pty.write(ptyId, command + '\r');
    useStore.getState().dismissCwdFallback(ptyId);
  };

  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(from).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => { /* clipboard blocked — the path stays visible to select manually */ },
    );
  };

  const onDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    useStore.getState().dismissCwdFallback(ptyId);
  };

  const smallButton: React.CSSProperties = {
    padding: '0 5px',
    font: 'inherit',
    color: 'var(--text-main)',
    background: 'color-mix(in srgb, var(--text-main) 6%, transparent)',
    border: '1px solid var(--border-soft)',
    borderRadius: 3,
    cursor: 'pointer',
    flexShrink: 0,
  };

  return (
    <span
      data-cwd-recovery-chip
      style={{
        position: 'absolute',
        top: 4,
        left: 6,
        zIndex: 20,
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        fontSize: 10,
        fontFamily: 'ui-monospace, monospace',
        letterSpacing: '0.02em',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={t('cwdRecovery.tooltip')}
        aria-label={t('cwdRecovery.tooltip')}
        aria-expanded={open}
        style={{
          padding: '1px 6px',
          fontWeight: 600,
          color: 'var(--text-main)',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid color-mix(in srgb, var(--accent-cursor) 45%, transparent)',
          borderRadius: 4,
          boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.25))',
          cursor: 'pointer',
        }}
      >
        📁 {t('cwdRecovery.label')}
      </button>

      {open && (
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px',
            maxWidth: 420,
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-soft)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.35))',
          }}
        >
          <span style={{ color: 'var(--text-subtle)' }}>{t('cwdRecovery.explain')}</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-sub)', userSelect: 'text', overflowWrap: 'anywhere' }}>
              {from}
            </span>
            <button
              onClick={onCopy}
              title={t('contextMenu.copy')}
              aria-label={t('contextMenu.copy')}
              style={smallButton}
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>

          {command && (
            <code
              style={{
                display: 'block',
                padding: '4px 6px',
                color: 'var(--text-sub)',
                backgroundColor: 'var(--bg-base)',
                border: '1px solid var(--border-soft)',
                borderRadius: 3,
                userSelect: 'text',
                overflowWrap: 'anywhere',
                whiteSpace: 'pre-wrap',
              }}
            >
              {command}
            </code>
          )}

          <div style={{ display: 'inline-flex', gap: 6 }}>
            {command && (
              <button
                onClick={onCd}
                title={t('cwdRecovery.cdTooltip')}
                style={{
                  padding: '2px 10px',
                  font: 'inherit',
                  fontWeight: 600,
                  color: 'var(--text-main)',
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid color-mix(in srgb, var(--accent-cursor) 55%, transparent)',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                ↪ {t('cwdRecovery.cd')}
              </button>
            )}
            <button onClick={onDismiss} title={t('cwdRecovery.dismiss')} style={{ ...smallButton, padding: '2px 8px' }}>
              {t('cwdRecovery.dismiss')}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/** Store subscription leaf: mounts the chip only for a PTY with a fallback. */
export function CwdRecoveryChipGate(props: { ptyId: string; shell: string | undefined }): React.ReactElement | null {
  const from = useStore((s) => s.cwdFallbackByPtyId[props.ptyId]);
  if (!from) return null;
  return <CwdRecoveryChip ptyId={props.ptyId} from={from} shell={props.shell} />;
}
