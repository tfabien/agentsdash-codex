#!/usr/bin/env node
/*
 * Downloads a core release (the hub) from GitHub into ~/.agentsdash/core/<version>/. Standard library only.
 *
 * A release holds `agentsdash-core-<version>-p<protocol>.tar.gz` and the same name plus `.sha256`. The newest release for the protocol
 * this plugin speaks is downloaded, its sha256 checked, unpacked into a temporary folder and renamed to <version> in one step, so a
 * folder named <version> is always whole. Never throws and never prints: hooks start this script detached (see hub_client.mjs).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { PROTOCOL, coresDir, envVar, pluginConfig } from './common.mjs';

const DEFAULT_REPO = 'tfabien/agentsdash';
const TIMEOUT_MS = 30000;
const MAX_BYTES = 50 * 1024 * 1024;

/** The hex digest of `name` in a `.sha256` file (`<hex>  <name>` lines), or null. */
export function parseSha256(text, name) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{6,128})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

const cString = (buf) => { const i = buf.indexOf(0); return buf.toString('utf8', 0, i < 0 ? buf.length : i); };

/** Records of a pax extended header: "<len> <key>=<value>\n". */
function paxRecords(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) break;
    const len = parseInt(data.toString('utf8', at, sp), 10);
    if (!Number.isInteger(len) || len <= 0) break;
    const record = data.toString('utf8', sp + 1, at + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

function safeRelative(name) {
  const parts = String(name).split('/');
  const bad = !name || name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name) || name.includes('\0') || parts.some((p) => p === '..');
  if (bad) throw new Error(`unsafe tar entry: ${name}`);
  return parts.filter((p) => p && p !== '.').join('/');
}

/**
 * Unpacks a .tar.gz of regular files and directories into `destDir` (ustar, plus the pax headers `git archive` writes).
 * Anything else (links, devices, a path outside `destDir`) throws `unsafe tar entry: <name>` before it is written.
 * @returns {string[]} the relative paths of the files written.
 */
export function extractTarGz(buffer, destDir) {
  const tar = zlib.gunzipSync(buffer, { maxOutputLength: MAX_BYTES * 4 });
  const root = path.resolve(destDir);
  const written = [];
  let override = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const type = String.fromCharCode(header[156] || 0x30);
    const size = parseInt(cString(header.subarray(124, 136)).trim() || '0', 8);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;                                          // global pax header (git archive: the commit id)
    if (type === 'x') { override = paxRecords(data).path ?? null; continue; }
    const prefix = cString(header.subarray(345, 500));
    const name = override ?? (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)));
    override = null;
    if (type !== '0' && type !== '5') throw new Error(`unsafe tar entry: ${name}`);
    const rel = safeRelative(name);
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe tar entry: ${name}`);
    if (type === '5') { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(rel);
  }
  return written;
}

/** The newest usable release: not a draft or prerelease, with a `-p<protocol>` tarball and its `.sha256`. */
export function pickAsset(releases, protocol) {
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease || !Array.isArray(r.assets)) continue;
    for (const a of r.assets) {
      const m = /^agentsdash-core-(\d+\.\d+\.\d+)-p(\d+)\.tar\.gz$/.exec(a?.name ?? '');
      if (!m || Number(m[2]) !== protocol) continue;
      const sum = r.assets.find((s) => s?.name === `${a.name}.sha256`);
      if (sum) return { version: m[1], tarball: a.browser_download_url, sha256: sum.browser_download_url, name: a.name };
    }
  }
  return null;
}

const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

/**
 * Installs the newest core of `repo` that speaks `protocol` into `<coresDir>/<version>`.
 * @returns {Promise<{version: string} | null>} null when anything fails (offline, bad hash, wrong content); nothing is left behind.
 */
export async function installCore({ repo, protocol, coresDir: base, fetchImpl = globalThis.fetch }) {
  let partial = null;
  try {
    const get = (url) => fetchImpl(url, { headers: { 'User-Agent': 'agentsdash', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const list = await get(`https://api.github.com/repos/${repo}/releases?per_page=10`);
    if (!list.ok) return null;
    const pick = pickAsset(await list.json(), protocol);
    if (!pick) return null;
    const final = path.join(base, pick.version);
    if (fs.existsSync(final)) return { version: pick.version };           // another process installed it already
    const [tarRes, sumRes] = await Promise.all([get(pick.tarball), get(pick.sha256)]);
    if (!tarRes.ok || !sumRes.ok) return null;
    const buffer = Buffer.from(await tarRes.arrayBuffer());
    if (buffer.length > MAX_BYTES) return null;
    const wanted = parseSha256(await sumRes.text(), pick.name);
    if (!wanted || crypto.createHash('sha256').update(buffer).digest('hex') !== wanted) return null;
    fs.mkdirSync(base, { recursive: true });
    partial = path.join(base, `${pick.version}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    extractTarGz(buffer, partial);
    const tops = fs.readdirSync(partial);
    if (tops.length !== 1) return null;
    const src = path.join(partial, tops[0]);
    const meta = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    if (!fs.existsSync(path.join(src, 'hub.mjs')) || meta.version !== pick.version || meta.protocol !== protocol) return null;
    try { fs.renameSync(src, final); } catch { if (!fs.existsSync(final)) return null; }   // a concurrent install won the rename
    return { version: pick.version };
  } catch { return null; } finally { if (partial) rm(partial); }
}

// `node core_install.mjs`: one install attempt, then exit. Never fails.
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isMain) {
  setTimeout(() => process.exit(0), 60000).unref();
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  const env = process.env;
  try {
    const cfg = pluginConfig(env);
    const repo = envVar('CORE_REPO', env) || (typeof cfg.core_repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(cfg.core_repo) ? cfg.core_repo : DEFAULT_REPO);
    await installCore({ repo, protocol: PROTOCOL, coresDir: coresDir(env) });
  } catch { /* the next try is in ten minutes */ }
  process.exitCode = 0;
}
