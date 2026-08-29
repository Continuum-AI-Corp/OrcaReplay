/**
 * The viewer's entire client runtime, held as source text so that `renderTraceHtml` stays
 * synchronous and the published package carries no build-time coupling to its own sources.
 * `bundleViewerScript()` in `../bundle.ts` minifies this with esbuild when it is available.
 *
 * Two rules keep the XSS surface at exactly one function (`escapeHtml`, server side):
 *   1. this script never turns a string into markup — no innerHTML, no insertAdjacentHTML;
 *   2. no trace content is ever interpolated into it.
 * Plain ES2019, no framework, no polyfills, no network.
 */
export const CLIENT_SOURCE = `
(function () {
  'use strict';

  var root = document.documentElement;
  var rows = [].slice.call(document.querySelectorAll('.row'));
  var panes = [].slice.call(document.querySelectorAll('.pane'));
  var filterBox = document.getElementById('orca-filter');
  var countBox = document.getElementById('orca-count');
  var themeBtn = document.getElementById('orca-theme');
  var haystack = rows.map(function (row) { return (row.textContent || '').toLowerCase(); });
  var selected = rows.length ? 0 : -1;

  function shown() {
    return rows.filter(function (row) { return !row.hidden; });
  }

  function select(index, moveFocus) {
    if (index < 0 || index >= rows.length) return;
    for (var i = 0; i < rows.length; i++) {
      var on = i === index;
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      rows[i].tabIndex = on ? 0 : -1;
      if (panes[i]) panes[i].hidden = !on;
    }
    selected = index;
    if (moveFocus) rows[index].focus();
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  function step(delta) {
    var list = shown();
    if (!list.length) return;
    var at = selected < 0 ? -1 : list.indexOf(rows[selected]);
    var next = at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + delta));
    select(rows.indexOf(list[next]), true);
  }

  function jump(toEnd) {
    var list = shown();
    if (!list.length) return;
    select(rows.indexOf(toEnd ? list[list.length - 1] : list[0]), true);
  }

  function applyFilter() {
    var q = (filterBox ? filterBox.value : '').toLowerCase().trim();
    var visible = 0;
    for (var i = 0; i < rows.length; i++) {
      var on = q === '' || haystack[i].indexOf(q) >= 0;
      rows[i].hidden = !on;
      if (on) visible++;
    }
    if (countBox) {
      countBox.textContent = q === ''
        ? rows.length + (rows.length === 1 ? ' event' : ' events')
        : visible + ' of ' + rows.length;
    }
    if (visible && selected >= 0 && rows[selected].hidden) select(rows.indexOf(shown()[0]), false);
  }

  for (var i = 0; i < rows.length; i++) {
    (function (index) {
      rows[index].addEventListener('click', function () { select(index, false); });
    })(i);
  }

  if (filterBox) filterBox.addEventListener('input', applyFilter);

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (filterBox) { filterBox.value = ''; applyFilter(); filterBox.blur(); }
        if (rows.length) select(selected < 0 ? 0 : selected, true);
      } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        var list = shown();
        if (list.length) select(rows.indexOf(list[0]), true);
      }
      return;
    }
    if (e.key === '/') { e.preventDefault(); if (filterBox) filterBox.focus(); }
    else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); jump(false); }
    else if (e.key === 'End') { e.preventDefault(); jump(true); }
  });

  function readTheme() {
    try { return localStorage.getItem('orca-theme'); } catch (err) { return null; }
  }
  function writeTheme(value) {
    try {
      if (value) localStorage.setItem('orca-theme', value);
      else localStorage.removeItem('orca-theme');
    } catch (err) { /* private mode, blocked storage: the page still works */ }
  }
  function applyTheme(value) {
    if (value === 'dark' || value === 'light') root.setAttribute('data-theme', value);
    else root.removeAttribute('data-theme');
    if (themeBtn) themeBtn.textContent = value || 'auto';
  }

  applyTheme(readTheme());
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var current = root.getAttribute('data-theme');
      var next = current === 'dark' ? 'light' : current === 'light' ? null : 'dark';
      applyTheme(next);
      writeTheme(next);
    });
  }

  applyFilter();
})();
`;
