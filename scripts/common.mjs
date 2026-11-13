// Helpers shared by the plugin scripts. Standard library only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HUB = '127.0.0.1:8765';

/** The wire protocol this plugin speaks, and the oldest core it accepts (see docs/protocol.md). */
export const PROTOCOL = 2;
export const MIN_CORE = '0.4.1';

/** -1, 0 or 1 for two `X.Y.Z` version strings (numeric parts, a missing part is 0, a non-numeric string is lower than any number). */
export function compareVersions(a, b) {
  const parts = (v) => (/^\d+(\.\d+)*$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const pa = parts(a), pb = parts(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Value of AGENTSDASH_<name>, else the old CLAUDE_GADGET_<name> (the first non-empty one), else undefined. */
export function envVar(name, env = process.env) {
  for (const prefix of ['AGENTSDASH_', 'CLAUDE_GADGET_']) {
    const v = env[prefix + name];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** Collapse whitespace. No limit and no ASCII reduction: the hub keeps the full text, each screen adapts it (devices: relay's forDevice). */
export function tidy(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
}

// AGENTSDASH_USER_HOME replaces the OS home folder (tests use it so they never read the real one).
const userHome = (env) => env.AGENTSDASH_USER_HOME || os.homedir();
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** The config file: AGENTSDASH_CONFIG (or the old variable), else ~/.agentsdash/config.json, else the old ~/.claude/agent-gadget.json when only that exists. */
export function configFile(env = process.env) {
  const explicit = envVar('CONFIG', env);
  if (explicit) return explicit;
  const next = path.join(env.AGENTSDASH_HOME || path.join(userHome(env), '.agentsdash'), 'config.json');
  const legacy = path.join(userHome(env), '.claude', 'agent-gadget.json');
  return !exists(next) && exists(legacy) ? legacy : next;
}

/** The config file as an object; {} when missing or broken. */
export function pluginConfig(env = process.env) {
  try {
    const file = configFile(env);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Address of the hub: env AGENTSDASH_HOST (old name CLAUDE_GADGET_HOST), then "host" in the config file, then 127.0.0.1:8765. */
export function hubHost(env = process.env, cfg = pluginConfig(env)) {
  return envVar('HOST', env) || (typeof cfg.host === 'string' && cfg.host) || DEFAULT_HUB;
}

/** Default context window (tokens): "context_window" of the config file, else 1M. */
export function configWindow(cfg) {
  return Number.isInteger(cfg?.context_window) && cfg.context_window > 0 ? cfg.context_window : 1000000;
}

/** Where downloaded cores live: <~/.agentsdash>/core/<version>/ (AGENTSDASH_HOME moves the base). */
export function coresDir(env = process.env) {
  return path.join(env.AGENTSDASH_HOME || path.join(userHome(env), '.agentsdash'), 'core');
}

/** Folder for the marker files and transcript caches. */
export function stateDir(env = process.env) {
  return envVar('STATE_DIR', env) || path.join(os.tmpdir(), 'agentsdash');
}
