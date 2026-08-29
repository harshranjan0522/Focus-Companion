/**
 * Focus Companion — background service worker.
 *
 * MV3 tears this worker down whenever it is idle, so it is written to be
 * completely stateless between invocations: every handler reloads from storage,
 * and every future deadline is registered with chrome.alarms rather than
 * setTimeout. A setTimeout is used *in addition* to an alarm only to get
 * sub-30-second precision while the worker happens to be alive.
 */

import {
  CATEGORY, PHASE, EMPTY_SESSION, EMPTY_DAY,
  getState, patchState, domainOf, categoryFor,
  dayKey, remainingMs, newSessionId, formatDuration,
} from './shared.js';

const TICK_ALARM = 'fc:tick';
const SESSION_ALARM = 'fc:session-end';
const BUDGET_ALARM = 'fc:budget-end';

const BADGE = {
  focus: '#6366F1',
  break: '#10B981',
  danger: '#EF4444',
};

/** Precise in-memory timer; only valid while this worker instance lives. */
let budgetTimeout = null;

/**
 * Heartbeats are triggered by alarms *and* by tab events, which can overlap.
 * Two concurrent runs would each read the same `lastAccrualAt` and credit the
 * same elapsed slice twice, so only one runs at a time.
 *
 * A heartbeat can also re-enter itself — finishing a session auto-starts the
 * break, which asks for a repaint — so a nested call must never await the run
 * it is nested inside. It coalesces into one follow-up pass instead.
 */
let heartbeatRunning = false;
let heartbeatQueued = false;

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  // Touch state once so migration from v1 runs and defaults are persisted.
  const state = await getState();
  await patchState({
    version: state.version,
    settings: state.settings,
    rules: state.rules,
    seeded: true,
  });
  await ensureAlarms();
  await applyIdleSetting(state.settings.idleSeconds);
  await heartbeat();

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await ensureAlarms();
  await applyIdleSetting(state.settings.idleSeconds);
  await heartbeat();
});

async function ensureAlarms() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK_ALARM || alarm.name === BUDGET_ALARM) return heartbeat();
  if (alarm.name === SESSION_ALARM) return heartbeat();
});

/* ------------------------------------------------------------------ *
 * Session control
 * ------------------------------------------------------------------ */

async function startSession({ phase = PHASE.FOCUS, minutes, goal = '' } = {}) {
  const state = await getState();
  const s = state.settings;
  const len = minutes ?? (
    phase === PHASE.FOCUS ? s.focusMinutes
      : isLongBreakNext(state) ? s.longBreakMinutes : s.breakMinutes
  );
  const now = Date.now();
  const session = {
    ...EMPTY_SESSION,
    phase,
    startedAt: now,
    endsAt: now + len * 60_000,
    plannedMs: len * 60_000,
    cycle: state.session.cycle || 0,
    goal: phase === PHASE.FOCUS ? goal : state.session.goal || '',
    id: newSessionId(),
  };

  const patch = {
    session,
    runtime: { lastAccrualAt: now, warnedDomains: [] },
  };
  // Every focus session gets a fresh budget for each distracting site.
  if (phase === PHASE.FOCUS) {
    patch.budgets = {};
    patch.allowances = {};
    patch.stats = bumpDay(state.stats, now, { started: 1 });
  }
  await patchState(patch);

  chrome.alarms.create(SESSION_ALARM, { when: session.endsAt });
  await heartbeat();
  notify(
    phase === PHASE.FOCUS ? 'Focus session started' : 'Break time',
    phase === PHASE.FOCUS
      ? (goal ? `${len} minutes on: ${goal}` : `${len} minutes of deep work. Go.`)
      : `${len} minutes away from the screen.`,
    state.settings,
  );
  return session;
}

async function stopSession({ completed = false } = {}) {
  const state = await getState();
  const session = state.session;
  if (session.phase === PHASE.IDLE) return session;

  const now = Date.now();
  // Credit the final slice of time before the session is torn down.
  const accrued = await accrue(state, now);

  const wasFocus = session.phase === PHASE.FOCUS;
  const stats = bumpDay(accrued.stats, now, wasFocus
    ? (completed ? { completed: 1 } : { abandoned: 1 })
    : {});

  let streak = state.streak;
  let nextCycle = session.cycle;

  if (wasFocus && completed) {
    nextCycle = session.cycle + 1;
    streak = bumpStreak(state.streak, now);
  }

  await patchState({
    session: { ...EMPTY_SESSION, cycle: nextCycle, goal: session.goal },
    stats,
    streak,
    budgets: wasFocus ? {} : state.budgets,
    runtime: { lastAccrualAt: 0, warnedDomains: [] },
  });

  chrome.alarms.clear(SESSION_ALARM);
  chrome.alarms.clear(BUDGET_ALARM);
  clearBudgetTimeout();
  await paintBadge();

  if (completed && wasFocus) {
    const total = todayStats(stats).focusMs;
    notify('Focus session complete', `${formatDuration(session.plannedMs)} done — ${formatDuration(total)} focused today.`, state.settings);
    if (state.settings.autoStartBreaks) {
      await startSession({ phase: PHASE.BREAK });
    }
  } else if (completed) {
    notify('Break over', 'Ready for the next block?', state.settings);
  }

  return { ...EMPTY_SESSION, cycle: nextCycle };
}

