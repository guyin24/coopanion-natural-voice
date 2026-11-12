import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = resolve(process.argv[2] ?? join(root, '..', 'Coopanion', 'vendor', 'cortico'));
const packageDir = resolve(process.argv[3] ?? root);
const contractOnly = process.argv[4] === '--contract-only';
const load = path => import(pathToFileURL(join(upstream, path)).href);
const { parseExtensionManifest } = await load('src/extensions/manifest.ts');
const { dryMountWorld } = await load('src/extensions/dry-mount.ts');
const { checkDescribe } = await load('src/extensions/describe-export.ts');
const { WorldAssembly } = await load('src/world.ts');
const { JsonlEventStore } = await load('src/core/event-store.ts');
const { nullLogger } = await load('src/core/util.ts');
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const { default: definition } = await import(pathToFileURL(join(packageDir, pkg.main)).href);
const parsed = parseExtensionManifest(pkg, 'en');
assert.equal(parsed.ok, true, JSON.stringify(parsed));
assert.deepEqual(parsed.warnings, []);
const scratchDir = await mkdtemp(join(tmpdir(), 'natural-voice-host-check-'));
let world, server;
try {
  const report = await dryMountWorld(definition, { scratchDir, packageDir, hasWebUiClient: true });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.warnings, []);
  const described = await checkDescribe('world', definition, pkg.cortico.describe, { scratchDir, packageDir });
  assert.deepEqual(described.failures, []);
  assert.deepEqual(described.warnings, []);
  console.log('Official describe.json check including environment prompt contents passed.');
  console.log('Upstream manifest parser and dryMountWorld:', report.ok.join(' '));
  if (!contractOnly) {
    const dataDir = join(scratchDir, 'data');
    await mkdir(dataDir, { recursive: true });
    const store = new JsonlEventStore({ dataDir, run: 'host-check', timezone: 'Asia/Shanghai' });
    const event = text => ({ type: 'desktop-pet.self', source: 'desktop-pet', senderKey: 'desktop-pet.self',
      ts: '2026-10-31T12:00:00+08:00', origin: 'external', contextDelivery: 'archive', text,
      meta: { kind: 'say', beats: [{ text }] } });
    store.append(event('历史消息，不应朗读。'));
    const audio = Buffer.alloc(1004);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
    const requests = [];
    server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(audio);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const config = { displayName: 'Extension test', timezone: 'Asia/Shanghai', worlds: {
      'natural-voice': { ...definition.defaults(), enabled: true, endpoint: `http://127.0.0.1:${server.address().port}/v1/audio/speech` },
    } };
    const loaded = { config, rootDir: scratchDir, dataDir, memoryDir: join(scratchDir, 'memory'), packageDir, secret: () => 'host-test-key' };
    const assembly = new WorldAssembly(loaded, [definition], []);
    world = assembly.slots[0].instance;
    const originalEmit = Server.prototype.emit;
    await world.start({ store, log: nullLogger });
    assert.equal(Server.prototype.emit === originalEmit, pkg.private !== true);
    store.append(event('真实事件库中的新回复。'));
    const deadline = Date.now() + 15000;
    while (!(requests.length && !world.state().busy) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(world.state().error, '');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, '真实事件库中的新回复。');
    assert.equal(world.state().busy, false);
    await world.stop();
    world = null;
    assert.equal(Server.prototype.emit, originalEmit);
    console.log('Upstream WorldAssembly → JsonlEventStore → loopback TTS → native Windows WAV playback passed.');
  }
} finally {
  await world?.stop();
  if (server) { server.closeAllConnections(); server.close(); }
  await rm(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
