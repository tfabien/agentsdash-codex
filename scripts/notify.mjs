#!/usr/bin/env node
/*
 * Claude Code hook -> agent hub (wire format v2).
 *
 * Reads the hook payload (JSON on stdin), maps it to an event and POSTs it to http://<host>/event.
 * Standard library only. It never prints to stdout (stdout of some hooks is injected into Claude's
 * context), never fails, and gives up after 1.5 s so it can never slow Claude down.
 *
 * Event (ASCII JSON): {"v":2,"session":"<id4>","project":"<=14","agent":"lead"|"<id4>","role":"lead"|"<type>",
 * "evt":"<hook>","state":"working|needs_you|your_turn|done|error","cmd":"<=63","detail":"<=60"}.
 * See docs/hook-payloads.md (payloads observed) and the design spec section 10 (hook -> state mapping).
 *
 * Host (first match): env AGENTSDASH_HOST, then "host" in ~/.agentsdash/config.json, then 127.0.0.1:8765.
 * Options: AGENTSDASH_MASK=1 hides commands and prompts (only tool names are sent);
 * AGENTSDASH_DRY_RUN=1 prints the event to stderr instead of sending it;
 * AGENTSDASH_DUMP=<file> appends every raw payload to a file (debugging).
 * The old CLAUDE_GADGET_* names and ~/.claude/agent-gadget.json still work as a fallback.
 *
 * "Needs you" has no "approved" hook: a marker file (temp folder) remembers that an agent is blocked, so the
 * PostToolUse hook only sends something when it clears that state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tidy, configWindow, envVar, hubHost, pluginConfig, stateDir } from './common.mjs';
import { postEvent, restartStaleHub } from './hub_client.mjs';
import { update as updatePlan } from './plan_tracker.mjs';
import { contextWindow, loadCache, saveCache, scan } from './transcript_usage.mjs';

const NEEDS_YOU_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const CLEARING_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);

const alnum = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '');

/** [short argument, detail] of a tool call, e.g. ['app.py', 'src/app.py'] or ['git status', 'git status']. */
function toolParts(name, input) {
  const ti = input && typeof input === 'object' ? input : {};
  if (['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit'].includes(name)) {
    const p = String(ti.file_path || ti.notebook_path || '');
    return [path.posix.basename(p.replace(/\\/g, '/')), p];
  }
  if (name === 'Bash' || name === 'PowerShell') { const c = String(ti.command ?? ''); return [c, c]; }
  if (name === 'Grep' || name === 'Glob') { const p = String(ti.pattern ?? ''); return [p, p]; }
  if (name === 'WebFetch' || name === 'WebSearch') { const t = String(ti.url || ti.query || ''); return [t, t]; }
  if (name === 'Agent' || name === 'Task') { const d = String(ti.description ?? ''); return [d, d]; }
  return ['', ''];
}

/** [question, options] of an AskUserQuestion call: the first question and up to 4 options joined by "|". */
function askParts(input) {
  const ti = input && typeof input === 'object' ? input : {};
  const q = Array.isArray(ti.questions) && ti.questions[0] && typeof ti.questions[0] === 'object' ? ti.questions[0] : {};
  const opts = Array.isArray(q.options) ? q.options : [];
  const labels = opts.map((o) => (o && typeof o === 'object' ? String(o.label ?? '') : String(o)));
  return [String(q.question ?? ''), labels.slice(0, 4).map((l) => tidy(l).replace(/\|/g, '/')).join('|')];
}

export function markerPath(dir, sessionId, agent) {
  return path.join(dir, `${alnum(sessionId).slice(0, 12) || 'session'}-${agent}.needs`);
}

function setMarker(file, key = 'any') {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, key, 'ascii'); } catch { /* best effort */ }
}

function readMarker(file) {
  try {
    const key = fs.readFileSync(file, 'ascii').trim();
    return key === '' || key === '1' ? 'any' : key;        // "1": marker written by plugin 0.2.0
  } catch { return null; }
}

function sessionHasMarker(dir, sessionId) {
  const safe = alnum(sessionId).slice(0, 12) || 'session';
  try { return fs.readdirSync(dir).some((n) => n.startsWith(`${safe}-`) && n.endsWith('.needs')); } catch { return false; }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Identify a tool call across PermissionRequest (no tool_use_id) and PostToolUse: name + arguments. */
function callKey(p) {
  const digest = crypto.createHash('sha1').update(stable(p.tool_input ?? {})).digest('hex').slice(0, 12);
  return `${p.tool_name ?? ''}|${digest}`;
}

function sameCall(key, p) {
  if (key === 'any') return true;
  const i = key.indexOf('|');
  const name = key.slice(0, i);
  if ((p.tool_name ?? '') !== name) return false;
  if (name === 'AskUserQuestion') return true;      // PostToolUse may carry the answers in tool_input: the hash would not match
  return !('tool_input' in p) || callKey(p) === key;
}

function clearMarker(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }       // true when a marker existed
}