async function pauseSession() {
  const state = await getState();
  if (state.session.phase === PHASE.IDLE || state.session.pausedAt) return state.session;
  const now = Date.now();
  const accrued = await accrue(state, now);
  const session = { ...state.session, pausedAt: now };
  await patchState({
    session,
    stats: accrued.stats,
    budgets: accrued.budgets,
    runtime: accrued.runtime,
  });
  chrome.alarms.clear(SESSION_ALARM);
  clearBudgetTimeout();
  await paintBadge();
  return session;
}

async function resumeSession() {
  const state = await getState();
  const session = state.session;
  if (session.phase === PHASE.IDLE || !session.pausedAt) return session;
  const now = Date.now();
  const pausedFor = now - session.pausedAt;
  const next = {
    ...session,
    pausedAt: 0,
    pausedMs: session.pausedMs + pausedFor,
    endsAt: session.endsAt + pausedFor, // the clock owes you the paused time back
  };
  await patchState({ session: next, runtime: { ...(state.runtime || {}), lastAccrualAt: now } });
  chrome.alarms.create(SESSION_ALARM, { when: next.endsAt });
  await heartbeat();
  return next;
}

async function extendSession(minutes) {
  const state = await getState();
  if (state.session.phase === PHASE.IDLE) return state.session;
  const next = {
    ...state.session,
    endsAt: state.session.endsAt + minutes * 60_000,
    plannedMs: state.session.plannedMs + minutes * 60_000,
  };
  await patchState({ session: next });
  if (!next.pausedAt) chrome.alarms.create(SESSION_ALARM, { when: next.endsAt });
  await heartbeat();
  return next;
}

function isLongBreakNext(state) {
  const n = state.settings.sessionsUntilLongBreak;
  return n > 0 && state.session.cycle > 0 && state.session.cycle % n === 0;
}

/* ------------------------------------------------------------------ *
 * The heartbeat: accrue time, police the current tab, repaint
 * ------------------------------------------------------------------ */

async function heartbeat() {
  if (heartbeatRunning) { heartbeatQueued = true; return; }
  heartbeatRunning = true;
  try {
    do {
      heartbeatQueued = false;
      await runHeartbeat();
    } while (heartbeatQueued);
  } finally {
    heartbeatRunning = false;
  }
}

async function runHeartbeat() {
  const state = await getState();
  const now = Date.now();
  const session = state.session;

  if (session.phase === PHASE.IDLE) {
    await paintBadge(state);
    return;
  }

  if (remainingMs(session, now) <= 0 && !session.pausedAt) {
    await stopSession({ completed: true });
    return;
  }

  if (session.pausedAt) {
    await paintBadge(state);
    return;
  }

  const { budgets, stats, runtime } = await accrue(state, now);
  await patchState({ budgets, stats, runtime });

  if (session.phase === PHASE.FOCUS) await policeCurrentTab();
  await paintBadge();
}

/**
 * Move the clock forward: credit focused time to today, and debit the current
 * distracting site's budget. Returns the mutated slices without persisting, so
 * callers can batch a single write.
 */
async function accrue(state, now) {
  const runtime = state.runtime || { lastAccrualAt: 0, warnedDomains: [] };
  const last = runtime.lastAccrualAt || now;
  // Clamp: if the machine slept for an hour we should not credit an hour.
  const delta = Math.max(0, Math.min(now - last, 60_000));

  let stats = { ...state.stats };
  const budgets = { ...state.budgets };

  if (delta > 0 && state.session.phase === PHASE.FOCUS && !state.session.pausedAt) {
    const current = await currentDomain();
    const distracting = current
      && categoryFor(current, state.rules) === CATEGORY.DISTRACTING
      && !isAllowed(current, state.allowances, now);

    stats = bumpDay(stats, now, {
      focusMs: delta,
      distractingMs: distracting ? delta : 0,
    });

    if (distracting) {
      const budget = budgets[current] ?? { remainingMs: state.settings.graceSeconds * 1000 };
      budgets[current] = { remainingMs: Math.max(0, budget.remainingMs - delta) };
    }
  }

  return { budgets, stats, runtime: { ...runtime, lastAccrualAt: now } };
}

