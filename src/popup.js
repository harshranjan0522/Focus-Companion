/**
 * Popup UI. Owns no state of its own: it asks the service worker for a
 * snapshot, renders it, and sends commands back.
 */

import {
  PHASE, CATEGORY, EMPTY_DAY,
  domainOf, dayKey, remainingMs, formatClock, formatDuration,
} from './shared.js';

const $ = (id) => document.getElementById(id);
const DIAL_CIRCUMFERENCE = 2 * Math.PI * 88;

let state = null;
let ticker = null;
let activeView = 'timer';
let chosenMinutes = 25;

/* ------------------------------------------------------------------ */

const send = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'Background did not respond');
    return res.data;
  });

async function refresh() {
  state = await send('GET_STATE');
  applyTheme(state.settings.theme);
  render();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  if (!state) return;
  renderTimer();
  renderCurrent();
  if (activeView === 'sites') renderSites();
  if (activeView === 'stats') renderStats();
  renderStreak();
}

function renderTimer() {
  const { session, settings } = state;
  const idle = session.phase === PHASE.IDLE;
  const paused = !!session.pausedAt;

  document.body.dataset.phase = idle ? 'idle' : session.phase;
  document.body.dataset.paused = String(paused);

  const left = idle ? chosenMinutes * 60_000 : remainingMs(session);
  $('clock').textContent = formatClock(left);

  $('phase-label').textContent = idle
    ? 'Ready'
    : paused ? 'Paused'
      : session.phase === PHASE.BREAK ? 'Break' : 'Focusing';

  $('goal-display').textContent = idle ? '' : (session.goal || '');

  // Dial sweeps from empty to full as the session is consumed.
  const progress = idle || !session.plannedMs
    ? 0
    : Math.min(1, 1 - left / session.plannedMs);
  $('dial-progress').style.strokeDashoffset =
    String(DIAL_CIRCUMFERENCE * (1 - progress));

  $('setup').hidden = !idle;
  $('controls').hidden = idle;

  if (!idle) {
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    const strict = settings.strictMode && session.phase === PHASE.FOCUS;
    $('stop').textContent = session.phase === PHASE.BREAK ? 'Skip' : 'End';
    $('stop').disabled = strict;
    $('strict-note').hidden = !strict;
  }
}

