import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { parseSha256, extractTarGz, pickAsset, installCore } from '../scripts/core_install.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coreinst-'));

/** A ustar archive: entries are { name, data?, type? } (type '5' directory, '2' symlink, default regular file). */
function tar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write(e.type ?? '0', 156);
    h.write('ustar\0' + '00', 257);
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const pkg = (version, protocol) => JSON.stringify({ name: 'agentsdash-hub', version, protocol });
const coreTar = (version, protocol) => tar([
  { name: `agentsdash-core-${version}/`, type: '5' },
  { name: `agentsdash-core-${version}/hub.mjs`, data: '// hub' },
  { name: `agentsdash-core-${version}/package.json`, data: pkg(version, protocol) },
  { name: `agentsdash-core-${version}/web/a.js`, data: 'a' },
]);

test('parse_sha256', () => {
  assert.equal(parseSha256('abc123  agentsdash-core-1.0.0-p2.tar.gz\n', 'agentsdash-core-1.0.0-p2.tar.gz'), 'abc123');
  assert.equal(parseSha256('abc123  other.tar.gz\n', 'agentsdash-core-1.0.0-p2.tar.gz'), null);
  assert.equal(parseSha256('', 'x'), null);
});

test('extract_regular_files_and_dirs', () => {
  const dest = tmp();
  const files = extractTarGz(coreTar('1.0.0', 2), dest);
  assert.deepEqual(files.sort(), ['agentsdash-core-1.0.0/hub.mjs', 'agentsdash-core-1.0.0/package.json', 'agentsdash-core-1.0.0/web/a.js']);
  assert.equal(fs.readFileSync(path.join(dest, 'agentsdash-core-1.0.0', 'web', 'a.js'), 'utf8'), 'a');
});

test('extract_refuses_unsafe_entries', () => {
  for (const entry of [{ name: '../x' }, { name: '/etc/x' }, { name: 'top/../../x' }, { name: 'C:/x' }, { name: 'top\\..\\x' }, { name: 'top/link', type: '2' }, { name: 'top/dev', type: '3' }]) {
    const dest = tmp();
    assert.throws(() => extractTarGz(tar([entry]), dest), /unsafe tar entry/, entry.name);
    assert.deepEqual(fs.readdirSync(dest), [], 'nothing written');
  }
});

test('extract_git_archive_output', () => {
  const repo = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  const longDir = path.join(repo, 'icons', 'a-very-long-pack-name-to-force-a-pax-header-in-the-archive-because-it-passes-one-hundred-characters');
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(path.join(longDir, 'robot-idle-frame-with-a-long-name.svg'), '<svg/>');
  fs.writeFileSync(path.join(repo, 'hub.mjs'), '// hub');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  const archive = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=agentsdash-core-9.9.9/', 'HEAD'], { cwd: repo, maxBuffer: 1 << 24 });
  const dest = tmp();
  const files = extractTarGz(archive, dest);
  assert.ok(files.includes('agentsdash-core-9.9.9/hub.mjs'));
  assert.ok(files.some((f) => f.endsWith('robot-idle-frame-with-a-long-name.svg') && f.length > 100), 'a long path survives');
  assert.equal(fs.readFileSync(path.join(dest, files.find((f) => f.endsWith('hub.mjs'))), 'utf8'), '// hub');
});

const asset = (version, protocol) => [
  { name: `agentsdash-core-${version}-p${protocol}.tar.gz`, browser_download_url: `https://dl/${version}-p${protocol}.tar.gz` },
  { name: `agentsdash-core-${version}-p${protocol}.tar.gz.sha256`, browser_download_url: `https://dl/${version}-p${protocol}.sha256` },
];

