/**
 * Shared state layer for Focus Companion.
 *
 * Everything the extension knows lives in chrome.storage.local. The MV3 service
 * worker is torn down whenever it goes idle, so no module-level variable here is
 * ever trusted to survive; every read goes back to storage.
 */

export const STORAGE_VERSION = 2;

export const PHASE = {
  IDLE: 'idle',
  FOCUS: 'focus',
  BREAK: 'break',
};

export const CATEGORY = {
  FOCUS: 'focus',
  DISTRACTING: 'distracting',
  NEUTRAL: 'neutral',
};

export const DEFAULT_SETTINGS = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  sessionsUntilLongBreak: 4,
  autoStartBreaks: true,

  /** Seconds you may spend on a distracting site per session before it is blocked. */
  graceSeconds: 120,
  /** What happens when the budget runs out. */
  onExpire: 'block', // 'block' | 'close'
  /** Minutes granted when you snooze a blocked site. */
  snoozeMinutes: 5,

  /** Strict mode forbids ending a focus session early. */
  strictMode: false,
  notifications: true,
  /** Stop the clock when you walk away from the machine. */
  pauseWhenIdle: true,
  idleSeconds: 60,

  theme: 'system', // 'system' | 'light' | 'dark'
};

/**
 * Sites that are distracting for most people, most of the time. These seed the
 * rule set on first run so the extension is useful before it is configured;
 * every one of them can be overridden.
 */
export const DEFAULT_DISTRACTING = [
  // social
  'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com',
  'reddit.com', 'snapchat.com', 'threads.net', 'linkedin.com', 'pinterest.com',
  'tumblr.com', 'quora.com', '9gag.com', 'discord.com',
  // video & streaming
  'youtube.com', 'netflix.com', 'twitch.tv', 'hulu.com', 'primevideo.com',
  'disneyplus.com', 'hotstar.com', 'dailymotion.com', 'vimeo.com',
  // news & timesinks
  'news.google.com', 'buzzfeed.com', 'dailymail.co.uk', 'cnn.com',
  // shopping
  'amazon.com', 'ebay.com', 'flipkart.com', 'aliexpress.com', 'etsy.com',
  // games
  'steampowered.com', 'epicgames.com', 'roblox.com', 'chess.com',
];

export const EMPTY_SESSION = {
  phase: PHASE.IDLE,
  startedAt: 0,
  endsAt: 0,
  plannedMs: 0,
  /** Wall-clock ms spent paused, so the countdown stays honest. */
  pausedMs: 0,
  pausedAt: 0,
  /** Completed focus blocks in the current pomodoro cycle. */
  cycle: 0,
  goal: '',
  id: '',
  /** True when the idle detector paused this session, not the user. */
  autoPaused: false,
};

export const EMPTY_DAY = {
  focusMs: 0,
  distractingMs: 0,
  started: 0,
  completed: 0,
  abandoned: 0,
  blocked: 0,
  snoozes: 0,
};

const DEFAULT_STATE = {
  version: STORAGE_VERSION,
  settings: { ...DEFAULT_SETTINGS },
  session: { ...EMPTY_SESSION },
  /** domain -> 'focus' | 'distracting' */
  rules: {},
  /** ISO date (local) -> day stats */
  stats: {},
  streak: { current: 0, best: 0, lastDay: '' },
  /** domain -> { remainingMs, runningSince } budget for the current session */
  budgets: {},
  /** domain -> epoch ms until which the site is explicitly allowed */
  allowances: {},
  /** Set once the welcome flow has been shown. */
  onboarded: false,
};

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export async function getState() {
  const stored = await chrome.storage.local.get(null);
  const state = migrate(stored);
  // Persist the first migration/seed immediately. Otherwise every later read
  // would re-seed the default blocklist in memory and quietly resurrect
  // domains the user had deliberately removed.
  if (!stored.seeded || !stored.version) {
    await chrome.storage.local.set({
      version: state.version,
      seeded: true,
      rules: state.rules,
      settings: state.settings,
    });
  }
  return state;
}

