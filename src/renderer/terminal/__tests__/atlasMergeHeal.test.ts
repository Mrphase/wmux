import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachAtlasMergeHeal, type AtlasMergeHealAddon } from '../atlasMergeHeal';

// Fake of the two PUBLIC WebglAddon members the heal uses. Mirrors xterm's
// emitter contract: subscribing returns a Disposable.
class FakeAddon implements AtlasMergeHealAddon {
  listeners = new Set<(canvas: unknown) => void>();
  clearCalls = 0;
  clearThrows = false;

  onRemoveTextureAtlasCanvas = (listener: (canvas: unknown) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  clearTextureAtlas = (): void => {
    if (this.clearThrows) throw new Error('mid-teardown');
    this.clearCalls++;
  };

  fireRemove(): void {
    for (const l of [...this.listeners]) l({});
  }
}

describe('atlasMergeHeal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('heals (clearTextureAtlas) after a page-removal event, deferred out of the render pass', () => {
    const addon = new FakeAddon();
    attachAtlasMergeHeal(addon);
    addon.fireRemove();
    expect(addon.clearCalls).toBe(0); // NOT synchronous — the event fires mid-render
    vi.runAllTimers();
    expect(addon.clearCalls).toBe(1);
  });

  it('coalesces an event burst (a merge deletes several pages) into ONE heal', () => {
    const addon = new FakeAddon();
    attachAtlasMergeHeal(addon);
    addon.fireRemove();
    addon.fireRemove();
    addon.fireRemove();
    addon.fireRemove(); // merge fires one remove per deleted page
    vi.runAllTimers();
    expect(addon.clearCalls).toBe(1);
  });

  it('heals again on a later, separate merge', () => {
    const addon = new FakeAddon();
    attachAtlasMergeHeal(addon);
    addon.fireRemove();
    vi.runAllTimers();
    addon.fireRemove();
    vi.runAllTimers();
    expect(addon.clearCalls).toBe(2);
  });

  it('dispose unsubscribes and cancels a pending heal', () => {
    const addon = new FakeAddon();
    const dispose = attachAtlasMergeHeal(addon);
    addon.fireRemove(); // heal pending
    dispose();
    vi.runAllTimers();
    expect(addon.clearCalls).toBe(0);
    expect(addon.listeners.size).toBe(0);
    addon.fireRemove(); // fully detached — nothing scheduled
    vi.runAllTimers();
    expect(addon.clearCalls).toBe(0);
  });

  it('degrades to a no-op when the addon lacks the event (upstream reshape)', () => {
    const dispose = attachAtlasMergeHeal({});
    expect(() => dispose()).not.toThrow();
  });

  it('a throwing clearTextureAtlas (addon mid-teardown) is swallowed', () => {
    const addon = new FakeAddon();
    addon.clearThrows = true;
    attachAtlasMergeHeal(addon);
    addon.fireRemove();
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it('a listener whose emitter is already disposed does not break the disposer', () => {
    const addon = new FakeAddon();
    addon.onRemoveTextureAtlasCanvas = () => ({
      dispose: () => { throw new Error('emitter already disposed'); },
    });
    const dispose = attachAtlasMergeHeal(addon);
    expect(() => dispose()).not.toThrow();
  });

  it('supports an injected defer (scheduler abstraction honored)', () => {
    const addon = new FakeAddon();
    let scheduled: (() => void) | null = null;
    attachAtlasMergeHeal(addon, {
      defer: (fn) => {
        scheduled = fn;
        return () => { scheduled = null; };
      },
    });
    addon.fireRemove();
    expect(addon.clearCalls).toBe(0);
    expect(scheduled).not.toBeNull();
    (scheduled as unknown as () => void)();
    expect(addon.clearCalls).toBe(1);
  });
});
