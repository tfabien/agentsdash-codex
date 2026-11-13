// Records the v2 events notify.mjs sends for scripted Codex payloads: `node test/tools/record_events.mjs` rewrites test/fixtures/events.jsonl.
// The test compares a fresh recording with the file; the core repository keeps a copy (hub/test/fixtures/events-codex.jsonl) and replays it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY = path.join(HERE, '..', '..', 'scripts', 'notify.mjs');
export const EVENTS_FILE = path.join(HERE, '..', 'fixtures', 'events.jsonl');

const S = { session_id: '019a0000-aaaa-7000-8000-000000000001', cwd: 'C:/work/codex-demo', model: 'gpt-5-codex', transcript_path: null, permission_mode: 'default' };
const SUB = { ...S, agent_id: '019a0000-bbbb-7000-8000-000000000002', agent_type: 'explorer' };
const hook = (base, name, fields = {}) => ({ ...base, hook_event_name: name, turn_id: 'turn-1', ...fields });

/** Scripted payloads with the field names of the Codex hooks documentation. */
export const PAYLOADS = [
  hook(S, 'SessionStart', { source: 'startup' }),
  hook(S, 'UserPromptSubmit', { prompt: 'Add a retry to the uploader' }),
  hook(S, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' } }),
  hook(S, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } }),
  hook(S, 'PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'call_2', tool_input: { input: '*** Begin Patch' } }),
  hook(SUB, 'SubagentStart'),
  hook(SUB, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'call_3', tool_input: { command: 'rg uploader' } }),
  hook(SUB, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' } }),
  hook(SUB, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'call_3', tool_input: { command: 'rg uploader' }, tool_response: { exit_code: 0 } }),
  hook(SUB, 'SubagentStop', { stop_hook_active: false, last_assistant_message: 'Found 3 call sites.' }),
  hook(S, 'Stop', { stop_hook_active: false, last_assistant_message: 'Retry added, tests pass.\n\nNext: review the diff.' }),
  hook(S, 'SessionEnd', { reason: 'other' }),
];

/** Runs every payload through notify.mjs (dry run, one shared state folder) and returns the events it would send. */
export function recordEvents() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'record-'));
  const events = [];
  for (const payload of PAYLOADS) {
    const env = { ...process.env, AGENTSDASH_DRY_RUN: '1', AGENTSDASH_STATE_DIR: state };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_GADGET_')) delete env[k];
    const out = spawnSync(process.execPath, [NOTIFY], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 10000 });
    const line = out.stderr.trim().split('\n').filter(Boolean).pop();
    if (line) events.push(JSON.parse(line));
  }
  return events;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const events = recordEvents();
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  fs.writeFileSync(EVENTS_FILE, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  process.stdout.write(`${events.length} events written to ${EVENTS_FILE}\n`);
}
