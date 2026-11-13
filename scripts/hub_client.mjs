// POST to the hub, starting it when it is not running. Never throws, never prints.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_CORE, PROTOCOL, compareVersions, coresDir, envVar, stateDir } from './common.mjs';

export { MIN_CORE, PROTOCOL };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HUB_SCRIPT = path.resolve(HERE, '..', 'hub', 'hub.mjs');         // the hub folder next to the scripts: only in the checkout
const INSTALLER = path.join(HERE, 'core_install.mjs');
const INSTALL_EVERY_S = 600;
const SPAWN_WAIT_MS = 400;

const isLoopback = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

/** One request without keep-alive (a pooled socket would keep the hook process alive). Resolves {status} or {error}. */
function request(host, route, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(`http://${host}${route}`);
    const req = http.request({
      hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 80, path: u.pathname, method, agent: false, timeout: Math.max(50, timeoutMs),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 4096) text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', () => resolve({ error: 'response' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || 'error' }));
    req.end(body);
  });
}

async function tryPost(host, route, data, deadline) {
  const r = await request(host, route, 'POST', data, deadline - Date.now());
  return { ok: r.status >= 200 && r.status < 300, refused: r.error === 'ECONNREFUSED' };
}

async function waitForHealth(host, until) {
  while (Date.now() < until) {
    const r = await request(host, '/health', 'GET', undefined, 150);
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

function spawnHub(script) {
  try {
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.on('error', () => {});
    child.unref();
  } catch { /* the event is dropped */ }
}

const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };

/**
 * The hub to run. Mode `local`: a script the user or the checkout names (an explicit argument, AGENTSDASH_CORE_DIR, the old
 * CLAUDE_GADGET_HUB_SCRIPT, the hub folder next to the scripts); the version rule does not apply. Mode `installed`: the highest
 * ~/.agentsdash/core/<version>/ whose package.json speaks PROTOCOL and whose version is at least MIN_CORE. null when there is none.
 * `siblingScript: null` turns the checkout lookup off (tests, and the adapter repo where no hub folder exists). Never throws.
 */
export function findCore({ env = process.env, hubScript, siblingScript = DEFAULT_HUB_SCRIPT } = {}) {
  if (hubScript) return { script: hubScript, mode: 'local' };
  if (env.AGENTSDASH_CORE_DIR) return { script: path.join(env.AGENTSDASH_CORE_DIR, 'hub.mjs'), mode: 'local' };
  const old = envVar('HUB_SCRIPT', env);
  if (old) return { script: old, mode: 'local' };
  try { if (siblingScript && fs.existsSync(siblingScript)) return { script: siblingScript, mode: 'local' }; } catch { /* look at the installed cores */ }
  try {
    const base = coresDir(env);
    const versions = fs.readdirSync(base).filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort((a, b) => compareVersions(b, a));
    for (const version of versions) {
      if (compareVersions(version, MIN_CORE) < 0) continue;
      try {
        const script = path.join(base, version, 'hub.mjs');
        const meta = JSON.parse(fs.readFileSync(path.join(base, version, 'package.json'), 'utf8'));
        if (meta.protocol === PROTOCOL && fs.existsSync(script)) return { script, mode: 'installed', version };
      } catch { /* a half-installed or foreign folder: skip it */ }
    }
  } catch { /* no cores folder yet */ }
  return null;
}

/** Starts core_install.mjs detached, at most once every 10 minutes (stamp file in `dir`). Never throws, never waits. @returns {boolean} true when it started one. */
export function maybeStartInstaller({ dir, now, spawnFn = spawn, script = INSTALLER, env = process.env }) {
  try {
    const stamp = path.join(dir, 'core_install.stamp');
    try { if (now - fs.statSync(stamp).mtimeMs / 1000 < INSTALL_EVERY_S) return false; } catch { /* no stamp yet */ }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(now));
    const child = spawnFn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

/** Newest change time of the *.mjs files next to the hub script (a hub started before that runs old code). */
function newestHubFile(script) {
  let newest = 0;
  try { for (const n of fs.readdirSync(path.dirname(script))) if (n.endsWith('.mjs')) newest = Math.max(newest, fs.statSync(path.join(path.dirname(script), n)).mtimeMs); } catch { /* skip */ }
  return newest;
}

/**
 * Asks a running hub on this machine to leave when it is the wrong one; the next post starts the right one. Never throws.
 * Local hub (a script the user or the checkout names): wrong when it runs another script or started before its files changed.
 * Installed core: the version rule, wrong only when `core` is missing, `protocol` is not PROTOCOL or `core` is below MIN_CORE;
 * a newer core is never replaced.
 * @returns {Promise<boolean>} true when a hub was told to stop.
 */
export async function restartStaleHub({ host, env = process.env, hubScript, siblingScript } = {}) {
  try {
    if (!isLoopback(host)) return false;
    const r = await request(host, '/health', 'GET', undefined, 300);
    if (r.status !== 200) return false;
    const info = JSON.parse(r.text);
    const core = findCore({ env, hubScript, ...(siblingScript === undefined ? {} : { siblingScript }) });
    const stale = core?.mode === 'local'
      ? real(info.script ?? '') !== real(core.script) || (info.startedAt ?? 0) < newestHubFile(core.script)
      : typeof info.core !== 'string' || info.protocol !== PROTOCOL || compareVersions(info.core, MIN_CORE) < 0;
    if (!stale) return false;
    await request(host, '/shutdown', 'POST', '{}', 300);
    for (const until = Date.now() + 700; Date.now() < until;) {            // wait for the port to be free
      if ((await request(host, '/health', 'GET', undefined, 100)).error) return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return true;
  } catch { return false; }
}

/**
 * POST `body` (object) to http://<host><route>. When the hub is not running (connection refused) and the host is
 * this machine, start it detached, wait up to 400 ms for /health and retry once.
 * @returns {Promise<boolean>} true when the hub accepted it.
 */
export async function postToHub(route, body, { host, timeoutMs = 1500, spawnHub: allowSpawn = true, hubScript, env = process.env, siblingScript, spawnFn } = {}) {
  try {
    const deadline = Date.now() + timeoutMs;
    const data = JSON.stringify(body);
    let r = await tryPost(host, route, data, deadline);
    if (!r.ok && r.refused && allowSpawn && isLoopback(host)) {
      const core = findCore({ env, hubScript, ...(siblingScript === undefined ? {} : { siblingScript }) });
      if (core) {
        spawnHub(core.script);
        if (await waitForHealth(host, Math.min(deadline, Date.now() + SPAWN_WAIT_MS))) r = await tryPost(host, route, data, deadline);
      } else maybeStartInstaller({ dir: stateDir(env), now: Date.now() / 1000, env, ...(spawnFn ? { spawnFn } : {}) });   // no core yet: download one, this event is dropped
    }
    return r.ok;
  } catch {
    return false;
  }
}

export const postEvent = (ev, opts) => postToHub('/event', ev, opts);