const EXCERPT_MAX = 300;

/**
 * First and last paragraph of the last reply (blank-line separated), markdown marks removed, each cut to EXCERPT_MAX characters.
 * Fields are left out when the reply is empty.
 */
export function replyExcerpts(message) {
  const paras = String(message ?? '').split(/\n\s*\n/)
    .map((x) => tidy(x.replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/gm, '').replace(/[*`]/g, '')))
    .filter(Boolean);
  if (!paras.length) return {};
  const cut = (x) => (x.length > EXCERPT_MAX ? `${x.slice(0, EXCERPT_MAX - 3)}...` : x);
  return { reply_first: cut(paras[0]), reply_last: cut(paras[paras.length - 1]) };
}

/** Map one hook payload to a v2 event object, or null when nothing should be sent. */
export function buildEvent(p, env = process.env, dir = stateDir(env)) {
  const hook = p.hook_event_name ?? '';
  const mask = Boolean(envVar('MASK', env));
  const agentId = String(p.agent_id || '');
  const agent = agentId ? agentId.slice(0, 4) : 'lead';
  const role = agentId ? tidy(p.agent_type || 'agent') : 'lead';
  const cwd = p.cwd || process.cwd();
  const sessionId = p.session_id ?? '';
  const marker = markerPath(dir, sessionId, agent);

  const event = (state, cmd, detail = '') => ({
    v: 2, session: alnum(sessionId).slice(0, 4), project: tidy(path.posix.basename(String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')) || 'claude'),
    ...(mask ? {} : { cwd: String(cwd) }),         // full path, for the hub's per-project rules
    agent, role, evt: hook, state, cmd: tidy(cmd), detail: mask ? '' : tidy(detail),
  });

  const toolEvent = (state, prefix = '') => {
    const name = String(p.tool_name ?? '');
    if (name === 'AskUserQuestion' && !mask && !agentId) {
      const [question, options] = askParts(p.tool_input);
      if (question) {
        const ev = event('needs_you', 'Question', '');
        ev.question = tidy(question);
        ev.options = options;
        return ev;
      }
    }
    if (name === 'SubagentHandback') return event(state, 'Reporting back');
    const [arg, detail] = toolParts(name, p.tool_input);
    return event(state, prefix + (mask ? name : `${name} ${arg}`), detail);
  };

  if (hook === 'SessionStart') return event('your_turn', 'Session started');
  if (hook === 'UserPromptSubmit') {
    clearMarker(marker);
    const prompt = String(p.prompt ?? '');
    if (prompt.trimStart().startsWith('<task-notification>')) return event('working', 'Sub-agent report');
    return event('working', mask ? 'Prompt' : `Prompt: ${prompt}`);
  }
  if (hook === 'PreToolUse') {
    if (p.tool_name === 'AskUserQuestion' && !agentId) {      // the question shows even without a permission prompt
      setMarker(marker, callKey(p));
      return toolEvent('needs_you');
    }
    if (readMarker(marker) !== null) return null;             // a parallel call starts while a prompt waits: stay "needs you"
    return toolEvent('working');
  }
  if (hook === 'PermissionRequest') {
    setMarker(marker, callKey(p));
    return toolEvent('needs_you', 'Approve? ');
  }
  if (CLEARING_EVENTS.has(hook)) {
    const key = readMarker(marker);
    if (key === null || !sameCall(key, p)) return null;       // another (parallel) call finished: the prompt still waits
    clearMarker(marker);
    return event('working', hook !== 'PermissionDenied' ? 'Resumed' : 'Denied, continuing');
  }
  const started = `${marker.slice(0, -'.needs'.length)}.started`;     // SubagentStart seen for this agent
  if (hook === 'SubagentStart') { setMarker(started); return event('working', 'Started'); }
  if (hook === 'SubagentStop') {
    clearMarker(marker);
    // Internal agents of Claude Code end every lead turn with a bare SubagentStop (agent_type "",
    // no SubagentStart): drop it, or the screen shows a ghost sub-agent.
    if (!clearMarker(started) && !p.agent_type) return null;
    return event('done', mask ? 'Finished' : p.last_assistant_message || 'Finished');
  }
  if (hook === 'Notification') {
    const kind = p.notification_type ?? '';
    if (NEEDS_YOU_TYPES.has(kind)) {
      // permission_prompt has no agent_id and comes ~6 s after PermissionRequest: when a marker already
      // exists in this session (often a sub-agent's), the prompt is known, so do not paint the lead orange.
      if (kind === 'permission_prompt' && sessionHasMarker(dir, sessionId)) return null;
      setMarker(marker);
      return event('needs_you', p.message || 'Needs your attention');
    }
    // idle_prompt ("waiting for you", about 60 s after a turn) is not sent: Stop already said your turn, and the notification
    // would bring back a session the hub dropped after 10 quiet minutes, or that the user hid.
    return null;
  }
  if (hook === 'Stop') {
    clearMarker(marker);
    const ev = event('your_turn', 'Done, waiting for you');
    if (!mask) Object.assign(ev, replyExcerpts(p.last_assistant_message));      // the hub page shows the one the user picked
    return ev;
  }
  if (hook === 'SessionEnd') { clearMarker(marker); return event('done', 'Session ended'); }
  return null;
}

/** Path of a sub-agent's own transcript: agent_transcript_path (SubagentStop) or derived from the lead's path. */
function subagentTranscript(p) {
  if (p.agent_transcript_path) return String(p.agent_transcript_path);
  if (!p.transcript_path || !p.agent_id) return null;
  const lead = String(p.transcript_path);
  const base = lead.endsWith('.jsonl') ? lead.slice(0, -'.jsonl'.length) : lead;
  return path.join(base, 'subagents', `agent-${p.agent_id}.jsonl`);
}

/** Add token counts (and, for the lead, session total, context and title) read from the transcripts.
 * Never throws: on any problem the event goes out unchanged. */
export function addUsage(ev, p, dir, mask = false, windowDefault = 1000000) {
  try {
    const session4 = alnum(p.session_id).slice(0, 4);
    const isSub = Boolean(p.agent_id);
    const file = isSub ? subagentTranscript(p) : p.transcript_path;
    if (typeof file !== 'string' || !file || !fs.existsSync(file)) return ev;
    const cache = loadCache(dir, session4);
    const entry = scan(file, cache[file]);
    cache[file] = entry;
    saveCache(dir, session4, cache);
    const out = { ...ev, tok: entry.tokens };
    if (entry.model) out.model = tidy(entry.model);
    if (!isSub) {
      out.stok = Object.values(cache).reduce((sum, e) => sum + (e && typeof e === 'object' ? e.tokens || 0 : 0), 0);
      if (entry.last_ctx > 0) {
        out.ctx_k = Math.round(entry.last_ctx / 1000);
        out.ctx_pct = Math.round((100 * entry.last_ctx) / contextWindow(entry.last_ctx, entry.model, windowDefault));
      }
      if (entry.title && !mask) {
        const title = tidy(entry.title);
        if (title) out.title = title;
      }
    }
    return out;
  } catch { return ev; }
}

/** Plan progress after this payload; null on any error, the event still goes out. */
function trackPlan(p, dir) {
  try { return updatePlan(dir, p); } catch { return null; }
}
function addPlan(ev, plan) { if (plan && ev.agent === 'lead') Object.assign(ev, plan); return ev; }

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));    // UTF-8, whatever the console code page
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  let p;
  try { p = JSON.parse(await readStdin()); } catch { return; }
  if (!p || typeof p !== 'object') return;
  const env = process.env;
  if (envVar('DUMP', env)) { try { fs.appendFileSync(envVar('DUMP', env), `${JSON.stringify(p)}\n`, 'utf8'); } catch { /* debugging aid only */ } }
  const dir = stateDir(env);
  const plan = trackPlan(p, dir);                          // every payload, even without an event
  let ev = buildEvent(p, env, dir);
  if (!ev) return;
  ev = addPlan(addUsage(ev, p, dir, Boolean(envVar('MASK', env)), configWindow(pluginConfig(env))), plan);
  if (!ev.model && typeof p.model === 'string' && p.model) ev.model = tidy(p.model);        // Codex sends the model in every payload
  if (envVar('DRY_RUN', env)) { process.stderr.write(`${JSON.stringify(ev)}\n`); return; }
  if (ev.evt === 'SessionStart') await restartStaleHub({ host: hubHost(env) });       // a plugin update leaves an old hub running
  await postEvent(ev, { host: hubHost(env), timeoutMs: 1500 });
}

// realpath: Node reports import.meta.url as the real path, argv[1] may go through a symlink (e.g. a linked ~/.claude)
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isMain) {
  setTimeout(() => process.exit(0), 3000).unref();        // failsafe: a hook never lingers
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  try { await main(); } catch { /* never fails */ }
  process.exitCode = 0;           // no process.exit(): on Windows it can abort (libuv assertion) while a hub child is detaching
}
