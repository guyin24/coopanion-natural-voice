import { createServer } from 'node:http';
import { once } from 'node:events';

export function wave(milliseconds = 30) {
  const samples = Math.floor(16000 * milliseconds / 1000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}

export async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1/audio/speech`;
}

export async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}

export function storeWith(events = []) {
  let rows = [...events];
  return {
    latestCursor: () => rows.at(-1)?.cursor ?? 0,
    range: ({ fromCursor, toCursor }) => rows.filter(e => e.cursor >= fromCursor && e.cursor <= toCursor),
    add: event => { rows.push(event); },
    clear: () => { rows = []; },
  };
}

export function say(cursor, text) {
  return { cursor, type: 'desktop-pet.self', source: 'desktop-pet', senderKey: 'desktop-pet.self',
    ts: '2026-10-31T12:00:00+08:00', origin: 'external', contextDelivery: 'archive', text,
    meta: { kind: 'say', beats: [{ text }] } };
}

export async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
}
