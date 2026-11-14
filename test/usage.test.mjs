import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addUsage } from '../scripts/notify.mjs';
import { contextWindow, scan, threadTitle } from '../scripts/transcript_usage.mjs';

const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
const tokenCount = (total, last, window = 258400) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: window } },
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  const rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    tokenCount(usage(16590, 12416, 5), usage(16590, 12416, 5)),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    tokenCount(usage(40000, 30000, 300), usage(23410, 17584, 295)),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'session_index.jsonl'), [
    JSON.stringify({ id: 'sess-1', thread_name: 'Old name' }),
    JSON.stringify({ id: 'other', thread_name: 'Other' }),
    JSON.stringify({ id: 'sess-1', thread_name: 'Fix the hub' }),
    '',
  ].join('\n'));
  return { dir, rollout };
}

test('scan_reads_the_running_total_and_the_last_context', () => {
  const { rollout } = fixture();
  const e = scan(rollout);
  assert.equal(e.tokens, 40000 - 30000 + 300);
  assert.equal(e.last_ctx, 23410);
  assert.equal(e.window, 258400);
  assert.equal(e.model, 'gpt-5.6-sol');
});

test('scan_is_incremental', () => {
  const { rollout } = fixture();
  const first = scan(rollout);
  fs.appendFileSync(rollout, `${tokenCount(usage(50000, 40000, 400), usage(10000, 10000, 100))}\n`);
  const second = scan(rollout, first);
  assert.equal(second.tokens, 10000 + 400);
  assert.equal(second.last_ctx, 10000);
});

test('thread_title_is_the_last_name_of_the_session', () => {
  const { dir } = fixture();
  assert.equal(threadTitle('sess-1', dir), 'Fix the hub');
  assert.equal(threadTitle('missing', dir), '');
  assert.equal(threadTitle('sess-1', path.join(dir, 'nope')), '');
});

test('context_window_uses_the_recorded_size', () => {
  assert.equal(contextWindow(258400, 1000000), 258400);
  assert.equal(contextWindow(0, 1000000), 1000000);
});

test('add_usage_fills_tokens_context_and_title', () => {
  const { dir, rollout } = fixture();
  const state = path.join(dir, 'state');
  const ev = addUsage({ evt: 'Stop', agent: 'lead' }, { session_id: 'sess-1', transcript_path: rollout }, state, false, 1000000, { CODEX_HOME: dir });
  assert.equal(ev.tok, 10300);
  assert.equal(ev.stok, 10300);
  assert.equal(ev.ctx_k, 23);
  assert.equal(ev.ctx_pct, 9);
  assert.equal(ev.title, 'Fix the hub');
  assert.equal(ev.model, 'gpt-5.6-sol');
  const masked = addUsage({ evt: 'Stop', agent: 'lead' }, { session_id: 'sess-1', transcript_path: rollout }, state, true, 1000000, { CODEX_HOME: dir });
  assert.equal(masked.title, undefined);
});
