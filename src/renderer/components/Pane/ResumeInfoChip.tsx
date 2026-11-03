import React, { useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { isPaneAgentBusy } from '../../stores/selectors/fleet';
import {
  type ResumeBinding,
  agentSupportsPermissionFlag,
  permissionFlagFor,
  resumeGrammarFor,
} from '../../../shared/agentResume';
import { applyRoleBinding, type RoleBinding } from '../../../shared/orchestratorRole';

/**
 * Assemble the resume command for a pane from its binding + LIVE cwd
 * candidates. Mirrors the reboot-recovery pill's gates (Pane.tsx) so the two
 * never diverge:
 *   - exact form (`--resume <id>` + the recorded permission flag) ONLY when the
 *     binding's origin cwd still matches one of the pane's cwd candidates
 *     (`--resume` is cwd-scoped); the permission flag rides the SAME line
 *     (both must land together);
 *   - otherwise the cwd-relative fallback (Claude `--continue` / Codex
 *     `resume --last`), which carries no recorded mode.
 *
 * Why candidates, not a single cwd (2026-07-21, live-observed): surface.cwd is
 * the SHELL's tracked cwd and goes stale across `cd X; claude` one-liners (no
 * prompt render → no OSC 7) — the shell truly sat in the binding's cwd, yet the
 * gate compared against the stale value and wrongly downgraded a legitimate
 * exact resume to `--continue` (dropping the permission flag with it). The
 * workspace's hook-reported agent cwd (metadata.cwd) is the second candidate.
 * A false positive types a `--resume` that claude rejects visibly (nothing
 * auto-runs — the user presses Enter); a false negative silently resumes the
 * WRONG conversation. Loud beats silent.
 *
 * `skipPermissions` (the pane toggle, default on) forces
 * `--dangerously-skip-permissions` for Claude regardless of the captured mode;
 * when off, the captured permission mode (acceptEdits/plan) is restored if any.
 * Unlike the exact `<id>`, this launch preference is NOT conversation-scoped, so
 * it rides EITHER grammar branch (exact `--resume` and fallback `--continue`).
 * Codex takes no permission flag, so the toggle is inert there.
 *
 * A role binding's `skipPermissions` does NOT override an explicit OFF: when the
 * toggle is offered (Claude) and off, the role's skip flag is withheld (and
 * dropped from the role's args, #1681), so the restored mode is what runs (`--dangerously-skip-permissions` beats
 * `--permission-mode` on the same line). The role's model, effort and args still
 * apply. Where the toggle is inert (Codex) the role's skip flag applies as usual.
 *
 * Returns `null` for a non-resumable agent (no grammar). Pure + exported so the
 * exact-vs-fallback decision is unit-testable without rendering.
 */
export function buildPaneResumeCommand(
  binding: ResumeBinding,
  paneCwds: ReadonlyArray<string | undefined>,
  skipPermissions: boolean,
  roleBinding?: RoleBinding,
  exactOverride?: boolean,
): { command: string; exact: boolean; roleRewritten: boolean } | null {
  const grammar = resumeGrammarFor(binding.agent);
  if (!grammar) return null;
  // Lowercase ONLY a leading Windows drive letter; POSIX stays case-sensitive.
  const normCwd = (p: string | undefined): string => {
    let out = (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };
  const target = normCwd(binding.cwd);
  // #1342 — a REMOTE pane's cwds live on another machine, so the desktop cannot
  // run this comparison at all; the host answers the question instead and the
  // caller passes its verdict through. Local callers leave it undefined.
  const exact = exactOverride ?? paneCwds.some((c) => !!c && normCwd(c) === target);
  // Explicit toggle (default on) → force --dangerously-skip-permissions on
  // EITHER branch (a launch preference, not conversation-scoped). Toggle off →
  // restore the captured permission mode, but only on an EXACT resume (that
  // mode belongs to the exact conversation; a cwd-relative --continue drops it).
  const permFlag = agentSupportsPermissionFlag(binding.agent)
    ? (skipPermissions
        ? permissionFlagFor('bypassPermissions')
        : (exact ? permissionFlagFor(binding.permissionMode) : ''))
    : '';
  const resumeArg = exact ? grammar.withId(binding.sessionId) : grammar.fallback;
  const base = `${binding.agent}${permFlag ? ` ${permFlag}` : ''} ${resumeArg}`;
  // D2 — re-assert the role's enforced model on resume. The reconstruction above
  // rebuilds from the agent stem + resume/permission flags only, so a bound
  // model would silently drop; applyRoleBinding re-injects it (unless the
  // operator already put an explicit --model on the line).
  // `roleRewritten` is reported rather than logged here so this stays a pure
  // function (it runs on every render of the chip); the caller emits the audit
  // line once, from an effect.
  const toggledOff = agentSupportsPermissionFlag(binding.agent) && !skipPermissions;
  const rewrite = applyRoleBinding(base, roleBinding, { suppressSkipPermissions: toggledOff });
  return { command: rewrite.command, exact, roleRewritten: rewrite.changed };
}

/** Which panel the chip is showing — each has its own always-visible trigger. */
type ResumeChipTab = 'resume' | 'session';

/** Display-only path compare for the Session tab ("is the live cwd worth a
 *  second row?"). Same normalization as buildPaneResumeCommand's cwd gate:
 *  slashes unified, trailing separators dropped, a leading Windows drive
 *  letter lowercased; POSIX stays case-sensitive. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let out = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };
  return norm(a) === norm(b);
}

/**
 * Per-pane resume affordance — the persistent sibling of the reboot-recovery
 * pill (Pane.tsx). Shown on ANY agent pane that carries a captured conversation
 * binding (surfaced by the daemon once its transcript exists), not only right
 * after a reboot — and kept up while the agent is busy too.
 *
 * Two small always-visible triggers, each opening its own panel (clicking the
 * open one again collapses it):
 *   - ↩ Resume — the UUID, the skip-permissions toggle, the command preview and
 *     복구, which types the exact resume command into THIS pane — e.g.
 *       `claude --dangerously-skip-permissions --resume <uuid>`
 *   - Session — read-only info: agent, session id and the conversation's origin
 *     cwd (each copyable), plus the pane's live cwd when it differs.
 *
 * Typing carries NO trailing Enter — the click is the explicit intent D6
 * requires, the user presses Enter to run (so a `--dangerously-skip-permissions`
 * line is never auto-executed). While `agentBusy`, 복구 (and only 복구) is
 * disabled: typed into a LIVE agent TUI the command would land in the agent's
 * input, not a shell.
 */
export default function ResumeInfoChip(props: {
  ptyId: string;
  binding: ResumeBinding;
  /** #1342 — host verdict for a remote pane's cwd match (see
   *  buildPaneResumeCommand). Undefined for a local pane. */
  exactOverride?: boolean;
  /** #1342 — where the assembled command goes. Undefined = this pane's local
   *  PTY. A remote-terminal surface has no local PTY, so it supplies the
   *  remote input path instead. */
  onSend?: (command: string) => void;
  /** Live cwd candidates for the cwd-match re-guard, in trust order:
   *  surface.cwd (OSC 7-tracked shell cwd), then the workspace's hook-reported
   *  agent cwd (metadata.cwd) — see buildPaneResumeCommand. */
  paneCwds: ReadonlyArray<string | undefined>;
  /** D2 — the pane's enforced role→model binding (re-asserted on resume). */
  roleBinding?: RoleBinding;
  /** D2 — the role name that supplied `roleBinding`, for the audit log. */
  role?: string;
  /** The pane's agent is working (isPaneAgentBusy) — the chip stays visible but
   *  복구 is disabled. Undefined/false = settled or exited. */
  agentBusy?: boolean;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwds, roleBinding, role, exactOverride, onSend } = props;
  const agentBusy = props.agentBusy === true;
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ResumeChipTab>('resume');
  // Which value's ⧉ last succeeded (a key, so each copy button flashes alone).
  const [copied, setCopied] = useState<string | null>(null);
  // Default ON — the owner routinely resumes with --dangerously-skip-permissions,
  // so the chip pre-checks it. Claude-only (Codex has no such flag).
  const canSkipPermissions = agentSupportsPermissionFlag(binding.agent);
  const [skipPermissions, setSkipPermissions] = useState(true);

  const built = buildPaneResumeCommand(binding, paneCwds, skipPermissions, roleBinding, exactOverride);
  if (!built) return null; // not a resumable agent — nothing to offer
  const { command } = built;

  const agentName = binding.agent.charAt(0).toUpperCase() + binding.agent.slice(1);
  // The pane's live cwd, shown only when it is not the conversation's origin.
  const liveCwd = paneCwds[0];
  const showLiveCwd = !!liveCwd && (!binding.cwd || !samePath(liveCwd, binding.cwd));

  const onTrigger = (e: React.MouseEvent, which: ResumeChipTab) => {
    e.stopPropagation();
    // The open trigger collapses; the other one switches the panel to its tab.
    if (open && tab === which) {
      setOpen(false);
      return;
    }
    setTab(which);
    setOpen(true);
  };

  const onRecover = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (agentBusy) return; // belt-and-braces: the button is disabled while busy
    if (built.roleRewritten) {
      // Audit trail — a role silently changed what this chip types. Logged at
      // the ACTION (not while building the preview) so it fires once per use.
      console.log('[wmux:role-binding] resume command rewritten', {
        role,
        agent: binding.agent,
        after: command,
      });
    }
    // No trailing \r — the user presses Enter to run (D6: bypass is re-granted
    // only by an explicit keystroke, never automatically).
    if (onSend) onSend(command);
    else window.electronAPI.pty.write(ptyId, command);
    setOpen(false);
  };

  const onCopy = (e: React.MouseEvent, key: string, text: string) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key);
        window.setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), 1200);
      },
      () => { /* clipboard blocked — leave the value visible to select manually */ },
    );
  };

  const copyButton = (key: string, text: string) => (
    <button
      onClick={(e) => onCopy(e, key, text)}
      title={t('contextMenu.copy')}
      aria-label={t('contextMenu.copy')}
      style={{
        padding: '0 5px',
        font: 'inherit',
        color: 'var(--text-main)',
        background: 'color-mix(in srgb, var(--text-main) 6%, transparent)',
        border: '1px solid var(--border-soft)',
        borderRadius: 3,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {copied === key ? '✓' : '⧉'}
    </button>
  );

  // One labelled, selectable, wrapping value row for the Session panel.
  const infoRow = (label: string, value: string, copyKey?: string) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span style={{ color: 'var(--text-subtle)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          minWidth: 0,
          color: 'var(--text-sub)',
          userSelect: 'text',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </span>
      {copyKey && copyButton(copyKey, value)}
    </div>
  );

  // Quiet trigger chips — DESIGN.md: neutral surface, thin amber edge, no amber
  // fill. The amber edge marks the open tab; collapsed, it stays on ↩ Resume
  // (the primary action) and Session keeps a neutral edge.
  const triggerStyle = (which: ResumeChipTab): React.CSSProperties => ({
    padding: '1px 6px',
    font: 'inherit',
    fontWeight: 600,
    color: 'var(--text-main)',
    backgroundColor: 'var(--bg-surface)',
    border: (open ? tab === which : which === 'resume')
      ? '1px solid color-mix(in srgb, var(--accent-cursor) 45%, transparent)'
      : '1px solid var(--border-soft)',
    borderRadius: 4,
    boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.25))',
    cursor: 'pointer',
  });

  return (
    <span
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
      {/* Both triggers always visible (collapsed by default so an agent pane
          isn't cluttered); compact so they cover as little output as possible. */}
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <button
          onClick={(e) => onTrigger(e, 'resume')}
          title={agentBusy ? t('resume.busyHint') : t('resume.tooltip')}
          aria-label={t('resume.tooltip')}
          aria-expanded={open && tab === 'resume'}
          style={triggerStyle('resume')}
        >
          ↩ {t('resume.label', { agent: agentName })}
        </button>
        <button
          onClick={(e) => onTrigger(e, 'session')}
          title={t('resume.sessionTooltip')}
          aria-label={t('resume.sessionTooltip')}
          aria-expanded={open && tab === 'session'}
          style={triggerStyle('session')}
        >
          {t('resume.tabSession')}
        </button>
      </span>

      {open && (
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px',
            maxWidth: 360,
            color: 'var(--text-main)',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-soft)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.35))',
          }}
        >
          {tab === 'session' ? (
            <>
              {infoRow(t('resume.agentLabel'), agentName)}
              {infoRow(t('resume.sessionId'), binding.sessionId, 'sessionId')}
              {/* The conversation's ORIGIN cwd (where `--resume` is scoped).
                  Empty on a remote pane — that path never crosses the API. */}
              {!!binding.cwd && infoRow(t('resume.workingPath'), binding.cwd, 'cwd')}
              {showLiveCwd && liveCwd && infoRow(t('resume.currentPath'), liveCwd, 'liveCwd')}
            </>
          ) : (
            <>
              {/* Conversation UUID + copy */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--text-subtle)' }}>UUID</span>
                <span
                  style={{
                    color: 'var(--text-sub)',
                    userSelect: 'text',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {binding.sessionId}
                </span>
                {copyButton('uuid', binding.sessionId)}
              </div>

              {/* Skip-permissions toggle (Claude only) — default on. Forces
                  --dangerously-skip-permissions onto the resume line; the preview
                  below updates live as it toggles. */}
              {canSkipPermissions && (
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    color: 'var(--text-sub)',
                    userSelect: 'none',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={skipPermissions}
                    onChange={(e) => setSkipPermissions(e.target.checked)}
                    style={{ accentColor: 'var(--accent-cursor)', cursor: 'pointer', margin: 0 }}
                  />
                  <span style={{ fontFamily: 'ui-monospace, monospace' }}>--dangerously-skip-permissions</span>
                </label>
              )}

              {/* Exact command preview — WYSIWYG with what 복구 types. */}
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

              {/* Why 복구 is greyed out — a live agent would swallow the line. */}
              {agentBusy && (
                <span style={{ color: 'var(--text-subtle)', overflowWrap: 'anywhere' }}>
                  {t('resume.busyHint')}
                </span>
              )}

              {/* 복구 — type the command into THIS pane (no auto-Enter). */}
              <button
                onClick={onRecover}
                disabled={agentBusy}
                title={agentBusy ? t('resume.busyHint') : t('resume.tooltip')}
                style={{
                  alignSelf: 'flex-start',
                  padding: '2px 10px',
                  font: 'inherit',
                  fontWeight: 600,
                  color: 'var(--text-main)',
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid color-mix(in srgb, var(--accent-cursor) 55%, transparent)',
                  borderRadius: 4,
                  cursor: agentBusy ? 'not-allowed' : 'pointer',
                  opacity: agentBusy ? 0.5 : 1,
                }}
              >
                ↩ {t('resume.label', { agent: agentName })}
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Subscription boundary for the persistent resume chip's "is this pane's agent
 * busy?" signal. This exists purely to keep the store-wide `agentClockMs` decay
 * clock OUT of the Pane body.
 *
 * `useAgentActivityClock` bumps `agentClockMs` ~every 2 s while ANY agent is
 * active. Pane used to subscribe to it directly to recompute `isPaneAgentBusy`
 * — so at N mounted panes a single active agent re-ran ALL N Pane bodies every
 * tick, even though the busy flag only ever affects THIS chip. The subscription
 * lives here now: Pane mounts this leaf only for a pane that actually carries a
 * resume binding, and a clock tick re-renders just this tiny gate, never the
 * Pane body. A pane with no binding never mounts the leaf → zero work per tick.
 *
 * Busy semantics are unchanged (isPaneAgentBusy), but the chip is no longer
 * hidden while busy: it stays up (so the session id / working path are always
 * reachable) and only its 복구 action is disabled — typing a resume command into
 * a LIVE agent TUI would land in the agent's input, not a shell.
 */
export function ResumeInfoChipGate(props: {
  ptyId: string;
  binding: ResumeBinding;
  paneCwds: ReadonlyArray<string | undefined>;
  roleBinding?: RoleBinding;
  role?: string;
}): React.ReactElement | null {
  const { ptyId, binding, paneCwds, roleBinding, role } = props;
  // The reactive decay clock — subscribing HERE (not in Pane) is the whole point.
  const agentClockMs = useStore((s) => s.agentClockMs);
  const activityAt = useStore((s) => s.surfaceActivityAt[ptyId] ?? 0);
  const status = useStore((s) => s.surfaceAgentStatus[ptyId]);
  // OSC 133 authoritative shell state (undefined = shell integration off →
  // process-truth tier, then heuristic fallback inside isPaneAgentBusy).
  const commandRunning = useStore((s) => s.commandRunningByPtyId[ptyId]);
  // Process-truth agent liveness (daemon AgentProcessTracker) — the edge
  // trigger that keeps 복구 disabled while a QUIET agent is still alive on a
  // pane without shell integration, and re-enables it on the exit edge.
  const agentProcessAlive = useStore((s) => s.agentAliveByPtyId[ptyId]);
  // The hook's turn latch. Without it a governed pane's quiet turn (no byte
  // output for two minutes) would decay out of the heuristic tier and arm 복구
  // over a live agent's TUI, which is precisely what the chip must not do.
  const turnOpen = useStore((s) => (s.surfaceTurnOpenAt[ptyId] ?? 0) > 0);
  const agentBusy = isPaneAgentBusy({ activityAt, agentClockMs, status, commandRunning, agentProcessAlive, turnOpen });
  return (
    <ResumeInfoChip
      ptyId={ptyId}
      binding={binding}
      paneCwds={paneCwds}
      roleBinding={roleBinding}
      role={role}
      agentBusy={agentBusy}
    />
  );
}
