import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { parseSha256, extractTarGz, pickAsset, installCore, proxyFor, proxyFetch } from '../scripts/core_install.mjs';

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

// --- proxy ---

// A self-signed certificate for localhost (valid until 2126), so the tunnel test runs a real TLS server.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDBDMcfprsKphtl
wFn8NbNJVVC6SP7nK4FBap8lbufT4wEcpLMxz2rdsmcAI8zuKGEUE+WXzM66IAKg
uOMPFxd/anfU4VbvraKIz2awjfgttoj5yu2ewzipwp0VcMRtU89gEcpYYRwhVb/9
D3AUKQyV1I3mtUUEr5yF0WvrCNCm6cYgDVEv8RSDrPMqbp8M1T1GwGZS5VZG2oX4
a+SJ4uJOm3cUnYDhuBoUVJtjPun6IoVfI23vgZgVVOfrqiuHPFyJ+odBkVI1olkS
xhPajqyGxGU+CzFu8IRtALeb8PDZ+bVUOxLwuFWpxsl8/F9P84UovFIFhmNP1cb1
T3h3tv4jAgMBAAECggEAQMYOS/bwHEcWu0Haj47fHLR1FUQnzx3gTTg+tNstCwHI
Xjl+7LAZPdC90aSxfplq1UdFynTMSlQyPYY7nVUUq8pn8bQ4LMxYVEouvP+trXzp
IdMufo4nRYKInWiMZ9hupN/jQls3CpJQjFLxOrp5QA6lHCtnQIbB4H6flKmNBOum
A0uQ/3asIVOw8l46J9Gcy1Szr6wzo5XBV60WNibU9E5Aa2CCWA7tM4BmiKfLss50
e2BX9lCpqBMitw5sAjKHCKmJiP8mBzVlLlnUWyk9xRBS8Xl9067HdKcAUthhodi/
8DXY1XaxEgna3fyysq5xd6yd+8LMctwtf6jx0ZFpCQKBgQD85rDtoAZJ7d2hfpUg
QYsM2cJlv22wmhOKKX7dyvgLX4Kb4edVzyru1ychlg3AjVLqE9dm8N6dDdXfd+8A
uzgRIABFORf5wUKvwnr16TvE9K/4XrO5HT7qQ2uKLoBUHSj/zYkH8zGDf7DlXdZq
4fpMS5laQpClqRtwtlOHMmvR+QKBgQDDalflxViD7i4OyyiUHaFGdXA+hLHwwZIr
wCK53BjpR7CQt6hG4N9JuWPR4jaok6/3YjjR7dAHgbQxRbEJtwycK/jM50HpiDNk
7pUpuXKDYHADHpxGq4z5oIFkbPvEtRqXWcuLRl0wZbFpKVuC5KZNAkADN/g2WNeK
1CKg+ejX+wKBgGjF7gDULibMq+gu9/sgDEproNTkZL4oZvXzUQL0BqU3kXWhNmTf
agr/CdApSVM/eV1OkQutuJxaUgO9vT+RUJ4Pou0KxTsMbONB8A0W7lMfiBOesFh9
nEYTXmcl8rZmSkkHzsCDaTzwVsn/gUhQjJC1NTgmoaRwFdUxRBObuP2JAoGAH7hN
WEC2Y4Pv+frENXaxzQwXEi7b62agYXWorV6qtIMsh/En4Yly9Tagm1sK4EZI0/Ef
pAPkNrO5Gh5j5F3QMDF7C1emfU/cd8+6arFtgyHOTNNVLqt+EK8bEcAXBhEXpeWv
goYDbm2zZIyQDCktTWbGGT+mjLvTEPfqPxMR1q0CgYAloZVIvmSRW8u+JVg0lGPz
cdQYO7vBW5aEOb3KWVlFbuF3UusNn+7prDPp6O6NNDEarrtHoIm9aablsacEPt/D
bO11nRQHP9Lcz/OD7F8OgK2AWaEs0C6Q+gMP4qKa+X1IMX9wi1T/wQnrf5yqn1Hp
VW/3nfkjaq2IKtNsp26GqA==
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUDE6W4mP2rxiwvQUQFJ9F/G6wfXMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExNDE0MDE1MVoYDzIxMjYx
MDIxMTQwMTUxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDBDMcfprsKphtlwFn8NbNJVVC6SP7nK4FBap8lbufT
4wEcpLMxz2rdsmcAI8zuKGEUE+WXzM66IAKguOMPFxd/anfU4VbvraKIz2awjfgt
toj5yu2ewzipwp0VcMRtU89gEcpYYRwhVb/9D3AUKQyV1I3mtUUEr5yF0WvrCNCm
6cYgDVEv8RSDrPMqbp8M1T1GwGZS5VZG2oX4a+SJ4uJOm3cUnYDhuBoUVJtjPun6
IoVfI23vgZgVVOfrqiuHPFyJ+odBkVI1olkSxhPajqyGxGU+CzFu8IRtALeb8PDZ
+bVUOxLwuFWpxsl8/F9P84UovFIFhmNP1cb1T3h3tv4jAgMBAAGjaTBnMB0GA1Ud
DgQWBBQr10dlNFaIqMjbkOQLLYL/3/oLNDAfBgNVHSMEGDAWgBQr10dlNFaIqMjb
kOQLLYL/3/oLNDAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWxvY2FsaG9z
dDANBgkqhkiG9w0BAQsFAAOCAQEACUlD9jxuB++yWnwnmalekmvF/AEDkK0qdPeK
InSYrEWU9qbuZ3sMmHCIiUxc/WJ7HKYVmM/Vr4G8GXwNA8jUfyN7BKG1dNA8XPYu
w+wDKIaqn0y9DY1XaEyG3g3uYoliKyDwXzUqu6PYu65eY9ASTn21o8h+NJjcZptJ
ECHYK4pok5kQCzEY9JovmeuA8JtqVJvRv5oPmI8CTReZmE6JIhF3zTFo8HQmT18j
t95tLkGhCoAenwSU+8dt9lkka1efLDU7aAzlEkpYJqwuvsl+FfjIZkbSxLo8oHWw
clhVkDKFAnCvJqNYgTKl0f3uRDCVTL9TN69AYhzIgJgs5KCdvA==
-----END CERTIFICATE-----
`;

test('proxy_for_reads_env_and_no_proxy', () => {
  assert.equal(proxyFor('https://api.github.com/x', {}), null);
  assert.equal(proxyFor('https://api.github.com/x', { HTTPS_PROXY: 'http://p:8080' }).host, 'p:8080');
  assert.equal(proxyFor('https://api.github.com/x', { https_proxy: 'p:3128' }).host, 'p:3128', 'a scheme is optional');
  assert.equal(proxyFor('https://api.github.com/x', { HTTP_PROXY: 'http://q:1' }).host, 'q:1', 'HTTP_PROXY is the fallback');
  assert.equal(proxyFor('https://api.github.com/x', { HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'example.com, .github.com' }), null);
  assert.equal(proxyFor('https://api.github.com/x', { HTTPS_PROXY: 'http://p:8080', NO_PROXY: '*' }), null);
  assert.ok(proxyFor('https://api.github.com/x', { HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'hub.com' }));
  assert.equal(proxyFor('https://api.github.com/x', { HTTPS_PROXY: 'https://p:8080' }), null, 'an https proxy is not spoken to');
});

test('proxy_fetch_tunnels_through_connect_and_follows_redirects', async () => {
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: '/final' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, agent: req.headers['user-agent'] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    seen.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    const upstream = net.connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const env = { HTTPS_PROXY: `http://me:pw%40x@127.0.0.1:${proxy.address().port}` };
    const res = await proxyFetch(`https://localhost:${server.address().port}/redir`, { headers: { 'User-Agent': 'agentsdash' } }, { env, ca: TEST_CERT });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: '/final', agent: 'agentsdash' });
    assert.equal(seen[0].target, `localhost:${server.address().port}`);
    assert.equal(seen[0].auth, `Basic ${Buffer.from('me:pw@x').toString('base64')}`);
    assert.ok(seen.length >= 2, 'the redirect used a second tunnel');
  } finally { proxy.close(); server.close(); proxy.closeAllConnections?.(); server.closeAllConnections?.(); }
});

test('proxy_fetch_rejects_when_the_proxy_refuses', async () => {
  const proxy = http.createServer();
  proxy.on('connect', (req, client) => { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(proxyFetch('https://localhost:1/x', {}, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } }), /proxy answered 407/);
  } finally { proxy.close(); proxy.closeAllConnections?.(); }
});
