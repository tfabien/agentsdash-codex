/*
 * Plan progress of a session, rebuilt from its task-list tool calls (payload shapes: docs/hook-payloads.md).
 *
 * update(stateDir, payload) applies one PostToolUse hook payload of the lead and returns the event fields
 * {plan_done, plan_total, plan_cur, plan_next[, plan_state]}, or null when the session never had a plan; a list that
 * became empty gives plan_total 0 (the screen then clears its plan). The list lives in <stateDir>/plan-<session12>.json
 * as {"tasks": [{id, title, status}], "had": bool}. Hooks of parallel tool calls run as concurrent processes:
 * read-modify-write holds a lock file and the write is atomic (temp file + rename). notify.mjs wraps the call in try/catch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tidy } from './common.mjs';

const DESKTOP_TOOL = 'mcp__ccd_turn__update_plan';     // the desktop app's task list
const DESKTOP_WRAP_UP = 'mcp__ccd_turn__wrap_up';       // the desktop app closes the task list of a turn with it
const LOCK_WAIT_MS = 2000;      // give up waiting for the lock after this (the event goes out without a plan update)
const LOCK_STALE_MS = 10000;
const PLAN_MAX_AGE_MS = 6 * 3600 * 1000;    // a list untouched for this long belongs to a finished piece of work    // a lock older than this was left by a killed process

const clean = (text) => tidy(text);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function statePath(dir, sessionId) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'session';
  return path.join(dir, `plan-${safe}.json`);
}

/** [tasks, had, meta] from the state file; a missing or broken file is an empty list never filled.
 * meta = {at, calls}: time of the last plan change and tool calls since then (null/0 in older files). */
function load(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return [[], false, { at: null, calls: 0 }]; }
  if (Array.isArray(data)) data = { tasks: data, had: data.length > 0 };       // older format: the list alone
  const tasks = (Array.isArray(data?.tasks) ? data.tasks : []).filter((t) => t && typeof t === 'object' && 'id' in t && 'status' in t);
  const meta = { at: Number.isFinite(data?.at) ? data.at : null, calls: Number.isInteger(data?.calls) ? data.calls : 0 };
  return [tasks, Boolean(data?.had) || tasks.length > 0, meta];
}

/** The plan of a session for other scripts: {tasks, had, ageMs, calls}; ageMs (since the last plan change) is null when no state file exists. */
export function readPlan(dir, sessionId, now = Date.now()) {
  const file = statePath(dir, sessionId);
  const [tasks, had, meta] = load(file);
  let ageMs = null;
  try { ageMs = now - (meta.at ?? fs.statSync(file).mtimeMs); } catch { /* no plan file */ }
  return { tasks, had, ageMs, calls: meta.calls };
}

/** Count one non-plan tool call of a session with a plan (for the "plan not updated" reminder); returns the new count, or 0 without a plan. */
export function bumpCalls(dir, sessionId) {
  const file = statePath(dir, sessionId);
  if (!fs.existsSync(file)) return 0;
  return withLock(file, () => {
    const [tasks, had, meta] = load(file);
    if (!tasks.length) return 0;
    const calls = meta.calls + 1;
    save(file, tasks, had, { at: meta.at ?? fs.statSync(file).mtimeMs, calls });
    return calls;
  });
}

/** On Windows a rename onto a file that another process (or a scanner) holds open fails with EPERM/EBUSY/EACCES for a few ms: retry. */
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(10);
    }
  }
}

function save(file, tasks, had, meta = { at: Date.now(), calls: 0 }) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ tasks, had, at: meta.at, calls: meta.calls }), 'utf8');
    renameWithRetry(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } }
}

/** Run `fn` holding an exclusive lock file next to the state file (create-exclusive); a stale lock is removed. */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const end = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < end) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); held = true; break; } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); } catch { /* raced */ }
      sleep(10);
    }
  }
  try { return fn(); } finally { if (held) { try { fs.unlinkSync(lock); } catch { /* already gone */ } } }
}

function fromItems(items) {
  return (Array.isArray(items) ? items : []).flatMap((it, i) => (it && typeof it === 'object'
    ? [{ id: String(i + 1), title: clean(it.content || it.subject || ''), status: it.status || 'pending' }] : []));
}

