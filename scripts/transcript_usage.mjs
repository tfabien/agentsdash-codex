/*
 * Token and context counts read from Codex rollout files (JSONL), incrementally.
 *
 * A rollout can reach several MB, so each scan starts at the byte offset where the previous one stopped and
 * only reads whole lines (a line Codex is still writing waits for the next scan).
 * Codex writes `{"type":"event_msg","payload":{"type":"token_count","info":{...}}}` after each model call; `info`
 * is null on lines that only carry rate limits.
 *
 * tokens   = total_token_usage.input_tokens - cached_input_tokens + output_tokens (a running total in the file, so
 *            the last one wins; cached input is left out: it repeats the context every turn)
 * last_ctx = last_token_usage.input_tokens of the last call (the size of the context; input includes the cached part)
 * window   = model_context_window of that line (0 when unknown)
 * title    = thread name of the session in ~/.codex/session_index.jsonl (see threadTitle), not in the rollout
 * Entry keys stay snake_case: the cache files are the ones the Python version wrote. Nothing here throws.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ = 4 * 1024 * 1024;

export const emptyEntry = () => ({ offset: 0, size: 0, tokens: 0, last_ctx: 0, window: 0, model: '', title: '', partial: false });

function apply(entry, record) {
  if (record.type === 'turn_context' && record.payload && record.payload.model) entry.model = String(record.payload.model);
  if (record.type !== 'event_msg') return;
  const payload = record.payload;
  if (!payload || payload.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') return;
  const n = (obj, key) => (obj && Number.isInteger(obj[key]) && obj[key] >= 0 ? obj[key] : 0);
  const total = payload.info.total_token_usage;
  const last = payload.info.last_token_usage;
  if (total) entry.tokens = Math.max(0, n(total, 'input_tokens') - n(total, 'cached_input_tokens')) + n(total, 'output_tokens');
  if (last) entry.last_ctx = n(last, 'input_tokens');
  entry.window = n(payload.info, 'model_context_window');
}

/** Read the new whole lines of `file` and return the updated entry (see emptyEntry for its fields). */
export function scan(file, previous, maxRead = MAX_READ) {
  let entry = { ...emptyEntry(), ...(previous && typeof previous === 'object' ? previous : {}) };
  let size;
  try { size = fs.statSync(file).size; } catch { return entry; }
  if (size < entry.offset) entry = emptyEntry();                // rewritten file: start again
  let start = entry.offset;
  let skipFirst = false;
  if (size - start > maxRead) {                                  // first sight of a big file: only its tail
    start = size - maxRead;
    skipFirst = true;
    entry.partial = true;
  }
  let data;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      data = Buffer.alloc(size - start);
      fs.readSync(fd, data, 0, data.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return entry; }
  const end = data.lastIndexOf(0x0a);
  if (end < 0) {                                                 // no whole line yet
    if (skipFirst) entry.offset = start;
    entry.size = size;
    return entry;
  }
  let lines = data.subarray(0, end).toString('utf8').split('\n');
  if (skipFirst) lines = lines.slice(1);                         // the first line is cut
  for (const raw of lines) {
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    if (record && typeof record === 'object' && !Array.isArray(record)) apply(entry, record);
  }
  entry.offset = start + end + 1;
  entry.size = size;
  return entry;
}

/** Context window: the size Codex records on the token_count line, else `dflt` (Codex models: about 258k). */
export function contextWindow(recorded, dflt = 258400) {
  return Number.isInteger(recorded) && recorded > 0 ? recorded : dflt;
}

/** Name Codex gave the thread (last matching line of session_index.jsonl in CODEX_HOME or ~/.codex); '' when none. */
export function threadTitle(sessionId, home) {
  try {
    const raw = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8');
    let title = '';
    for (const line of raw.split('\n')) {
      if (!line.includes(sessionId)) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id === sessionId && typeof rec.thread_name === 'string' && rec.thread_name) title = rec.thread_name;
      } catch { /* a line being written */ }
    }
    return title;
  } catch { return ''; }
}

const cachePath = (dir, session4) => path.join(dir, `${session4 || 'session'}.tok.json`);

export function loadCache(dir, session4) {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath(dir, session4), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function saveCache(dir, session4, cache) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cachePath(dir, session4)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, cachePath(dir, session4));
  } catch { /* the next scan starts again from the cache that exists */ }
}
