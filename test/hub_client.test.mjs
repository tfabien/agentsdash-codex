import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findCore, maybeStartInstaller, postToHub, PROTOCOL, MIN_CORE } from '../scripts/hub_client.mjs';
import { compareVersions } from '../scripts/common.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hubclient-'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** An installed core: <home>/.agentsdash/core/<version>/{hub.mjs,package.json}. */
function install(home, version, protocol = PROTOCOL) {
  const dir = path.join(home, '.agentsdash', 'core', version);
  put(path.join(dir, 'hub.mjs'), '// hub');
  put(path.join(dir, 'package.json'), JSON.stringify({ version, protocol }));
  return path.join(dir, 'hub.mjs');
}

test('compare_versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('x.y', '0.0.1'), -1);
  assert.equal(compareVersions('0.4.1', '0.4.1'), 0);
});

test('find_core_order', () => {
  const env = { AGENTSDASH_CORE_DIR: path.join('c', 'core'), CLAUDE_GADGET_HUB_SCRIPT: path.join('y', 'hub.mjs') };
  assert.deepEqual(findCore({ env, hubScript: 'explicit.mjs' }), { script: 'explicit.mjs', mode: 'local' });
  assert.deepEqual(findCore({ env }), { script: path.join('c', 'core', 'hub.mjs'), mode: 'local' });
  assert.deepEqual(findCore({ env: { CLAUDE_GADGET_HUB_SCRIPT: path.join('y', 'hub.mjs') } }), { script: path.join('y', 'hub.mjs'), mode: 'local' });
  assert.equal(findCore({ env: { AGENTSDASH_USER_HOME: tmp() } }), null, 'no hub folder next to the scripts in this repository, no installed core');
});

test('find_core_picks_highest_matching_installed', () => {
  const home = tmp();
  const env = { AGENTSDASH_USER_HOME: home };
  assert.equal(findCore({ env, siblingScript: null }), null, 'no core at all');
  install(home, '0.4.0');                       // below the minimum
  install(home, '0.6.0', 3);                    // other protocol
  assert.equal(findCore({ env, siblingScript: null }), null);
  install(home, '0.4.1');
  const best = install(home, '0.5.0');
  fs.mkdirSync(path.join(home, '.agentsdash', 'core', '0.9.0.partial-1-ab'), { recursive: true });
  assert.deepEqual(findCore({ env, siblingScript: null }), { script: best, mode: 'installed', version: '0.5.0' });
  assert.ok(compareVersions('0.5.0', MIN_CORE) >= 0);
});

test('installer_start_is_throttled', () => {
  const dir = tmp();
  const started = [];
  const spawnFn = (...args) => { started.push(args); return { on() {}, unref() {} }; };
  assert.equal(maybeStartInstaller({ dir, now: 1000, spawnFn }), true);
  assert.equal(started.length, 1);
  assert.equal(maybeStartInstaller({ dir, now: Date.now() / 1000 + 1, spawnFn }), false, 'stamp just written');
  assert.equal(maybeStartInstaller({ dir, now: Date.now() / 1000 + 601, spawnFn }), true);
  assert.equal(maybeStartInstaller({ dir: path.join(dir, 'core_install.stamp', 'x'), now: Date.now() / 1000 + 2000, spawnFn }), false, 'an unwritable folder is not an error');
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('post_without_core_drops_the_event_and_starts_the_installer', async () => {
  const home = tmp();
  const started = [];
  const spawnFn = (...args) => { started.push(args); return { on() {}, unref() {} }; };
  const ok = await postToHub('/event', { v: 2 }, {
    host: `127.0.0.1:${await freePort()}`, env: { AGENTSDASH_USER_HOME: home, AGENTSDASH_STATE_DIR: path.join(home, 'state') },
    siblingScript: null, spawnFn,
  });
  assert.equal(ok, false);
  assert.equal(started.length, 1);
  assert.match(String(started[0][1][0]), /core_install\.mjs$/);
});

// ---------- the version rule ----------
import http from 'node:http';
import { restartStaleHub } from '../scripts/hub_client.mjs';

/** A fake hub: answers /health with `health`, counts POST /shutdown (and goes away on it). */
async function fakeHub(health) {
  const state = { shutdowns: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/shutdown') {
      state.shutdowns++;
      res.end('bye');
      setTimeout(() => { server.close(); server.closeAllConnections?.(); }, 10);
    } else res.end(JSON.stringify({ ok: true, ...health }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.host = `127.0.0.1:${server.address().port}`;
  state.close = () => { server.close(); server.closeAllConnections?.(); };
  return state;
}

test('rule_keeps_a_newer_core', async () => {
  const hub = await fakeHub({ core: '9.0.0', protocol: PROTOCOL });
  try {
    assert.equal(await restartStaleHub({ host: hub.host, env: { AGENTSDASH_USER_HOME: tmp() }, siblingScript: null }), false);
    assert.equal(hub.shutdowns, 0);
  } finally { hub.close(); }
});

test('rule_replaces_old_or_foreign_hubs', async () => {
  for (const health of [{ version: '0.4.1' }, { core: '0.1.0', protocol: PROTOCOL }, { core: '9.0.0', protocol: 3 }]) {
    const hub = await fakeHub(health);
    try {
      assert.equal(await restartStaleHub({ host: hub.host, env: { AGENTSDASH_USER_HOME: tmp() }, siblingScript: null }), true, JSON.stringify(health));
      assert.equal(hub.shutdowns, 1);
    } finally { hub.close(); }
  }
});

test('local_mode_replaces_a_hub_from_another_script', async () => {
  const dir = tmp();
  const script = path.join(dir, 'hub.mjs');
  fs.writeFileSync(script, '// hub');
  const other = await fakeHub({ core: '9.0.0', protocol: PROTOCOL, script: path.join(tmp(), 'hub.mjs'), startedAt: Date.now() + 5000 });
  try {
    assert.equal(await restartStaleHub({ host: other.host, hubScript: script }), true);
    assert.equal(other.shutdowns, 1);
  } finally { other.close(); }
  const same = await fakeHub({ core: '0.0.1', script, startedAt: Date.now() + 5000 });
  try {
    assert.equal(await restartStaleHub({ host: same.host, hubScript: script }), false, 'local mode ignores the version');
    assert.equal(same.shutdowns, 0);
  } finally { same.close(); }
  const old = await fakeHub({ script, startedAt: 1000 });
  try {
    assert.equal(await restartStaleHub({ host: old.host, hubScript: script }), true, 'started before the files changed');
  } finally { old.close(); }
});

test('non_loopback_host_is_never_touched', async () => {
  assert.equal(await restartStaleHub({ host: '192.168.1.5:8765', env: {}, siblingScript: null }), false);
});