/** The new task list after one tool call, or null when the tool is not a task-list tool. */
function applyTool(tasks, name, ti, resp) {
  if (name === 'TaskCreate') {
    if ('tasks' in ti) {                                         // older form: the whole list as a JSON string
      try { return fromItems(typeof ti.tasks === 'string' ? JSON.parse(ti.tasks) : ti.tasks); } catch { return tasks; }
    }
    if (tasks.length && tasks.every((t) => t.status === 'completed')) tasks = [];   // a finished list: this create starts a new one
    const task = resp && typeof resp === 'object' ? resp.task : null;
    const id = task && typeof task === 'object' && task.id != null ? String(task.id) : String(tasks.length + 1);
    return [...tasks, { id, title: clean(ti.subject ?? ''), status: 'pending' }];
  }
  if (name === 'TaskUpdate') {
    const out = [];
    for (const t of tasks) {
      if (t.id === String(ti.taskId)) {
        if (ti.status === 'deleted') continue;
        out.push({ ...t, status: ti.status || t.status, title: ti.subject ? clean(ti.subject) : t.title });
      } else out.push(t);
    }
    return out;
  }
  if (name === 'TodoWrite') return fromItems(ti.todos);
  if (name === DESKTOP_WRAP_UP) return tasks.map((t) => ({ ...t, status: 'completed' }));     // the turn is over: every step is done
  if (name === DESKTOP_TOOL) {
    if ('items' in ti) tasks = fromItems(ti.items);
    tasks = tasks.map((t) => ({ ...t }));
    for (const n of Array.isArray(ti.done) ? ti.done : []) if (Number.isInteger(n) && n >= 1 && n <= tasks.length) tasks[n - 1].status = 'completed';
    if (ti.advance) {
      const cur = tasks.find((t) => t.status === 'in_progress');
      if (cur) cur.status = 'completed';
      const next = tasks.find((t) => t.status === 'pending');
      if (next) next.status = 'in_progress';
    }
    if (Number.isInteger(ti.start) && ti.start >= 1 && ti.start <= tasks.length) tasks[ti.start - 1].status = 'in_progress';
    return tasks;
  }
  return null;
}

/** The event fields of a task list; null when the session never had a plan. */
export function fields(tasks, had) {
  if (!tasks.length) return had ? { plan_done: 0, plan_total: 0, plan_cur: '', plan_next: '' } : null;
  const running = tasks.filter((t) => t.status === 'in_progress');
  const pending = tasks.filter((t) => t.status === 'pending');
  const out = {
    plan_done: tasks.filter((t) => t.status === 'completed').length, plan_total: tasks.length,
    plan_cur: running.map((t) => t.title).join(' + '), plan_next: pending.length ? pending[0].title : '',
  };
  out.plan_items = tasks.slice(0, 30).map((t) => `${{ completed: 'd', in_progress: 'r' }[t.status] ?? 'p'}:${t.title}`);     // for the page: tap a step to read it
  if (running.length > 1) {         // parallel steps: the screen pulses each running segment ("d", "r", "p" per task)
    out.plan_state = tasks.slice(0, 16).map((t) => ({ completed: 'd', in_progress: 'r' }[t.status] ?? 'p')).join('');
  }
  return out;
}

/** Forget the list when it is out of date: a new session, a finished list at the end of a turn or when the next prompt arrives, or one untouched for hours. */
function dropStale(file, hook) {
  let stale = hook === 'SessionStart';
  if (!stale) {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > PLAN_MAX_AGE_MS) stale = true;
      else if (hook === 'UserPromptSubmit' || hook === 'Stop') { const [tasks] = load(file); stale = tasks.length > 0 && tasks.every((t) => t.status === 'completed'); }
    } catch { return; }
  }
  if (stale) { try { fs.unlinkSync(file); } catch { /* nothing to drop */ } }
}

export function update(dir, payload) {
  if (payload.agent_id) return null;                              // sub-agents' own task lists are not the session plan
  const file = statePath(dir, payload.session_id);
  const name = String(payload.tool_name || '');
  const hadFile = fs.existsSync(file);
  dropStale(file, payload.hook_event_name);
  if (hadFile && !fs.existsSync(file)) return { plan_done: 0, plan_total: 0, plan_cur: '', plan_next: '', plan_items: [] };     // tell the hub to clear it
  if (payload.hook_event_name !== 'PostToolUse' || !name) return fields(...load(file));
  fs.mkdirSync(dir, { recursive: true });
  return withLock(file, () => {
    let [tasks, had] = load(file);
    const ti = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const next = applyTool(tasks, name, ti, payload.tool_response);
    if (next !== null) {
      tasks = next;
      had = had || next.length > 0;
      save(file, tasks, had);                                    // resets the "plan not updated" counter
    }
    return fields(tasks, had);
  });
}
