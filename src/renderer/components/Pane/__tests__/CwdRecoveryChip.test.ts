import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import CwdRecoveryChip, { buildCdCommand } from '../CwdRecoveryChip';

const UNC = '\\\\gaming-sh01-lnx\\workspace\\zehuixie\\EnvSync';

describe('buildCdCommand', () => {
  it('uses Set-Location -LiteralPath for PowerShell, escaping single quotes', () => {
    expect(buildCdCommand(UNC, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
      .toBe(`Set-Location -LiteralPath '${UNC}'`);
    expect(buildCdCommand("\\\\srv\\it's", 'powershell.exe'))
      .toBe("Set-Location -LiteralPath '\\\\srv\\it''s'");
  });

  it('uses pushd for cmd (cd cannot enter a UNC path)', () => {
    expect(buildCdCommand(UNC, 'C:\\Windows\\System32\\cmd.exe')).toBe(`pushd "${UNC}"`);
  });

  it('uses forward slashes and POSIX quoting for bash', () => {
    expect(buildCdCommand("\\\\srv\\a'b", 'C:\\Program Files\\Git\\bin\\bash.exe'))
      .toBe("cd '//srv/a'\\''b'");
  });

  it('offers no command for WSL', () => {
    expect(buildCdCommand(UNC, 'C:\\Windows\\System32\\wsl.exe')).toBeNull();
  });

  it('defaults to PowerShell for an unknown or missing shell', () => {
    expect(buildCdCommand(UNC, undefined)).toBe(`Set-Location -LiteralPath '${UNC}'`);
  });
});

describe('CwdRecoveryChip render smoke', () => {
  it('renders the collapsed trigger without the path', () => {
    const html = renderToStaticMarkup(createElement(CwdRecoveryChip, { ptyId: 'pty-1', from: UNC, shell: 'pwsh.exe' }));
    expect(html).toContain('Last directory');
    expect(html).toContain('data-cwd-recovery-chip');
    expect(html).not.toContain('EnvSync');
  });
});