/** Inspect the tab the user is actually looking at and enforce the budget. */
async function policeCurrentTab() {
  const tab = await currentTab();
  if (!tab || !tab.url) return clearBudgetTimeout();

  const state = await getState();
  const domain = domainOf(tab.url);
  if (!domain) return clearBudgetTimeout();

  const now = Date.now();
  if (categoryFor(domain, state.rules) !== CATEGORY.DISTRACTING) return clearBudgetTimeout();
  if (isAllowed(domain, state.allowances, now)) return clearBudgetTimeout();

  const budget = state.budgets[domain] ?? { remainingMs: state.settings.graceSeconds * 1000 };
  const left = budget.remainingMs;

  if (left <= 0) {
    await enforce(tab, domain, state);
    return;
  }

  // Warn once per domain per session, 30s out.
  const warned = new Set(state.runtime?.warnedDomains || []);
  if (left <= 30_000 && !warned.has(domain)) {
    warned.add(domain);
    await patchState({ runtime: { ...(state.runtime || {}), warnedDomains: [...warned] } });
    notify('30 seconds left', `${domain} closes shortly. Wrap it up.`, state.settings);
  }

  // Durable + precise wake-ups for the exact moment the budget runs out.
  chrome.alarms.create(BUDGET_ALARM, { when: now + left });
  clearBudgetTimeout();
  budgetTimeout = setTimeout(() => { budgetTimeout = null; heartbeat(); }, left + 250);
}

async function enforce(tab, domain, state) {
  clearBudgetTimeout();
  chrome.alarms.clear(BUDGET_ALARM);

  const stats = bumpDay(state.stats, Date.now(), { blocked: 1 });
  await patchState({ stats });

  if (state.settings.onExpire === 'close') {
    notify('Tab closed', `Your time on ${domain} was up.`, state.settings);
    try { await chrome.tabs.remove(tab.id); } catch { /* already gone */ }
    return;
  }

  const url = chrome.runtime.getURL('src/blocked.html')
    + `?domain=${encodeURIComponent(domain)}&from=${encodeURIComponent(tab.url)}`;
  try { await chrome.tabs.update(tab.id, { url }); } catch { /* tab vanished */ }
}

function isAllowed(domain, allowances, now) {
  return (allowances[domain] || 0) > now;
}

function clearBudgetTimeout() {
  if (budgetTimeout) { clearTimeout(budgetTimeout); budgetTimeout = null; }
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function currentDomain() {
  const tab = await currentTab();
  return tab ? domainOf(tab.url) : '';
}

const onTabChange = () => heartbeat();

chrome.tabs.onActivated.addListener(onTabChange);
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') heartbeat();
});
chrome.windows.onFocusChanged.addListener(onTabChange);

/* ------------------------------------------------------------------ *
 * Idle handling — walking away should not burn focus minutes
 * ------------------------------------------------------------------ */

chrome.idle.onStateChanged.addListener(async (newState) => {
  const state = await getState();
  if (!state.settings.pauseWhenIdle) return;
  if (state.session.phase !== PHASE.FOCUS) return;

  if (newState === 'active') {
    // Only auto-resume what we auto-paused; a deliberate pause stays paused.
    if (state.session.pausedAt && state.session.autoPaused) {
      const resumed = await resumeSession();
      await patchState({ session: { ...resumed, autoPaused: false } });
    }
  } else if (!state.session.pausedAt) {
    const paused = await pauseSession();
    await patchState({ session: { ...paused, autoPaused: true } });
  }
});

async function applyIdleSetting(seconds) {
  chrome.idle.setDetectionInterval(Math.max(15, seconds || 60));
}

/* ------------------------------------------------------------------ *
 * Stats & streaks
 * ------------------------------------------------------------------ */

function bumpDay(stats, ts, deltas) {
  const key = dayKey(ts);
  const day = { ...EMPTY_DAY, ...(stats[key] || {}) };
  for (const [k, v] of Object.entries(deltas)) day[k] = (day[k] || 0) + v;
  return { ...stats, [key]: day };
}

function todayStats(stats) {
  return { ...EMPTY_DAY, ...(stats[dayKey()] || {}) };
}

