import test from "node:test";
import assert from "node:assert/strict";
import * as player from "../src/player.js";
import { wave, until } from "./helpers.js";

test("player provides one persistent interruptible WAV stream rather than one file playback per packet", () => {
  assert.equal(typeof player.createWaveStream, "function");
  assert.equal(typeof player.getPlayerDiagnostics, "function");
});
test(
  "native continuous playback keeps one process across streaming, cancellation and recovery",
  {
    skip: process.platform !== "win32"
      ? "Windows audio device required"
      : process.env.NATURAL_VOICE_SKIP_NATIVE_AUDIO === "1"
        ? "Real audio-device test explicitly disabled; protocol tests still run"
        : false,
    timeout: 20000,
  },
  async (t) => {
    player.warmPlayer();
    t.after(() => player.disposePlayer());
    await player.playWave(wave(30));
    const pid = player.getPlayerDiagnostics().pid;
    let started = false;
    const controller = new AbortController(),
      stream = player.createWaveStream(controller.signal, {
        onStart: () => {
          started = true;
        },
      });
    await stream.write(wave(1000));
    const playing = stream.finish();
    await until(() => started);
    controller.abort(new DOMException("fixture stop", "AbortError"));
    await assert.rejects(playing, /fixture stop/);
    await player.playWave(wave(30));
    assert.equal(player.getPlayerDiagnostics().pid, pid);
    const next = player.createWaveStream();
    for (let i = 0; i < 4; i++) {
      await next.write(wave(120));
      await new Promise((r) => setTimeout(r, 30));
    }
    const stats = await next.finish();
    assert.equal(stats.bytes, 16000 * 2 * 0.48);
    assert.equal(stats.underflowCount, 0);
    player.disposePlayer();
    assert.throws(() => player.createWaveStream(), /已停止/);
  },
);
