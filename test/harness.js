/** Minimal in-memory stand-in for the Chrome extension APIs. */
export function installChrome() {
  const store = {};
  const alarms = new Map();
  const listeners = { alarm: [], message: [], tabActivated: [], tabUpdated: [], idle: [], installed: [], startup: [], windowFocus: [], command: [] };
  const calls = { tabsUpdate: [], tabsRemove: [], tabsCreate: [], notifications: [], badge: [] };
  let tabs = [];

  const clone = (v) => JSON.parse(JSON.stringify(v));

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup:   { addListener: (f) => listeners.startup.push(f) },
      onMessage:   { addListener: (f) => listeners.message.push(f) },
      getURL: (p) => `chrome-extension://test/${p}`,
      lastError: null,
    },
    storage: {
      local: {
        get: async () => clone(store),
        set: async (patch) => { Object.assign(store, clone(patch)); },
        clear: async () => { for (const k of Object.keys(store)) delete store[k]; },
      },
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: (name, info) => alarms.set(name, info),
      get: async (name) => alarms.get(name) || null,
      clear: (name) => alarms.delete(name),
      onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    },
    tabs: {
      query: async (q) => (q.active ? tabs.filter((t) => t.active) : tabs),
      get: async (id) => tabs.find((t) => t.id === id),
      update: async (id, props) => {
        calls.tabsUpdate.push({ id, ...props });
        const t = tabs.find((x) => x.id === id);
        if (t) t.url = props.url;
      },
      remove: async (id) => { calls.tabsRemove.push(id); tabs = tabs.filter((t) => t.id !== id); },
      create: async (props) => { calls.tabsCreate.push(props); return { id: 999, ...props }; },
      onActivated: { addListener: (f) => listeners.tabActivated.push(f) },
      onUpdated:   { addListener: (f) => listeners.tabUpdated.push(f) },
      onCreated:   { addListener: () => {} },
    },
    windows: { onFocusChanged: { addListener: (f) => listeners.windowFocus.push(f) } },
    idle: {
      setDetectionInterval: () => {},
      onStateChanged: { addListener: (f) => listeners.idle.push(f) },
    },
    action: {
      setBadgeText: async (o) => { calls.badge.push(o.text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    notifications: { create: (o) => calls.notifications.push(o) },
    commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
  };

  return {
    store, alarms, listeners, calls,
    setTabs: (t) => { tabs = t; },
    getTabs: () => tabs,
    /** Invoke the extension's message handler and await its reply. */
    send: (type, payload = {}) => new Promise((resolve) => {
      listeners.message[0]({ type, payload }, {}, resolve);
    }),
    fireAlarm: (name) => Promise.all(listeners.alarm.map((f) => f({ name }))),
    fireTabActivated: () => Promise.all(listeners.tabActivated.map((f) => f({ tabId: 1 }))),
    fireIdle: (s) => Promise.all(listeners.idle.map((f) => f(s))),
    fireInstalled: (reason) => Promise.all(listeners.installed.map((f) => f({ reason }))),
  };
}

/** A controllable clock: every module reads Date.now(), so overriding it is enough. */
export function installClock(start) {
  let now = start;
  const real = Date.now;
  Date.now = () => now;
  return { advance: (ms) => { now += ms; }, now: () => now, restore: () => { Date.now = real; } };
}