function renderCurrent() {
  const { current, session } = state;
  const domain = current.domain;

  $('current-domain').textContent = domain || 'No site';
  $('current-icon').hidden = !domain;
  if (domain) {
    $('current-icon').src = current.favIconUrl || fallbackIcon(domain);
    $('current-icon').onerror = function () { this.src = fallbackIcon(domain); };
  }

  const chip = $('current-chip');
  const category = current.category || CATEGORY.NEUTRAL;
  chip.textContent = { focus: 'Focus', distracting: 'Distracting', neutral: 'Neutral' }[category];
  chip.className = `chip chip-${category}`;

  for (const btn of $('classify').children) {
    btn.setAttribute('aria-selected', String(btn.dataset.set === category));
  }
  $('classify').hidden = !domain;

  // Budget meter: only meaningful for a distracting site during focus.
  const showBudget = domain
    && category === CATEGORY.DISTRACTING
    && session.phase === PHASE.FOCUS;
  $('budget').hidden = !showBudget;

  const allowedFor = current.allowedUntil - Date.now();
  if (allowedFor > 0) {
    $('current-note').textContent = `Snoozed for ${formatClock(allowedFor)}`;
  } else if (showBudget) {
    const total = state.settings.graceSeconds * 1000;
    const leftMs = Math.max(0, current.budgetMs ?? total);
    const pct = total ? Math.max(0, Math.min(100, (leftMs / total) * 100)) : 0;
    const fill = $('budget-fill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('low', pct < 25);
    $('budget-text').textContent = formatClock(leftMs);
    $('current-note').textContent = leftMs > 0 ? 'Time left here' : 'Out of time';
  } else {
    $('current-note').textContent = current.title || (domain ? 'Not counted' : 'No page in focus');
  }
}

function renderStreak() {
  const chip = $('streak');
  const days = state.streak.current || 0;
  chip.hidden = days < 1;
  chip.textContent = `🔥 ${days}`;
  chip.title = `${days}-day streak · best ${state.streak.best || days}`;
}

/* ---------- sites ---------------------------------------------------- */

async function renderSites() {
  const tabs = await chrome.tabs.query({});
  const list = $('tab-list');
  list.textContent = '';

  const seen = new Set();
  const rows = [];
  for (const tab of tabs) {
    const domain = domainOf(tab.url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    rows.push({ domain, title: tab.title || domain, favIconUrl: tab.favIconUrl, tabId: tab.id });
  }

  if (!rows.length) {
    list.append(el('div', { class: 'empty', text: 'No open web pages.' }));
  }

  for (const row of rows) {
    const category = categoryOf(row.domain);
    const item = el('div', { class: 'item' });

    const icon = el('img', { class: 'favicon', src: row.favIconUrl || fallbackIcon(row.domain) });
    icon.onerror = function () { this.src = fallbackIcon(row.domain); };

    const stack = el('div', { class: 'stack truncate' });
    stack.append(
      el('span', { class: 'item-title truncate', text: row.title }),
      el('span', { class: 'item-domain truncate', text: row.domain }),
    );

    item.append(icon, stack, miniToggle(row.domain, category));
    list.append(item);
  }

  // Blocked-site rules
  const blocked = Object.entries(state.rules)
    .filter(([, c]) => c === CATEGORY.DISTRACTING)
    .map(([d]) => d)
    .sort();

  $('rule-count').textContent = `${blocked.length} site${blocked.length === 1 ? '' : 's'}`;

  const ruleList = $('rule-list');
  ruleList.textContent = '';
  if (!blocked.length) {
    ruleList.append(el('div', { class: 'empty', text: 'Nothing is blocked yet.' }));
  }
  for (const domain of blocked.slice(0, 40)) {
    const item = el('div', { class: 'item' });
    item.append(
      el('img', { class: 'favicon', src: fallbackIcon(domain) }),
      el('span', { class: 'item-title truncate', text: domain, style: 'flex:1' }),
      iconButton('Remove', 'rule-remove', () =>
        send('SET_RULE', { domain, category: CATEGORY.NEUTRAL }).then(refresh)),
    );
    ruleList.append(item);
  }

  watchScroll(list);
  watchScroll(ruleList);
}

function miniToggle(domain, category) {
  const wrap = el('div', { class: 'mini-toggle' });
  const defs = [
    ['focus', 'Mark as focus', 'M20 6L9 17l-5-5'],
    ['distracting', 'Mark as distracting', 'M18 6L6 18M6 6l12 12'],
  ];
  for (const [set, label, path] of defs) {
    const btn = el('button', {
      class: `mini${category === set ? ' on' : ''}`,
      title: label,
      'aria-label': `${label} (${domain})`,
    });
    btn.dataset.set = set;
    btn.innerHTML = svgPath(path);
    btn.addEventListener('click', async () => {
      const next = category === set ? CATEGORY.NEUTRAL : set;
      await send('SET_RULE', { domain, category: next });
      await refresh();
      renderSites();
    });
    wrap.append(btn);
  }
  return wrap;
}

/* ---------- stats ---------------------------------------------------- */

function renderStats() {
  const today = { ...EMPTY_DAY, ...(state.stats[dayKey()] || {}) };

  $('s-focus').textContent = formatDuration(today.focusMs);
  $('s-sessions').textContent = String(today.completed);
  $('s-blocked').textContent = String(today.blocked);
  $('s-streak').textContent = String(state.streak.current || 0);

  // Seven-day bar chart, oldest to newest.
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const ts = Date.now() - i * 86_400_000;
    const key = dayKey(ts);
    days.push({
      key,
      isToday: i === 0,
      label: new Date(ts).toLocaleDateString(undefined, { weekday: 'narrow' }),
      ms: (state.stats[key]?.focusMs) || 0,
    });
  }

  const peak = Math.max(...days.map((d) => d.ms), 1);
  const chart = $('chart');
  chart.textContent = '';
  for (const day of days) {
    const col = el('div', { class: `bar-col${day.isToday ? ' today' : ''}` });
    const slot = el('div', { class: 'bar-slot' });
    const bar = el('div', { class: `bar${day.ms ? '' : ' is-empty'}` });
    bar.style.height = `${day.ms ? Math.max(6, (day.ms / peak) * 100) : 4}%`;
    bar.title = `${day.key}: ${formatDuration(day.ms)}`;
    slot.append(bar);
    col.append(slot, el('span', { class: 'bar-label', text: day.label }));
    chart.append(col);
  }

  $('week-total').textContent = formatDuration(days.reduce((sum, d) => sum + d.ms, 0));

  // On-task ratio: focused time that was not spent on a distracting site.
  const onTask = Math.max(0, today.focusMs - today.distractingMs);
  const pct = today.focusMs ? Math.round((onTask / today.focusMs) * 100) : null;
  $('ratio-fill').style.width = `${pct ?? 0}%`;
  $('ratio-pct').textContent = pct === null ? '—' : `${pct}%`;
  $('ratio-note').textContent = pct === null
    ? 'Start a session to begin tracking.'
    : `${formatDuration(onTask)} on task · ${formatDuration(today.distractingMs)} on distracting sites.`;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function categoryOf(domain) {
  if (domain in state.rules) return state.rules[domain];
  let best = null;
  for (const key of Object.keys(state.rules)) {
    if (domain.endsWith('.' + key) && (!best || key.length > best.length)) best = key;
  }
  return best ? state.rules[best] : CATEGORY.NEUTRAL;
}

function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (value != null) node.setAttribute(key, value);
  }
  return node;
}

