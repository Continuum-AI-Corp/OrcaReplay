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
  const root = element('HTML');
  const byId: Record<string, StubElement> = {
    'orca-filter': filterBox,
    'orca-count': countBox,
    'orca-theme': themeBtn,
  };
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  const store: Record<string, string> = {};

  panes.forEach((pane, i) => {
    pane.hidden = i !== 0;
  });
  rows.forEach((row, i) => {
    row.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
  });

  const document = {
    documentElement: root,
    querySelectorAll: (selector: string) => (selector === '.row' ? rows : panes),
    getElementById: (id: string) => byId[id] ?? null,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (docListeners[type] ??= []).push(fn);
    },
  };

  const sandbox = {
    document,
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
    root,
    store,
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
