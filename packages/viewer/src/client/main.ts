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
  var playBtn = document.getElementById('orca-play');
  var speedBtn = document.getElementById('orca-speed');
  var progressBar = document.getElementById('orca-progress');
  var playhead = document.getElementById('orca-playhead');
  // Guarded rather than assumed: this script is also evaluated outside a full browser global
  // (its own test harness runs it against a DOM stub), and motion is the first thing that should
  // degrade, never the navigation.
  var mq = typeof window !== 'undefined' && window.matchMedia;
  var reduced = mq ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  var SPEEDS = [1, 4, 16];
  var speedIndex = 0;
  var timer = null;
  var playing = false;
  var haystack = rows.map(function (row) { return (row.textContent || '').toLowerCase(); });
  var selected = rows.length ? 0 : -1;

  function shown() {
    return rows.filter(function (row) { return !row.hidden; });
  }

  function select(index, moveFocus) {
    if (index < 0 || index >= rows.length) return;
    var back = selected >= 0 && index < selected;
    for (var i = 0; i < rows.length; i++) {
      var on = i === index;
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      rows[i].tabIndex = on ? 0 : -1;
      if (panes[i]) panes[i].hidden = !on;
    }
    selected = index;
    if (!reduced && panes[index]) {
      // Restart the animation on every move: removing then forcing layout is the only reliable
      // way to replay a CSS animation on an element that never left the DOM.
      var pane = panes[index];
      pane.removeAttribute('data-dir');
      void pane.offsetWidth;
      pane.setAttribute('data-dir', back ? 'up' : 'down');
    }
    if (moveFocus) rows[index].focus();
    rows[index].scrollIntoView({ block: 'nearest' });
    movePlayhead();
    updateProgress();
  }

  function movePlayhead() {
    if (!playhead || selected < 0) return;
    var row = rows[selected];
    playhead.style.height = row.offsetHeight + 'px';
    playhead.style.transform = 'translateY(' + row.offsetTop + 'px)';
    playhead.setAttribute('data-on', 'true');
  }

  function updateProgress() {
    if (!progressBar || !rows.length) return;
    var fraction = rows.length < 2 ? 1 : selected / (rows.length - 1);
    progressBar.style.transform = 'scaleX(' + (selected < 0 ? 0 : fraction) + ')';
  }

  /**
   * Hold on each row for as long as the recording says the gap was, compressed. A uniform tick
   * would be simpler and would throw away the only thing playback adds over pressing j: the feel
   * of where the run stalled and where it span.
   */
  function delayFor(index) {
    var list = shown();
    var at = list.indexOf(rows[index]);
    if (at <= 0) return 0;
    var previous = Number(list[at - 1].getAttribute('data-mono')) || 0;
    var current = Number(list[at].getAttribute('data-mono')) || 0;
    var gapMs = Math.max(0, (current - previous) / 1000);
    var compressed = Math.sqrt(gapMs / SPEEDS[speedIndex]) * 24;
    return Math.min(1000, Math.max(60, Math.round(compressed)));
  }

  function pulse(index) {
    if (reduced || !rows[index]) return;
    if (rows[index].getAttribute('data-tone') !== 'attention') return;
    rows[index].removeAttribute('data-pulse');
    void rows[index].offsetWidth;
    rows[index].setAttribute('data-pulse', 'true');
  }

  function setPlaying(on, stepNow) {
    playing = on;
    if (playBtn) playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on && timer) { clearTimeout(timer); timer = null; }
    if (!on) return;
    // Stepping immediately is what makes pressing play feel responsive — except on a restart,
    // where we have just moved to the first row and stepping now would skip straight past it.
    if (stepNow === false) timer = setTimeout(tick, delayFor(selected));
    else tick();
  }

  function tick() {
    if (!playing) return;
    var list = shown();
    if (!list.length) { setPlaying(false); return; }
    var at = selected < 0 ? -1 : list.indexOf(rows[selected]);
    if (at >= list.length - 1) { setPlaying(false); return; }
    var nextIndex = rows.indexOf(list[at + 1]);
    select(nextIndex, false);
    pulse(nextIndex);
    timer = setTimeout(tick, delayFor(nextIndex));
  }

  function togglePlay() {
    if (playing) { setPlaying(false); return; }
    var list = shown();
    if (!list.length) return;
    // Reaching the end and pressing play again starts over, rather than doing nothing.
    var atEnd = selected < 0 || list.indexOf(rows[selected]) >= list.length - 1;
    if (atEnd) {
      select(rows.indexOf(list[0]), false);
      setPlaying(true, false);
      return;
    }
    setPlaying(true);
  }

  /** Any manual navigation takes the wheel back. */
  function interrupt() {
    if (playing) setPlaying(false);
  }

  function step(delta) {
    interrupt();
    var list = shown();
    if (!list.length) return;
    var at = selected < 0 ? -1 : list.indexOf(rows[selected]);
    var next = at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + delta));
    select(rows.indexOf(list[next]), true);
  }

  function jump(toEnd) {
    interrupt();
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
    else movePlayhead();
  }

  for (var i = 0; i < rows.length; i++) {
    (function (index) {
      rows[index].addEventListener('click', function () { interrupt(); select(index, false); });
    })(i);
  }

  if (filterBox) filterBox.addEventListener('input', function () { interrupt(); applyFilter(); });

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
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); togglePlay(); }
    else if (e.key === '/') { e.preventDefault(); if (filterBox) filterBox.focus(); }
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

  if (playBtn) playBtn.addEventListener('click', togglePlay);
  if (speedBtn) {
    speedBtn.addEventListener('click', function () {
      speedIndex = (speedIndex + 1) % SPEEDS.length;
      speedBtn.textContent = SPEEDS[speedIndex] + '\u00d7';
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', movePlayhead);
  }

  applyFilter();
  if (rows.length) { movePlayhead(); updateProgress(); }
})();
`;
