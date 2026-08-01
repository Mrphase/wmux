// Event-driven self-heal for the shared-atlas page-merge corruption class
// (reported 2026-08-01; see TODOS.md).
//
// Root cause (verified against @xterm/addon-webgl 0.19 internals): the WebGL
// glyph texture atlas is SHARED across every same-config terminal
// (acquireTextureAtlas keeps a module-level cache). Its page pool caps at
// `min(32, MAX_TEXTURE_IMAGE_UNITS)` — 16 on Apple Silicon — and when full,
// `_createNewPage()` MERGES four pages into one and DELETES the originals,
// rewriting glyph texturePage indices and shifting the pages behind them. The
// renderers of panes sharing the atlas keep diff-skipped vertex data pointing
// at the old indices and sample the wrong page: scattered wrong glyphs across
// several panes at once that plain refresh()/resize cannot repair (refresh
// re-rasters rows, but `_updateModel` diff-skips cells whose code/colors did
// not change, so the stale vertex entries survive). Opening a new split pane
// "fixed" every pane only because its mount recreates a WebGL addon, which
// rebuilds the glyph model against the post-merge atlas.
//
// CJK is the realistic trigger workload: Hangul alone has 11,172 distinct
// syllables, so Korean-heavy sessions mint new glyphs continuously and are
// how a 16-page pool actually fills.
//
// Strategy — heal at the exact moment the damage can happen, via PUBLIC API
// only (multi-model review of the earlier poll-based design concluded that
// polling internals + clearTexture()+refresh() was both racy and itself
// corrupting, since refresh never rebuilds the diff-skipped vertex model):
//
//   - `WebglAddon.onRemoveTextureAtlasCanvas` fires when the shared atlas
//     deletes pages — which happens ONLY on a merge. The atlas forwards the
//     event through each owner's renderer to each owner's addon, so every
//     pane sharing the atlas hears about the merge on its own addon.
//   - Each pane then calls its own `WebglAddon.clearTextureAtlas()`, which
//     clears the shared texture, CLEARS THAT PANE'S GLYPH MODEL, and requests
//     a redraw. The atlas-level texture clear no-ops after the first pane ran
//     it (its internal page-0 guard), so N sharing panes converge to: one
//     texture clear + every pane's model rebuilt — the coherent all-owners
//     rebuild upstream itself performs on font changes. The #191 hazard
//     (clearing from one pane while siblings keep stale references) cannot
//     occur, because every sharing pane receives the same event.
//
// The heal is DEFERRED (one macrotask): the event fires synchronously inside
// the atlas's own mutation during a render pass, and clearTextureAtlas must
// not run re-entrantly there. A merge deletes several pages back-to-back, so
// the deferral also coalesces the burst into a single heal.
//
// No timers while idle, no registry, no internal-field reads. If upstream
// ever drops the event or the method, attach degrades to a no-op — never a
// crash.

interface Disposable {
  dispose(): void;
}

/** The subset of WebglAddon this heal needs — both members are public API. */
export interface AtlasMergeHealAddon {
  onRemoveTextureAtlasCanvas?: (listener: (canvas: unknown) => void) => Disposable;
  clearTextureAtlas?: () => void;
}

export interface AtlasMergeHealOptions {
  /** Injectable scheduler for tests. Defaults to setTimeout(fn, 0). */
  defer?: (fn: () => void) => () => void;
}

const defaultDefer = (fn: () => void): (() => void) => {
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
};

/** Returned when the addon cannot be subscribed — disposal has nothing to do. */
function noopDispose(): void {
  return;
}

/**
 * Subscribe the addon to its own atlas's page-removal events and heal on
 * each merge burst. Returns a dispose function; call it before/with the
 * addon's teardown. Attaching to an addon without the event returns a no-op
 * disposer (silent degradation on upstream reshape).
 */
export function attachAtlasMergeHeal(
  addon: AtlasMergeHealAddon,
  options: AtlasMergeHealOptions = {},
): () => void {
  const { defer = defaultDefer } = options;
  if (typeof addon.onRemoveTextureAtlasCanvas !== 'function') {
    return noopDispose;
  }

  let disposed = false;
  let cancelPending: (() => void) | null = null;

  let listener: Disposable | null = null;
  try {
    listener = addon.onRemoveTextureAtlasCanvas(() => {
      if (disposed || cancelPending) return; // burst already scheduled
      cancelPending = defer(() => {
        cancelPending = null;
        if (disposed) return;
        console.warn('[wmux:atlas-heal] shared atlas page-merge detected — rebuilding glyph model');
        try {
          addon.clearTextureAtlas?.();
        } catch {
          // addon mid-teardown — the recreated addon starts from a clean model anyway
        }
      });
    });
  } catch {
    return noopDispose; // subscription itself failed — degrade silently
  }

  return () => {
    disposed = true;
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
    try {
      listener?.dispose();
    } catch {
      // emitter already disposed with the addon
    }
  };
}
