/*
 * Token and context counts read from Claude Code transcripts (JSONL), incrementally.
 *
 * A transcript can reach several MB, so each scan starts at the byte offset where the previous one stopped and
 * only reads whole lines (a line Claude is still writing waits for the next scan). One assistant message is
 * written on several lines that repeat the same message.id and usage: each id is counted once.
 *
 * tokens   = input + cache creation + output, summed (cache reads are left out: they repeat the context every turn)
 * last_ctx = input + cache creation + cache read of the last assistant message (the size of the context)
 * title    = last "custom-title" (desktop app) or "ai-title" (terminal) line of the file
 * Entry keys stay snake_case: the cache files are the ones the Python version wrote. Nothing here throws.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ = 4 * 1024 * 1024;
const SEEN_KEEP = 50;

export const emptyEntry = () => ({ offset: 0, size: 0, tokens: 0, last_ctx: 0, model: '', title: '', seen: [], partial: false });

function apply(entry, record) {
  const kind = record.type;
  if (kind === 'custom-title' && record.customTitle) entry.title = String(record.customTitle);
  else if (kind === 'ai-title' && record.aiTitle) entry.title = String(record.aiTitle);
  else if (kind === 'assistant') {
    const msg = record.message;
    if (!msg || typeof msg !== 'object' || !msg.usage || typeof msg.usage !== 'object') return;
    const n = (key) => (Number.isInteger(msg.usage[key]) ? msg.usage[key] : 0);
    if (msg.model) entry.model = String(msg.model);
    entry.last_ctx = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    const mid = msg.id;
    if (mid && entry.seen.includes(mid)) return;
    if (mid) entry.seen = [...entry.seen, mid].slice(-SEEN_KEEP);
    entry.tokens += n('input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
  }
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

/** Context window guess (transcripts do not record it): 1M when the context is past 200k or the model id says
 * [1m], else `dflt` (1M: desktop sessions run with a 1M window; set "context_window" in the config file). */
export function contextWindow(lastCtx, model, dflt = 1000000) {
  return lastCtx > 200000 || String(model).includes('[1m]') ? 1000000 : dflt;
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
