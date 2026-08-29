/**
 * The block interstitial. Replaces a distracting page rather than closing the
 * tab, so nothing the user was doing is destroyed — and offers a deliberate,
 * slightly effortful way back in.
 */

import { PHASE, EMPTY_DAY, dayKey, remainingMs, formatClock, formatDuration } from './shared.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const domain = params.get('domain') || '';
const from = params.get('from') || '';

let state = null;

const send = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No response');
    return res.data;
  });

async function load() {
  state = await send('GET_STATE');
  document.documentElement.dataset.theme = state.settings.theme || 'system';

  if (domain) $('domain').textContent = domain;
  // Set as one text node: .btn is a flex row, so a nested <span> would be gapped.
  $('snooze').textContent = `Give me ${state.settings.snoozeMinutes} more minutes`;

  const strict = state.settings.strictMode && state.session.phase === PHASE.FOCUS;
  $('end-session').hidden = strict;
  $('strict-note').hidden = !strict;

  const today = { ...EMPTY_DAY, ...(state.stats[dayKey()] || {}) };
  $('s-focus').textContent = formatDuration(today.focusMs);
  $('s-blocked').textContent = String(today.blocked);
  $('s-streak').textContent = String(state.streak.current || 0);
  $('stats-strip').hidden = false;

  $('goal').textContent = state.session.goal || '';
  $('session-card').hidden = state.session.phase === PHASE.IDLE;

  if (state.session.phase === PHASE.IDLE) {
    $('lede').textContent = 'Your focus session has ended, so this page is free again.';
  }

  tick();
}

function tick() {
  if (!state || state.session.phase === PHASE.IDLE) return;
  const left = remainingMs(state.session);
  $('remaining').textContent = formatClock(left);

  const planned = state.session.plannedMs || 1;
  $('progress-fill').style.width = `${Math.min(100, ((planned - left) / planned) * 100)}%`;

  if (left <= 0) load();
}

/* ---------- actions ---------- */

$('back').addEventListener('click', () => {
  // Prefer real history so the user lands where they were working.
  if (history.length > 1) history.back();
  else chrome.tabs.getCurrent().then((tab) => tab && chrome.tabs.remove(tab.id));
});

$('snooze').addEventListener('click', async () => {
  await send('SNOOZE', { domain });
  if (from) location.replace(from);
});

$('end-session').addEventListener('click', async () => {
  const result = await send('STOP');
  if (result?.refused === 'strict') return load();
  if (from) location.replace(from);
});

setInterval(tick, 1000);
load();
