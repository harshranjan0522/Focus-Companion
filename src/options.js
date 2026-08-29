/**
 * Settings page: session timing, distraction handling, the rule list, and
 * local data export/import.
 */

import { CATEGORY, DEFAULT_SETTINGS, domainOf } from './shared.js';

const $ = (id) => document.getElementById(id);

const NUMBER_FIELDS = [
  'focusMinutes', 'breakMinutes', 'longBreakMinutes', 'sessionsUntilLongBreak',
  'graceSeconds', 'snoozeMinutes',
];
const TOGGLE_FIELDS = ['autoStartBreaks', 'pauseWhenIdle', 'strictMode', 'notifications'];
const SELECT_FIELDS = ['onExpire', 'theme'];

let state = null;
let ruleFilter = CATEGORY.DISTRACTING;
let savedTimer = null;

const send = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No response');
    return res.data;
  });

/* ------------------------------------------------------------------ */

async function load() {
  state = await send('GET_STATE');
  document.documentElement.dataset.theme = state.settings.theme || 'system';

  for (const key of [...NUMBER_FIELDS, ...SELECT_FIELDS]) {
    $(key).value = state.settings[key] ?? DEFAULT_SETTINGS[key];
  }
  for (const key of TOGGLE_FIELDS) {
    $(key).checked = Boolean(state.settings[key] ?? DEFAULT_SETTINGS[key]);
  }
  $('idle-label').textContent = String(state.settings.idleSeconds);

  renderRules();

  if (location.hash === '#welcome' && !state.onboarded) {
    $('welcome').hidden = false;
    $('seed-count').textContent = String(
      Object.values(state.rules).filter((c) => c === CATEGORY.DISTRACTING).length,
    );
  }
}

async function save(patch) {
  state.settings = await send('SAVE_SETTINGS', { settings: patch });
  document.documentElement.dataset.theme = state.settings.theme || 'system';
  flashSaved();
}

function flashSaved() {
  const badge = $('saved');
  badge.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { badge.hidden = true; }, 1600);
}

/* ---------- rules ---------- */

function renderRules() {
  const container = $('rules');
  container.textContent = '';

  const domains = Object.entries(state.rules)
    .filter(([, category]) => category === ruleFilter)
    .map(([domain]) => domain)
    .sort();

  if (!domains.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = ruleFilter === CATEGORY.DISTRACTING
      ? 'No blocked sites yet. Add one above.'
      : 'No explicitly allowed sites. Anything unlisted is already allowed.';
    container.append(empty);
    return;
  }

  for (const domain of domains) {
    const pill = document.createElement('span');
    pill.className = `rule ${ruleFilter}`;
    pill.append(document.createTextNode(domain));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `Remove ${domain}`;
    remove.setAttribute('aria-label', `Remove ${domain}`);
    remove.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
    remove.addEventListener('click', async () => {
      state.rules = await send('SET_RULE', { domain, category: CATEGORY.NEUTRAL });
      renderRules();
      flashSaved();
    });

    pill.append(remove);
    container.append(pill);
  }

  watchScroll(container);
}

/** Fade the foot of the pill list while more rules remain below the fold. */
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

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

for (const key of NUMBER_FIELDS) {
  $(key).addEventListener('change', (event) => {
    const input = event.target;
    const min = Number(input.min);
    const max = Number(input.max);
    let value = Number(input.value);
    if (!Number.isFinite(value)) value = DEFAULT_SETTINGS[key];
    value = Math.min(max, Math.max(min, Math.round(value)));
    input.value = value;
    save({ [key]: value });
  });
}

for (const key of TOGGLE_FIELDS) {
  $(key).addEventListener('change', (event) => save({ [key]: event.target.checked }));
}

for (const key of SELECT_FIELDS) {
  $(key).addEventListener('change', (event) => save({ [key]: event.target.value }));
}

$('rule-filter').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-filter]');
  if (!btn) return;
  ruleFilter = btn.dataset.filter;
  for (const child of $('rule-filter').children) {
    child.setAttribute('aria-selected', String(child === btn));
  }
  renderRules();
});

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('add-domain');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;

  // Accept a bare domain or a pasted URL.
  const domain = domainOf(raw.includes('://') ? raw : `https://${raw}`);
  if (!domain) {
    input.setCustomValidity('That does not look like a domain.');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  state.rules = await send('SET_RULE', { domain, category: ruleFilter });
  input.value = '';
  renderRules();
  flashSaved();
});

$('add-domain').addEventListener('input', (event) => event.target.setCustomValidity(''));

$('dismiss-welcome').addEventListener('click', async () => {
  $('welcome').hidden = true;
  await chrome.storage.local.set({ onboarded: true });
});

/* ---------- data ---------- */

$('export').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `focus-companion-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  $('data-note').textContent = 'Exported.';
});

$('import').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object') throw new Error('Not a settings file');

    if (parsed.settings) await send('SAVE_SETTINGS', { settings: parsed.settings });
    if (parsed.rules) await send('IMPORT_RULES', { rules: parsed.rules });
    if (parsed.stats) await chrome.storage.local.set({ stats: parsed.stats });

    await load();
    $('data-note').textContent = 'Imported. Existing rules were kept and merged.';
  } catch (error) {
    $('data-note').textContent = `Could not import that file: ${error.message}`;
  } finally {
    event.target.value = '';
  }
});

$('reset').addEventListener('click', async () => {
  // A single click should not be able to wipe weeks of history.
  const button = $('reset');
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true';
    button.textContent = 'Click again to erase everything';
    setTimeout(() => {
      button.dataset.armed = 'false';
      button.textContent = 'Reset everything';
    }, 4000);
    return;
  }
  button.dataset.armed = 'false';
  button.textContent = 'Reset everything';
  await send('RESET_ALL');
  await load();
  $('data-note').textContent = 'Everything has been reset to defaults.';
});

load();
