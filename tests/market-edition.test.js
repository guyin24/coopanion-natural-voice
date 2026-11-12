import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { NaturalVoiceWorld } from '../src/world.js';
import definition from '../src/index.js';
import { say, until } from './helpers.js';

test('market voice reads new replies through the public store without changing HTTP dispatch', async () => {
  const emit = Server.prototype.emit;
  const rows = [say(1, '历史回复')];
  const played = [];
  const world = new NaturalVoiceWorld({ cfg: definition.defaults(), secret: () => 'fixture-key' }, {
    pollMs: 10,
    synthesize: async (cfg, credentials, text) => Buffer.from(text),
    play: async bytes => { played.push(bytes.toString()); },
  });
  const store = {
    latestCursor: () => rows.at(-1).cursor,
    range: ({ fromCursor, toCursor }) => rows.filter(row => row.cursor >= fromCursor && row.cursor <= toCursor),
    get onAppend() { assert.fail('onAppend is outside the World API store contract'); },
  };
  try {
    await world.start({ store, log: { warn() {} } });
    assert.equal(Server.prototype.emit, emit);
    rows.push(say(2, '新回复'));
    await until(() => played.length === 1);
    assert.deepEqual(played, ['新回复']);
  } finally {
    await world.stop();
  }
  assert.equal(Server.prototype.emit, emit);
});