function bumpStreak(streak, ts) {
  const today = dayKey(ts);
  if (streak.lastDay === today) return streak;

  const yesterday = dayKey(ts - 86_400_000);
  const current = streak.lastDay === yesterday ? streak.current + 1 : 1;
  return {
    current,
    best: Math.max(current, streak.best || 0),
    lastDay: today,
  };
}

/* ------------------------------------------------------------------ *
 * Badge & notifications
 * ------------------------------------------------------------------ */

async function paintBadge(known) {
  const state = known || await getState();
  const session = state.session;

  if (session.phase === PHASE.IDLE) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Focus Companion' });
    return;
  }

  const left = remainingMs(session);
  const mins = Math.ceil(left / 60_000);
  const text = session.pausedAt ? '||' : (mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}`);

  const domain = await currentDomain();
  const onDistracting = session.phase === PHASE.FOCUS && domain
    && categoryFor(domain, state.rules) === CATEGORY.DISTRACTING
    && !isAllowed(domain, state.allowances, Date.now());

  const color = onDistracting ? BADGE.danger
    : session.phase === PHASE.BREAK ? BADGE.break : BADGE.focus;

  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({
    title: `Focus Companion — ${session.pausedAt ? 'paused' : session.phase} · ${mins}m left`,
  });
}

function notify(title, message, settings) {
  if (settings && settings.notifications === false) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    silent: false,
  });
}

/* ------------------------------------------------------------------ *
 * Message API
 * ------------------------------------------------------------------ */

const handlers = {
  GET_STATE: async () => {
    const state = await getState();
    const tab = await currentTab();
    const domain = tab ? domainOf(tab.url) : '';
    return {
      ...state,
      current: {
        domain,
        title: tab?.title || '',
        favIconUrl: tab?.favIconUrl || '',
        tabId: tab?.id ?? null,
        category: categoryFor(domain, state.rules),
        budgetMs: domain
          ? (state.budgets[domain]?.remainingMs ?? state.settings.graceSeconds * 1000)
          : null,
        allowedUntil: state.allowances[domain] || 0,
      },
    };
  },

  START: ({ minutes, goal, phase }) => startSession({ minutes, goal, phase }),
  STOP: async () => {
    const state = await getState();
    if (state.settings.strictMode && state.session.phase === PHASE.FOCUS) {
      return { refused: 'strict' };
    }
    return stopSession({ completed: false });
  },
  PAUSE: () => pauseSession(),
  RESUME: () => resumeSession(),
  EXTEND: ({ minutes }) => extendSession(minutes || 5),
  SKIP_BREAK: () => stopSession({ completed: true }),

  SET_RULE: async ({ domain, category }) => {
    const state = await getState();
    const rules = { ...state.rules };
    if (category === CATEGORY.NEUTRAL) delete rules[domain];
    else rules[domain] = category;

    const budgets = { ...state.budgets };
    if (category !== CATEGORY.DISTRACTING) delete budgets[domain];

    await patchState({ rules, budgets });
    await heartbeat();
    return rules;
  },

  SNOOZE: async ({ domain, minutes }) => {
    const state = await getState();
    const mins = minutes || state.settings.snoozeMinutes;
    const allowances = { ...state.allowances, [domain]: Date.now() + mins * 60_000 };
    await patchState({
      allowances,
      stats: bumpDay(state.stats, Date.now(), { snoozes: 1 }),
    });
    clearBudgetTimeout();
    return allowances;
  },

  SAVE_SETTINGS: async ({ settings }) => {
    const state = await getState();
    const next = { ...state.settings, ...settings };
    await patchState({ settings: next });
    await applyIdleSetting(next.idleSeconds);
    await heartbeat();
    return next;
  },

  RESET_ALL: async () => {
    await chrome.storage.local.clear();
    chrome.alarms.clear(SESSION_ALARM);
    chrome.alarms.clear(BUDGET_ALARM);
    clearBudgetTimeout();
    const fresh = await getState();
    await patchState(fresh);
    await paintBadge();
    return fresh;
  },

  IMPORT_RULES: async ({ rules }) => {
    const state = await getState();
    const merged = { ...state.rules, ...rules };
    await patchState({ rules: merged });
    return merged;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // keep the channel open for the async reply
});

/* ------------------------------------------------------------------ *
 * Keyboard command
 * ------------------------------------------------------------------ */

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-focus') return;
  const state = await getState();
  if (state.session.phase === PHASE.IDLE) await startSession({ phase: PHASE.FOCUS });
  else await stopSession({ completed: false });
});