export async function patchState(patch) {
  await chrome.storage.local.set(patch);
  return patch;
}

/** Read-modify-write a single top-level key. */
export async function updateKey(key, mutator) {
  const state = await getState();
  const next = mutator(state[key], state);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

/**
 * Bring any previously stored shape up to the current schema. v1 stored
 * `tabsCategory` keyed by full URL and `threshold` in minutes; both are
 * translated rather than discarded.
 */
export function migrate(stored) {
  const state = {
    ...DEFAULT_STATE,
    ...stored,
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    session: { ...EMPTY_SESSION, ...(stored.session || {}) },
    rules: { ...(stored.rules || {}) },
    stats: { ...(stored.stats || {}) },
    streak: { ...DEFAULT_STATE.streak, ...(stored.streak || {}) },
    budgets: { ...(stored.budgets || {}) },
    allowances: { ...(stored.allowances || {}) },
  };

  if (!stored.version) {
    // v1 -> v2: URL-keyed categories collapse to domain-keyed rules.
    for (const [url, category] of Object.entries(stored.tabsCategory || {})) {
      const domain = domainOf(url);
      if (!domain) continue;
      // A single "distracting" mark for a domain outweighs stale "focus" marks,
      // which v1 wrote automatically for every tab it ever saw.
      if (category === CATEGORY.DISTRACTING) state.rules[domain] = CATEGORY.DISTRACTING;
      else if (!(domain in state.rules)) state.rules[domain] = CATEGORY.FOCUS;
    }
    const threshold = Number(stored.threshold);
    if (threshold > 0) state.settings.graceSeconds = Math.round(threshold * 60);
    if (stored.theme === 'light' || stored.theme === 'dark') state.settings.theme = stored.theme;
    state.version = STORAGE_VERSION;
  }

  // Seed the built-in blocklist once, without clobbering user decisions.
  if (!stored.seeded) {
    for (const domain of DEFAULT_DISTRACTING) {
      if (!(domain in state.rules)) state.rules[domain] = CATEGORY.DISTRACTING;
    }
    state.seeded = true;
  }

  return state;
}

/* ------------------------------------------------------------------ *
 * Domains
 * ------------------------------------------------------------------ */

const IGNORED_SCHEMES = /^(chrome|edge|about|chrome-extension|devtools|file|view-source):/i;

/** Normalised registrable-ish domain for a URL, or '' if it is not a web page. */
export function domainOf(url) {
  if (!url || IGNORED_SCHEMES.test(url)) return '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/**
 * Look up a domain in the rule set, honouring subdomains: a rule on
 * `youtube.com` also covers `m.youtube.com` and `music.youtube.com`.
 * The most specific matching rule wins.
 */
export function categoryFor(domain, rules) {
  if (!domain) return CATEGORY.NEUTRAL;
  if (domain in rules) return rules[domain];

  let best = null;
  for (const key of Object.keys(rules)) {
    if (domain.endsWith('.' + key) && (!best || key.length > best.length)) best = key;
  }
  return best ? rules[best] : CATEGORY.NEUTRAL;
}

/* ------------------------------------------------------------------ *
 * Time & sessions
 * ------------------------------------------------------------------ */

/** Local calendar day as YYYY-MM-DD (not UTC — stats should match your day). */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isRunning(session) {
  return session.phase !== PHASE.IDLE && !session.pausedAt;
}

/** Milliseconds left in the session, accounting for time spent paused. */
export function remainingMs(session, now = Date.now()) {
  if (session.phase === PHASE.IDLE) return 0;
  if (session.pausedAt) return Math.max(0, session.endsAt - session.pausedAt);
  return Math.max(0, session.endsAt - now);
}

export function elapsedMs(session, now = Date.now()) {
  if (session.phase === PHASE.IDLE) return 0;
  const end = session.pausedAt || now;
  return Math.max(0, end - session.startedAt - session.pausedMs);
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Human duration for stats: "1h 24m", "48m", "0m". */
export function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

export function newSessionId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
