#!/usr/bin/env node
/*
 * Puts the agentsdash hooks into ~/.codex/hooks.json (or the file given with --file).
 *   node scripts/install_codex_hooks.mjs            prints the hooks.json that would be written
 *   node scripts/install_codex_hooks.mjs --write    merges it into the file (other hooks stay, older agentsdash entries are replaced)
 * Codex asks you to review and trust new hooks: run /hooks in Codex once after writing them. Standard library only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NOTIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs');
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const isOurs = (handler) => typeof handler?.command === 'string' && /notify\.mjs/.test(handler.command) && /agentsdash/i.test(handler.command);

/** The command of one hook: node and the absolute path of notify.mjs (the folder name carries "agentsdash"). */
export const commandFor = (notifyPath = NOTIFY) => `node "${notifyPath.replace(/\\/g, '/')}"`;

/** `existing` hooks.json object with the agentsdash hooks added; its other hooks are kept, older agentsdash ones replaced. */
export function mergeHooks(existing, notifyPath = NOTIFY) {
  const out = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}) };
  const hooks = { ...(out.hooks && typeof out.hooks === 'object' ? out.hooks : {}) };
  for (const event of EVENTS) {
    const keep = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    const ours = { hooks: [{ type: 'command', command: commandFor(notifyPath), timeout: event === 'SessionEnd' ? 1 : 5 }] };
    if (WITH_MATCHER.has(event)) ours.matcher = '*';
    hooks[event] = [...keep, ours];
  }
  out.hooks = hooks;
  return out;
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--file');
  const file = at >= 0 ? args[at + 1] : path.join(os.homedir(), '.codex', 'hooks.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a new file */ }
  const merged = mergeHooks(existing);
  if (args.includes('--write')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    process.stdout.write(`written: ${file}\nRun /hooks in Codex to review and trust the new hooks.\n`);
  } else process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
}
