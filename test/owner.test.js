import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-owner-'));
process.env.WA_CLAUDE_DATA = tmp;
process.env.WA_CLAUDE_CONFIG = path.join(tmp, 'config.json');

const { machineIdentity, leaseEventId, OwnerLease, OwnershipGuard, takeoverMessage } = await import('../src/owner.js');
const { State } = await import('../src/state.js');
const { Processor } = await import('../src/processor.js');
const { loadConfig } = await import('../src/config.js');

/** One shared fake Google Calendar = what both computers see */
function fakeApi() {
  const store = new Map();
  const notFound = () => Object.assign(new Error('Not Found'), { code: 404 });
  const api = {
    store,
    down: false,
    events: {
      get: async ({ eventId }) => {
        if (api.down) throw new Error('ENOTFOUND www.googleapis.com');
        if (!store.has(eventId)) throw notFound();
        return { data: structuredClone(store.get(eventId)) };
      },
      update: async ({ eventId, requestBody }) => {
        if (api.down) throw new Error('ENOTFOUND www.googleapis.com');
        if (!store.has(eventId)) throw notFound();
        store.set(eventId, { id: eventId, ...structuredClone(requestBody) });
        return { data: store.get(eventId) };
      },
      insert: async ({ requestBody }) => {
        store.set(requestBody.id, structuredClone(requestBody));
        return { data: requestBody };
      },
    },
  };
  return api;
}

function computer(api, name, { instance = 'default', stateFile } = {}) {
  const machine = machineIdentity(path.join(tmp, `profile-${name}`));
  machine.host = name;
  const state = new State(stateFile || path.join(tmp, `state-${name}-${Math.random()}.json`));
  const events = { retired: null, claimed: [] };
  const guard = new OwnershipGuard({
    lease: new OwnerLease({ api, instance, machine }),
    state,
    machine,
    minIntervalMs: 0,
    onRetire: (cur) => (events.retired = cur),
    onClaim: (prev) => events.claimed.push(prev),
  });
  return { machine, state, guard, events };
}

test('machine id persists per profile, event id is a valid Google id', () => {
  const dir = path.join(tmp, 'p1');
  const a = machineIdentity(dir);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.equal(machineIdentity(dir).id, a.id);
  assert.notEqual(machineIdentity(path.join(tmp, 'p2')).id, a.id);
  for (const inst of ['default', 'roni']) assert.match(leaseEventId(inst), /^[a-v0-9]{5,1024}$/);
  assert.notEqual(leaseEventId('default'), leaseEventId('roni'));
});

test('moving to a new computer (fresh install) stops the old one', async () => {
  const api = fakeApi();
  const old = computer(api, 'OLD-PC');
  assert.equal(await old.guard.start(), 'run');
  assert.deepEqual(old.events.claimed, [null]); // first ever: nothing to announce
  assert.equal(await old.guard.check(), true);

  const neu = computer(api, 'NEW-PC');
  assert.equal(await neu.guard.start(), 'run');
  assert.equal(neu.events.claimed[0].host, 'OLD-PC');
  assert.equal(takeoverMessage(neu.events.claimed[0], neu.machine), '💻 הבוט פועל עכשיו מהמחשב NEW-PC. המחשב הקודם (OLD-PC) הפסיק לפעול.');

  // the old computer notices on its next check and stops
  assert.equal(await old.guard.check(), false);
  assert.equal(old.events.retired.host, 'NEW-PC');
  assert.equal(await neu.guard.check(), true);
});

test('copied folder (same state file, same WhatsApp link) on a new computer takes over; old one stays off after reboot', async () => {
  const api = fakeApi();
  const stateFile = path.join(tmp, 'shared-state.json');
  const old = computer(api, 'OLD', { stateFile });
  await old.guard.start();
  // copy the folder: the new computer gets the same state.json (with OLD's machineId)
  const copied = path.join(tmp, 'copied-state.json');
  fs.copyFileSync(stateFile, copied);
  const neu = computer(api, 'NEW', { stateFile: copied });
  assert.equal(await neu.guard.start(), 'run');
  assert.equal(neu.events.claimed[0].host, 'OLD');

  // OLD reboots later (autostart): it must not take the bot back
  const oldAgain = computer(api, 'OLD', { stateFile });
  assert.equal(await oldAgain.guard.start(), 'retire');
  assert.equal(oldAgain.events.retired.host, 'NEW');

  // NEW restarts normally: keeps running, no new announcement
  const neuAgain = computer(api, 'NEW', { stateFile: copied });
  assert.equal(await neuAgain.guard.start(), 'run');
  assert.deepEqual(neuAgain.events.claimed, []);

  // take-over brings it back to OLD
  const back = computer(api, 'OLD', { stateFile });
  assert.equal(await back.guard.start({ takeOver: true }), 'run');
  assert.equal(back.events.claimed[0].host, 'NEW');
  assert.equal(await neuAgain.guard.check(), false);
});

test('Google unreachable never stops the bot; a failed claim is retried', async () => {
  const api = fakeApi();
  const old = computer(api, 'A');
  await old.guard.start();
  api.down = true;
  assert.equal(await old.guard.check(), true);
  const restarted = computer(api, 'A', { stateFile: old.state.file });
  assert.equal(await restarted.guard.start(), 'run');

  // a new computer while Google is down: runs, and claims as soon as Google is back
  const neu = computer(api, 'B');
  assert.equal(await neu.guard.start(), 'run');
  assert.equal(neu.guard.pendingClaim, true);
  assert.equal(await neu.guard.check(), true); // still down: must NOT retire itself
  assert.equal(neu.events.retired, null);
  api.down = false;
  assert.equal(await neu.guard.check(), true);
  assert.equal(neu.guard.pendingClaim, false);
  assert.equal(await old.guard.check(), false);
});

test('deleted lease event is claimed back by the running computer', async () => {
  const api = fakeApi();
  const a = computer(api, 'A');
  await a.guard.start();
  api.store.clear();
  assert.equal(await a.guard.check(), true);
  assert.equal(api.store.size, 1);
});

test('processor does nothing once another computer owns the bot', async () => {
  const cfg = { ...loadConfig(), debounceSec: 0 };
  const sent = [];
  let owner = true;
  const p = new Processor({
    cfg,
    state: new State(path.join(tmp, `ps-${Math.random()}.json`)),
    calendar: { listWindow: async () => [] },
    send: async (t) => sent.push(t),
    ask: async () => ({ reply: 'x', calendar_actions: [], task_actions: [] }),
    guard: async () => owner,
    hostName: 'PC1',
  });
  p.enqueue({ id: 'a', ts: 1, text: '/סטטוס' });
  await p.chain;
  assert.equal(sent.length, 1);
  assert.match(sent[0], /מחשב: PC1/);
  owner = false;
  p.enqueue({ id: 'b', ts: 2, text: '/סטטוס' });
  await p.chain;
  assert.equal(sent.length, 1);
});