function iconButton(label, className, onClick) {
  const btn = el('button', { class: `icon-btn ${className}`, title: label, 'aria-label': label });
  btn.innerHTML = svgPath('M18 6L6 18M6 6l12 12');
  btn.addEventListener('click', onClick);
  return btn;
}

function svgPath(d) {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

/** A deterministic coloured letter tile, so every site has an icon. */
function fallbackIcon(domain) {
  const letter = (domain || '?')[0].toUpperCase();
  let hash = 0;
  for (let i = 0; i < (domain || '').length; i++) hash = (hash * 31 + domain.charCodeAt(i)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <rect width="16" height="16" rx="4" fill="hsl(${hash} 62% 55%)"/>
    <text x="8" y="11.5" font-family="sans-serif" font-size="9.5" font-weight="700"
      fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/**
 * Fade the bottom edge of a scroll region while there is more to scroll to.
 * Re-evaluated on scroll so the fade clears once the end is reached.
 */
function watchScroll(node) {
  const update = () => {
    const overflowing = node.scrollHeight > node.clientHeight + 1;
    const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    node.classList.toggle('scroll-fade', overflowing && !atEnd);
  };
  if (!node.dataset.scrollWatched) {
    node.addEventListener('scroll', update, { passive: true });
    node.dataset.scrollWatched = 'true';
  }
  update();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'system';
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

$('tabs').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-view]');
  if (!btn) return;
  activeView = btn.dataset.view;
  for (const tab of $('tabs').children) {
    tab.setAttribute('aria-selected', String(tab === btn));
  }
  for (const view of ['timer', 'sites', 'stats']) {
    $(`view-${view}`).hidden = view !== activeView;
  }
  render();
});

$('presets').addEventListener('click', (event) => {
  const btn = event.target.closest('.preset');
  if (!btn) return;
  chosenMinutes = Number(btn.dataset.min);
  for (const preset of $('presets').children) preset.classList.toggle('is-on', preset === btn);
  renderTimer();
});

$('start').addEventListener('click', async () => {
  await send('START', { minutes: chosenMinutes, goal: $('goal').value.trim(), phase: PHASE.FOCUS });
  $('goal').value = '';
  await refresh();
});

$('goal').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('start').click();
});

$('pause').addEventListener('click', async () => {
  await send(state.session.pausedAt ? 'RESUME' : 'PAUSE');
  await refresh();
});

$('extend').addEventListener('click', async () => {
  await send('EXTEND', { minutes: 5 });
  await refresh();
});

$('stop').addEventListener('click', async () => {
  const result = await send(state.session.phase === PHASE.BREAK ? 'SKIP_BREAK' : 'STOP');
  if (result?.refused === 'strict') return;
  await refresh();
});

$('classify').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-set]');
  if (!btn || !state.current.domain) return;
  await send('SET_RULE', { domain: state.current.domain, category: btn.dataset.set });
  await refresh();
});

$('refresh').addEventListener('click', () => renderSites());

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('manage-rules').addEventListener('click', () => chrome.runtime.openOptionsPage());

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

// Storage is the source of truth; react when the worker changes it.
chrome.storage.onChanged.addListener(() => refresh());

refresh().then(() => {
  ticker = setInterval(() => {
    if (!state || state.session.phase === PHASE.IDLE || state.session.pausedAt) return;
    if (remainingMs(state.session) <= 0) return refresh();
    renderTimer();
    // Count the local budget down between background updates.
    if (state.current.budgetMs != null && state.current.category === CATEGORY.DISTRACTING) {
      state.current.budgetMs = Math.max(0, state.current.budgetMs - 1000);
      renderCurrent();
    }
  }, 1000);
});

window.addEventListener('unload', () => clearInterval(ticker));