test('pick_asset_skips_other_protocols_and_prereleases', () => {
  const releases = [
    { tag_name: 'v1.3.0', draft: true, prerelease: false, assets: asset('1.3.0', 2) },
    { tag_name: 'v1.2.0', draft: false, prerelease: true, assets: asset('1.2.0', 2) },
    { tag_name: 'v1.1.0', draft: false, prerelease: false, assets: asset('1.1.0', 3) },
    { tag_name: 'v1.0.5', draft: false, prerelease: false, assets: [asset('1.0.5', 2)[0]] },
    { tag_name: 'v1.0.0', draft: false, prerelease: false, assets: asset('1.0.0', 2) },
  ];
  assert.deepEqual(pickAsset(releases, 2), { version: '1.0.0', tarball: 'https://dl/1.0.0-p2.tar.gz', sha256: 'https://dl/1.0.0-p2.sha256', name: 'agentsdash-core-1.0.0-p2.tar.gz' });
  assert.equal(pickAsset([], 2), null);
});

/** A fake GitHub: release list plus the files of one release. */
function fakeGithub({ version = '1.0.0', protocol = 2, buffer = coreTar(version, protocol), digest } = {}) {
  const name = `agentsdash-core-${version}-p${protocol}.tar.gz`;
  const hex = digest ?? crypto.createHash('sha256').update(buffer).digest('hex');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) });
    if (url.includes('/releases')) return ok([{ tag_name: `v${version}`, draft: false, prerelease: false, assets: asset(version, protocol) }]);
    if (url.endsWith('.sha256')) return ok(`${hex}  ${name}\n`);
    return ok(buffer);
  };
  return { fetchImpl, calls };
}

test('install_happy_path', async () => {
  const coresDir = tmp();
  const { fetchImpl } = fakeGithub();
  assert.deepEqual(await installCore({ repo: 'o/r', protocol: 2, coresDir, fetchImpl }), { version: '1.0.0' });
  assert.ok(fs.existsSync(path.join(coresDir, '1.0.0', 'hub.mjs')));
  assert.ok(fs.existsSync(path.join(coresDir, '1.0.0', 'web', 'a.js')));
  assert.deepEqual(fs.readdirSync(coresDir), ['1.0.0'], 'no partial folder left');
});

test('install_hash_mismatch_leaves_nothing', async () => {
  const coresDir = tmp();
  const { fetchImpl } = fakeGithub({ digest: '0'.repeat(64) });
  assert.equal(await installCore({ repo: 'o/r', protocol: 2, coresDir, fetchImpl }), null);
  assert.deepEqual(fs.readdirSync(coresDir), []);
});

test('install_wrong_protocol_inside_archive', async () => {
  const coresDir = tmp();
  const name = 'agentsdash-core-1.0.0-p2.tar.gz';
  const { fetchImpl } = fakeGithub({ buffer: coreTar('1.0.0', 3) });
  assert.equal(await installCore({ repo: 'o/r', protocol: 2, coresDir, fetchImpl }), null, name);
  assert.deepEqual(fs.readdirSync(coresDir), []);
});

test('install_concurrent_second_wins_silently', async () => {
  const coresDir = tmp();
  fs.mkdirSync(path.join(coresDir, '1.0.0'));
  fs.writeFileSync(path.join(coresDir, '1.0.0', 'mine.txt'), 'x');
  const { fetchImpl, calls } = fakeGithub();
  assert.deepEqual(await installCore({ repo: 'o/r', protocol: 2, coresDir, fetchImpl }), { version: '1.0.0' });
  assert.deepEqual(fs.readdirSync(path.join(coresDir, '1.0.0')), ['mine.txt'], 'the existing folder is untouched');
  assert.deepEqual(fs.readdirSync(coresDir), ['1.0.0']);
  assert.equal(calls.length, 1, 'only the release list was fetched');
});

test('install_offline', async () => {
  const coresDir = tmp();
  const fetchImpl = async () => { throw new Error('offline'); };
  assert.equal(await installCore({ repo: 'o/r', protocol: 2, coresDir, fetchImpl }), null);
  assert.deepEqual(fs.readdirSync(coresDir), []);
});
