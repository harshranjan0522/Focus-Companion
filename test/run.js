import assert from 'node:assert/strict';
import { installChrome, installClock } from './harness.js';

const START = new Date('2026-08-29T09:00:00').getTime();
let pass = 0, fail = 0;
const results = [];

async function test(name, fn) {
  const clock = installClock(START);
  const env = installChrome();
  try {
    // Fresh module instance per test, so worker globals do not leak between cases.
    const bg = await import(`../src/background.js?v=${Math.random()}`);
    await env.fireInstalled('install');
    await fn(env, clock, bg);
    results.push(`  ✓ ${name}`); pass++;
  } catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`); fail++;
  } finally {
    clock.restore();
  }
}

const tab = (url, id = 1) => ({ id, url, title: 'A page', active: true, favIconUrl: '' });
const unwrap = (r) => { assert.equal(r.ok, true, `message failed: ${r.error}`); return r.data; };

/* ------------------------------------------------------------------ */

await test('seeds a default blocklist on install', async (env) => {
  const s = unwrap(await env.send('GET_STATE'));
  const blocked = Object.values(s.rules).filter((c) => c === 'distracting');
  assert.ok(blocked.length > 30, `expected >30 seeded sites, got ${blocked.length}`);
  assert.equal(s.rules['youtube.com'], 'distracting');
  assert.equal(s.session.phase, 'idle');
});

await test('removing a seeded rule survives the next read', async (env) => {
  await env.send('SET_RULE', { domain: 'youtube.com', category: 'neutral' });
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal('youtube.com' in s.rules, false, 'deleted rule was resurrected by re-seeding');
});

await test('starts a focus session and arms an alarm', async (env, clock) => {
  await env.send('START', { minutes: 25, goal: 'Write the docs' });
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(s.session.phase, 'focus');
  assert.equal(s.session.goal, 'Write the docs');
  assert.equal(s.session.endsAt, clock.now() + 25 * 60000);
  assert.ok(env.alarms.get('fc:session-end'), 'session-end alarm not created');
  assert.equal(s.stats[Object.keys(s.stats)[0]].started, 1);
});

await test('credits focused time and spends the budget on a distracting site', async (env, clock) => {
  env.setTabs([tab('https://www.youtube.com/watch?v=1')]);
  await env.send('START', { minutes: 25 });
  clock.advance(30000);
  await env.fireAlarm('fc:tick');
  const s = unwrap(await env.send('GET_STATE'));
  const day = Object.values(s.stats)[0];
  assert.equal(day.focusMs, 30000, `focusMs was ${day.focusMs}`);
  assert.equal(day.distractingMs, 30000, `distractingMs was ${day.distractingMs}`);
  assert.equal(s.budgets['youtube.com'].remainingMs, 90000, 'budget should be 120s - 30s');
});

await test('a focus site spends no budget', async (env, clock) => {
  env.setTabs([tab('https://github.com/some/repo')]);
  await env.send('START', { minutes: 25 });
  clock.advance(60000);
  await env.fireAlarm('fc:tick');
  const s = unwrap(await env.send('GET_STATE'));
  const day = Object.values(s.stats)[0];
  assert.equal(day.focusMs, 60000);
  assert.equal(day.distractingMs, 0);
  assert.deepEqual(s.budgets, {});
});

await test('blocks the tab once the budget is exhausted', async (env, clock) => {
  env.setTabs([tab('https://www.youtube.com/watch?v=1')]);
  await env.send('START', { minutes: 25 });
  for (let i = 0; i < 5; i++) { clock.advance(30000); await env.fireAlarm('fc:tick'); }
  assert.ok(env.calls.tabsUpdate.length > 0, 'tab was never redirected');
  const to = env.calls.tabsUpdate[0].url;
  assert.match(to, /blocked\.html/);
  assert.match(to, /domain=youtube\.com/);
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(Object.values(s.stats)[0].blocked, 1);
});

await test('honours the close-the-tab setting instead of blocking', async (env, clock) => {
  await env.send('SAVE_SETTINGS', { settings: { onExpire: 'close', graceSeconds: 30 } });
  env.setTabs([tab('https://www.reddit.com/r/all')]);
  await env.send('START', { minutes: 25 });
  for (let i = 0; i < 3; i++) { clock.advance(30000); await env.fireAlarm('fc:tick'); }
  assert.deepEqual(env.calls.tabsRemove, [1], 'tab was not closed');
  assert.equal(env.calls.tabsUpdate.length, 0, 'should not redirect when closing');
});

await test('snoozing grants a reprieve and stops the blocking', async (env, clock) => {
  env.setTabs([tab('https://www.youtube.com/watch?v=1')]);
  await env.send('START', { minutes: 25 });
  await env.send('SNOOZE', { domain: 'youtube.com', minutes: 5 });
  for (let i = 0; i < 5; i++) { clock.advance(30000); await env.fireAlarm('fc:tick'); }
  assert.equal(env.calls.tabsUpdate.length, 0, 'snoozed site was blocked anyway');
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(Object.values(s.stats)[0].distractingMs, 0, 'snoozed time counted as distracting');
});

await test('subdomains inherit a parent rule', async (env, clock) => {
  env.setTabs([tab('https://m.youtube.com/watch?v=1')]);
  await env.send('START', { minutes: 25 });
  clock.advance(30000);
  await env.fireAlarm('fc:tick');
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(Object.values(s.stats)[0].distractingMs, 30000, 'm.youtube.com not matched');
});

await test('completing a session records it, bumps the streak and starts a break', async (env, clock) => {
  env.setTabs([tab('https://github.com/x')]);
  await env.send('START', { minutes: 25 });
  clock.advance(25 * 60000 + 1000);
  await env.fireAlarm('fc:session-end');
  const s = unwrap(await env.send('GET_STATE'));
  const day = Object.values(s.stats)[0];
  assert.equal(day.completed, 1, 'session not recorded as completed');
  assert.equal(s.streak.current, 1, 'streak did not advance');
  assert.equal(s.session.phase, 'break', 'break did not auto-start');
});

await test('strict mode refuses an early stop', async (env) => {
  await env.send('SAVE_SETTINGS', { settings: { strictMode: true } });
  await env.send('START', { minutes: 25 });
  const res = unwrap(await env.send('STOP'));
  assert.equal(res.refused, 'strict');
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(s.session.phase, 'focus', 'session ended despite strict mode');
});

await test('pause freezes the clock and resume gives the time back', async (env, clock) => {
  await env.send('START', { minutes: 25 });
  const before = unwrap(await env.send('GET_STATE')).session.endsAt;
  clock.advance(60000);
  await env.send('PAUSE');
  clock.advance(5 * 60000);
  const paused = unwrap(await env.send('GET_STATE'));
  assert.ok(paused.session.pausedAt > 0, 'not paused');
  await env.send('RESUME');
  const after = unwrap(await env.send('GET_STATE')).session.endsAt;
  assert.equal(after, before + 5 * 60000, 'paused time was not returned to the session');
});

await test('time spent paused is not credited as focus', async (env, clock) => {
  env.setTabs([tab('https://github.com/x')]);
  await env.send('START', { minutes: 25 });
  clock.advance(30000);
  await env.send('PAUSE');
  clock.advance(10 * 60000);
  await env.fireAlarm('fc:tick');
  await env.send('RESUME');
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(Object.values(s.stats)[0].focusMs, 30000, 'paused minutes were counted');
});

await test('walking away auto-pauses, returning auto-resumes', async (env, clock) => {
  await env.send('START', { minutes: 25 });
  clock.advance(30000);
  await env.fireIdle('idle');
  let s = unwrap(await env.send('GET_STATE'));
  assert.ok(s.session.pausedAt > 0, 'idle did not pause the session');
  clock.advance(120000);
  await env.fireIdle('active');
  s = unwrap(await env.send('GET_STATE'));
  assert.equal(s.session.pausedAt, 0, 'returning did not resume');
});

await test('a deliberate pause is not undone by returning from idle', async (env, clock) => {
  await env.send('START', { minutes: 25 });
  await env.send('PAUSE');
  await env.fireIdle('active');
  const s = unwrap(await env.send('GET_STATE'));
  assert.ok(s.session.pausedAt > 0, 'manual pause was auto-resumed');
});

await test('a long machine sleep does not inflate focus time', async (env, clock) => {
  env.setTabs([tab('https://github.com/x')]);
  await env.send('START', { minutes: 600 });
  clock.advance(4 * 60 * 60000);   // four hours asleep
  await env.fireAlarm('fc:tick');
  const s = unwrap(await env.send('GET_STATE'));
  assert.ok(Object.values(s.stats)[0].focusMs <= 60000,
    `credited ${Object.values(s.stats)[0].focusMs}ms for a 4h sleep`);
});

await test('extending a session moves the deadline and the alarm', async (env) => {
  await env.send('START', { minutes: 25 });
  const before = unwrap(await env.send('GET_STATE')).session.endsAt;
  await env.send('EXTEND', { minutes: 5 });
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(s.session.endsAt, before + 5 * 60000);
  assert.equal(env.alarms.get('fc:session-end').when, s.session.endsAt);
});

await test('migrates v1 URL-keyed categories and threshold', async (env) => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    tabsCategory: {
      'https://www.youtube.com/watch?v=aaa': 'distracting',
      'https://www.youtube.com/watch?v=bbb': 'distracting',
      'https://github.com/foo/bar': 'focus',
    },
    threshold: 3,
    theme: 'dark',
  });
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(s.rules['youtube.com'], 'distracting', 'URL keys did not collapse to a domain');
  assert.equal(s.rules['github.com'], 'focus');
  assert.equal(s.settings.graceSeconds, 180, '3 minutes did not become 180 seconds');
  assert.equal(s.settings.theme, 'dark');
  assert.equal(s.version, 2);
});

await test('badge shows minutes remaining and clears when idle', async (env, clock) => {
  await env.send('START', { minutes: 25 });
  assert.ok(env.calls.badge.includes('25'), `badge was ${JSON.stringify(env.calls.badge)}`);
  await env.send('SAVE_SETTINGS', { settings: { strictMode: false } });
  await env.send('STOP');
  assert.equal(env.calls.badge.at(-1), '', 'badge not cleared after stopping');
});

await test('reset restores defaults', async (env) => {
  await env.send('START', { minutes: 25 });
  await env.send('RESET_ALL');
  const s = unwrap(await env.send('GET_STATE'));
  assert.equal(s.session.phase, 'idle');
  assert.deepEqual(s.stats, {});
  assert.equal(s.settings.focusMinutes, 25);
});

/* ------------------------------------------------------------------ */
console.log(results.join('\n'));
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
