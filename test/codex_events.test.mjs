// What the hooks send for Codex payloads: recorded events (test/fixtures/events.jsonl) against a fresh run of notify.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EVENTS_FILE, PAYLOADS, recordEvents } from './tools/record_events.mjs';

const recorded = () => fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('recorded_events_match_the_hooks', () => {
  assert.deepEqual(recordEvents(), recorded(), 'run `node test/tools/record_events.mjs` after changing notify.mjs');
});

test('codex_events_have_the_v2_shape', () => {
  const events = recorded();
  assert.ok(events.length >= PAYLOADS.length - 2, `${events.length} events`);
  for (const state of ['needs_you', 'your_turn', 'working', 'done']) assert.ok(events.some((e) => e.state === state), state);
  assert.ok(events.every((e) => e.v === 2 && e.session && e.agent));
  assert.equal(new Set(events.map((e) => e.session)).size, 1);
  assert.ok(events.some((e) => e.agent !== 'lead' && e.role === 'explorer'), 'a sub-agent carries its agent_type as role');
  assert.ok(events.every((e) => e.model === 'gpt-5-codex'), 'the model of the payload travels');
});
