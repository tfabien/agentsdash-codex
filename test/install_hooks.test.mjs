import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EVENTS, mergeHooks } from '../scripts/install_codex_hooks.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install_codex_hooks.mjs');
const NOTIFY = '/home/u/agentsdash-codex/scripts/notify.mjs';

test('merge_adds_every_event_and_keeps_other_hooks', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-audit' }] }] }, other: 1 };
  const out = mergeHooks(existing, NOTIFY);
  assert.equal(out.other, 1);
  for (const e of EVENTS) assert.ok(out.hooks[e].some((g) => g.hooks.some((h) => h.command.includes('agentsdash-codex'))), e);
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'my-audit', 'the other hook stays first');
  assert.equal(out.hooks.PreToolUse.length, 2);
});

test('merge_twice_does_not_duplicate', () => {
  const once = mergeHooks({}, NOTIFY);
  const twice = mergeHooks(once, NOTIFY);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
});

test('merge_replaces_an_older_agentsdash_path', () => {
  const old = mergeHooks({}, '/old/agentsdash-codex/scripts/notify.mjs');
  const out = mergeHooks(old, NOTIFY);
  assert.equal(out.hooks.Stop.length, 1);
  assert.ok(out.hooks.Stop[0].hooks[0].command.includes('/home/u/'));
});

test('merge_survives_garbage', () => {
  for (const bad of [null, [], 'x', { hooks: 5 }, { hooks: { Stop: 'x' } }]) assert.doesNotThrow(() => mergeHooks(bad, NOTIFY));
});

test('write_flag_creates_the_file_and_default_only_prints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhooks-'));
  const file = path.join(dir, 'sub', 'hooks.json');
  const printed = spawnSync(process.execPath, [SCRIPT, '--file', file], { encoding: 'utf8' });
  assert.equal(printed.status, 0);
  assert.equal(fs.existsSync(file), false, 'printing writes nothing');
  assert.ok(JSON.parse(printed.stdout).hooks.SessionStart);
  const written = spawnSync(process.execPath, [SCRIPT, '--file', file, '--write'], { encoding: 'utf8' });
  assert.equal(written.status, 0);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionEnd);
});
