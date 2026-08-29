import { beforeEach, describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { CLIENT_SOURCE } from '../src/client/main.js';

/**
 * The client runtime ships as source text, so the type checker never sees it. This exercises it
 * against a hand-built DOM stub instead: enough of the API surface to prove selection, keyboard
 * navigation, filtering and the theme toggle actually work.
 */

interface StubElement {
  tagName: string;
  hidden: boolean;
  tabIndex: number;
  value: string;
  textContent: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  offsetTop: number;
  offsetHeight: number;
  offsetWidth: number;
  focused: boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  focus(): void;
  blur(): void;
  scrollIntoView(): void;
  fire(type: string, event?: Record<string, unknown>): void;
}

function element(tagName: string, textContent = ''): StubElement {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    tagName,
    hidden: false,
    tabIndex: -1,
    value: '',
    textContent,
    attrs: {},
    style: {} as Record<string, string>,
    offsetTop: 0,
    offsetHeight: 24,
    offsetWidth: 400,
    focused: false,
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    focus() {
      this.focused = true;
    },
    blur() {
      this.focused = false;
    },
    scrollIntoView() {},
    fire(type, event = {}) {
      for (const fn of listeners[type] ?? []) fn(event);
    },
  };
}

function mount(labels: string[]) {
  const rows = labels.map((label) => element('BUTTON', label));
  const panes = labels.map(() => element('ARTICLE'));
  const filterBox = element('INPUT');
  const countBox = element('SPAN');
  const themeBtn = element('BUTTON');
  const playBtn = element('BUTTON');
  // Mirrors the shipped markup, which renders the control already in its resting state.
  playBtn.setAttribute('aria-pressed', 'false');
  const speedBtn = element('BUTTON');
  const progressBar = element('SPAN');
  const playhead = element('SPAN');
  const root = element('HTML');
  const byId: Record<string, StubElement> = {
    'orca-filter': filterBox,
    'orca-count': countBox,
    'orca-theme': themeBtn,
    'orca-play': playBtn,
    'orca-speed': speedBtn,
    'orca-progress': progressBar,
    'orca-playhead': playhead,
  };
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  const store: Record<string, string> = {};

  panes.forEach((pane, i) => {
    pane.hidden = i !== 0;
  });
  rows.forEach((row, i) => {
    row.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    // One recorded second between events, so playback timing has something real to compress.
    row.setAttribute('data-mono', String(i * 1_000_000));
    row.offsetTop = i * 24;
  });

  const document = {
    documentElement: root,
    querySelectorAll: (selector: string) => (selector === '.row' ? rows : panes),
    getElementById: (id: string) => byId[id] ?? null,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (docListeners[type] ??= []).push(fn);
    },
  };

  // A manual clock: playback is time-driven, and a test that waits on real timers is a test that
  // flakes. `flush` runs whatever is currently due, one step at a time.
  let pending: Array<{ id: number; fn: () => void }> = [];
  let nextTimerId = 1;

  const sandbox = {
    document,
    window: {
      matchMedia: (query: string) => ({ matches: query.includes('reduce') ? false : false }),
      addEventListener: () => {},
    },
    setTimeout: (fn: () => void) => {
      const id = nextTimerId++;
      pending.push({ id, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      pending = pending.filter((t) => t.id !== id);
    },
    Number,
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
    Math,
  };

  runInContext(CLIENT_SOURCE, createContext(sandbox));

  return {
    rows,
    panes,
    filterBox,
    countBox,
    themeBtn,
    playBtn,
    speedBtn,
    progressBar,
    playhead,
    root,
    store,
    /** Run every currently-scheduled timer once; returns how many fired. */
    tick() {
      const due = pending;
      pending = [];
      for (const t of due) t.fn();
      return due.length;
    },
    pendingTimers: () => pending.length,
    key(key: string, target: StubElement | null = null, mods: Record<string, boolean> = {}) {
      for (const fn of docListeners['keydown'] ?? []) {
        fn({ key, target, preventDefault() {}, ...mods });
      }
    },
    selectedIndex: () => rows.findIndex((row) => row.getAttribute('aria-selected') === 'true'),
  };
}

describe('client runtime', () => {
  let ui: ReturnType<typeof mount>;
  beforeEach(() => {
    ui = mount(['run started', 'npm test', 'exit 1', 'checkpoint']);
  });

  it('starts on the first row with only its pane showing', () => {
    expect(ui.selectedIndex()).toBe(0);
    expect(ui.panes.map((p) => p.hidden)).toEqual([false, true, true, true]);
    expect(ui.countBox.textContent).toBe('4 events');
  });

  it('moves with j and k and clamps at both ends', () => {
    ui.key('j');
    expect(ui.selectedIndex()).toBe(1);
    expect(ui.panes[1]!.hidden).toBe(false);
    expect(ui.panes[0]!.hidden).toBe(true);
    ui.key('k');
    ui.key('k');
    expect(ui.selectedIndex()).toBe(0);
    ui.key('ArrowUp');
    expect(ui.selectedIndex()).toBe(0);
  });

  it('moves with the arrow keys and Home/End', () => {
    ui.key('ArrowDown');
    ui.key('ArrowDown');
    expect(ui.selectedIndex()).toBe(2);
    ui.key('End');
    expect(ui.selectedIndex()).toBe(3);
    ui.key('Home');
    expect(ui.selectedIndex()).toBe(0);
  });

  it('keeps a roving tabindex so the list is one tab stop', () => {
    ui.key('j');
    expect(ui.rows.map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it('focuses the filter on / and filters rows as you type', () => {
    ui.key('/');
    expect(ui.filterBox.focused).toBe(true);
    ui.filterBox.value = 'npm';
    ui.filterBox.fire('input');
    expect(ui.rows.map((r) => r.hidden)).toEqual([true, false, true, true]);
    expect(ui.countBox.textContent).toBe('1 of 4');
    expect(ui.selectedIndex()).toBe(1);
  });

  it('does not steal keys typed into the filter box', () => {
    ui.filterBox.value = 'j';
    ui.key('j', ui.filterBox);
    expect(ui.selectedIndex()).toBe(0);
  });

  it('clears the filter on Escape and returns to the list', () => {
    ui.filterBox.value = 'checkpoint';
    ui.filterBox.fire('input');
    expect(ui.rows.filter((r) => !r.hidden)).toHaveLength(1);
    ui.key('Escape', ui.filterBox);
    expect(ui.filterBox.value).toBe('');
    expect(ui.rows.filter((r) => !r.hidden)).toHaveLength(4);
  });

  it('skips filtered-out rows when navigating', () => {
    ui.filterBox.value = 'e';
    ui.filterBox.fire('input');
    const visible = ui.rows.map((r) => !r.hidden);
    expect(visible).toEqual([true, true, true, true]);
    ui.filterBox.value = 'exit';
    ui.filterBox.fire('input');
    ui.key('j');
    expect(ui.selectedIndex()).toBe(2);
  });

  it('cycles the theme auto to dark to light and remembers it', () => {
    expect(ui.root.getAttribute('data-theme')).toBe(null);
    expect(ui.themeBtn.textContent).toBe('auto');
    ui.themeBtn.fire('click');
    expect(ui.root.getAttribute('data-theme')).toBe('dark');
    expect(ui.store['orca-theme']).toBe('dark');
    ui.themeBtn.fire('click');
    expect(ui.root.getAttribute('data-theme')).toBe('light');
    ui.themeBtn.fire('click');
    expect(ui.root.getAttribute('data-theme')).toBe(null);
    expect(ui.store['orca-theme']).toBeUndefined();
  });

  it('ignores modified keystrokes so browser shortcuts still work', () => {
    ui.key('j', null, { ctrlKey: true });
    ui.key('j', null, { metaKey: true });
    ui.key('End', null, { altKey: true });
    expect(ui.selectedIndex()).toBe(0);
  });

  it('selects a row on click', () => {
    ui.rows[2]!.fire('click');
    expect(ui.selectedIndex()).toBe(2);
    expect(ui.panes[2]!.hidden).toBe(false);
  });

  it('survives a page with no rows at all', () => {
    expect(() => mount([])).not.toThrow();
  });
});

describe('playback', () => {
  let ui: ReturnType<typeof mount>;
  beforeEach(() => {
    ui = mount(['run started', 'npm test', 'exit 1', 'checkpoint']);
  });

  it('space starts playback and advances one row per tick', () => {
    ui.key(' ');
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('true');
    expect(ui.selectedIndex()).toBe(1);
    ui.tick();
    expect(ui.selectedIndex()).toBe(2);
  });

  it('space again pauses, and cancels the pending step', () => {
    ui.key(' ');
    expect(ui.pendingTimers()).toBe(1);
    ui.key(' ');
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('false');
    expect(ui.pendingTimers()).toBe(0);
  });

  it('stops of its own accord at the last row', () => {
    ui.key(' ');
    while (ui.pendingTimers() > 0) ui.tick();
    expect(ui.selectedIndex()).toBe(3);
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('restarts from the top when played again from the end', () => {
    ui.key(' ');
    while (ui.pendingTimers() > 0) ui.tick();
    ui.key(' ');
    expect(ui.selectedIndex()).toBe(0);
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('hands the wheel back the moment you navigate manually', () => {
    ui.key(' ');
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('true');
    ui.key('j');
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('false');
    expect(ui.pendingTimers()).toBe(0);
  });

  it('is interrupted by filtering too, which reflows the list under it', () => {
    ui.key(' ');
    ui.filterBox.value = 'test';
    ui.filterBox.fire('input');
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('moves the playhead to the selected row and marks it live', () => {
    expect(ui.playhead.getAttribute('data-on')).toBe('true');
    expect(ui.playhead.style.transform).toBe('translateY(0px)');
    ui.key('j');
    expect(ui.playhead.style.transform).toBe('translateY(24px)');
    expect(ui.playhead.style.height).toBe('24px');
  });

  it('advances the progress bar from empty to full', () => {
    expect(ui.progressBar.style.transform).toBe('scaleX(0)');
    ui.key('End');
    expect(ui.progressBar.style.transform).toBe('scaleX(1)');
  });

  it('cycles the speed control through the offered rates', () => {
    expect(ui.speedBtn.textContent).toBe('');
    ui.speedBtn.fire('click');
    expect(ui.speedBtn.textContent).toBe('4×');
    ui.speedBtn.fire('click');
    expect(ui.speedBtn.textContent).toBe('16×');
    ui.speedBtn.fire('click');
    expect(ui.speedBtn.textContent).toBe('1×');
  });

  it('the play button does the same thing as the key', () => {
    ui.playBtn.fire('click');
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('true');
    expect(ui.selectedIndex()).toBe(1);
  });

  it('does not hijack space while typing in the filter box', () => {
    ui.key(' ', ui.filterBox);
    expect(ui.playBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks the direction of travel on the pane it reveals', () => {
    ui.key('j');
    expect(ui.panes[1]!.getAttribute('data-dir')).toBe('down');
    ui.key('k');
    expect(ui.panes[0]!.getAttribute('data-dir')).toBe('up');
  });
});
