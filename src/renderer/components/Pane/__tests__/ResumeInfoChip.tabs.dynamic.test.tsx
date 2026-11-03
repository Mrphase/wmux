// @vitest-environment jsdom
//
// The resident resume chip: two always-visible triggers (↩ Resume / Session),
// each opening its own panel, and the busy gate that disables ONLY 복구 (the
// chip itself is no longer hidden while the agent works).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
const ptyWrite = vi.fn();
(window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write: ptyWrite } };

import ResumeInfoChip from '../ResumeInfoChip';
import type { ResumeBinding } from '../../../../shared/agentResume';

const SID = 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a';
const binding: ResumeBinding = { agent: 'claude', sessionId: SID, cwd: 'D:\\repo\\proj', ts: 1 };

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<React.ComponentProps<typeof ResumeInfoChip>> = {}): void {
  act(() => {
    root.render(React.createElement(ResumeInfoChip, {
      ptyId: 'pty-1',
      binding,
      paneCwds: ['d:/repo/proj'],
      ...props,
    }));
  });
}

const triggers = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'));
const resumeTrigger = () => triggers()[0];
const sessionTrigger = () => triggers()[1];
/** The in-panel 복구 button (same label as the trigger, but no aria-expanded). */
const recoverButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  .find((b) => !b.hasAttribute('aria-expanded') && (b.textContent ?? '').includes('Resume'));
const click = (el: HTMLElement | undefined) => { act(() => { el!.click(); }); };

beforeEach(() => {
  ptyWrite.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('ResumeInfoChip — resident triggers', () => {
  it('renders both triggers, collapsed, while the agent is busy', () => {
    render({ agentBusy: true });
    expect(triggers().length).toBe(2);
    expect(resumeTrigger().textContent).toContain('Resume Claude');
    expect(sessionTrigger().textContent).toBe('Session');
    expect(triggers().every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.textContent).not.toContain(SID);
  });

  it('Session opens the Session tab: agent, session id and the binding cwd', () => {
    render({ agentBusy: true });
    click(sessionTrigger());
    expect(sessionTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(resumeTrigger().getAttribute('aria-expanded')).toBe('false');
    const text = container.textContent ?? '';
    expect(text).toContain('Agent');
    expect(text).toContain('Claude');
    expect(text).toContain('Session ID');
    expect(text).toContain(SID);
    expect(text).toContain('Working path');
    expect(text).toContain('D:\\repo\\proj');
    // Same path modulo drive-letter case / slashes → no redundant live-cwd row.
    expect(text).not.toContain('Current path');
    // Info only — no 복구 on this tab.
    expect(recoverButton()).toBeUndefined();
  });

  it('Session shows the live cwd too when it differs from the origin cwd', () => {
    render({ paneCwds: ['C:\\Users\\me', 'D:\\repo\\proj'] });
    click(sessionTrigger());
    const text = container.textContent ?? '';
    expect(text).toContain('Current path');
    expect(text).toContain('C:\\Users\\me');
  });

  it('a remote-shaped binding (no origin cwd) omits the working-path row', () => {
    render({ binding: { ...binding, cwd: '' }, paneCwds: [] });
    click(sessionTrigger());
    const text = container.textContent ?? '';
    expect(text).toContain(SID);
    expect(text).not.toContain('Working path');
    expect(text).not.toContain('Current path');
  });

  it('the open trigger collapses on a second click; the other one switches tab', () => {
    render();
    click(resumeTrigger());
    expect(recoverButton()).toBeDefined();
    click(sessionTrigger()); // switch, still open
    expect(recoverButton()).toBeUndefined();
    expect(container.textContent).toContain('Working path');
    click(sessionTrigger()); // collapse
    expect(triggers().every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.textContent).not.toContain(SID);
  });

  it('copies the working path from the Session tab', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render();
    click(sessionTrigger());
    const copyButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .filter((b) => b.textContent === '⧉');
    expect(copyButtons.length).toBe(2); // session id + working path
    await act(async () => { copyButtons[1].click(); await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('D:\\repo\\proj');
  });
});

describe('ResumeInfoChip — busy gate on 복구', () => {
  it('busy: the Resume panel shows the hint and 복구 is disabled (nothing typed)', () => {
    render({ agentBusy: true });
    click(resumeTrigger());
    const recover = recoverButton()!;
    expect(recover.disabled).toBe(true);
    expect(recover.title).toContain('Agent is running');
    expect(container.textContent).toContain('Agent is running');
    // The rest of the panel stays usable (UUID, toggle, preview).
    expect(container.textContent).toContain(SID);
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    click(recover);
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('idle: 복구 is enabled and types the command into the pane (no Enter)', () => {
    render({ agentBusy: false });
    click(resumeTrigger());
    const recover = recoverButton()!;
    expect(recover.disabled).toBe(false);
    expect(container.textContent).not.toContain('Agent is running');
    click(recover);
    expect(ptyWrite).toHaveBeenCalledWith('pty-1', `claude --dangerously-skip-permissions --resume ${SID}`);
  });
});
