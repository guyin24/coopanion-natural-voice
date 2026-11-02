import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import {
  playWave,
  createWaveStream,
  warmPlayer,
  disposePlayer,
  getPlayerDiagnostics,
} from "../src/player.js";
import { wave, until } from "./helpers.js";

function fakeWorker(t) {
  disposePlayer();
  const commands = [],
    children = [];
  t.mock.method(cp, "spawn", () => {
    const child = new EventEmitter();
    child.pid = 9000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.ref =
      child.unref =
      child.stdout.setEncoding =
      child.stderr.setEncoding =
        () => {};
    const emit = (value) =>
      child.stdout.emit("data", JSON.stringify(value) + "\n");
    child.stdin.write = (line, callback) => {
      const command = JSON.parse(line);
      commands.push(command);
      callback?.();
      if (command.op === "data")
        queueMicrotask(() =>
          emit({ ev: "queued", job: command.job, seq: command.seq }),
        );
      return true;
    };
    child.stdin.end = () => queueMicrotask(() => child.emit("close", 0));
    child.kill = () => child.emit("close", 0);
    children.push(child);
    queueMicrotask(() => emit({ ev: "ready", pid: child.pid }));
    return child;
  });
  syncBuiltinESMExports();
  warmPlayer();
  t.after(() => {
    disposePlayer();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    commands,
    children,
    emit: (value) =>
      children.at(-1).stdout.emit("data", JSON.stringify(value) + "\n"),
  };
}
const begin = (fixture) => fixture.commands.filter((c) => c.op === "begin");

test(
  "native readiness is separate from accepting PCM and drain completion",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t);
    let starts = 0,
      finished = false;
    const p = playWave(wave(30), undefined, {
      onStart: () => {
        starts++;
      },
    }).then(() => {
      finished = true;
    });
    await until(() => begin(f).length === 1);
    const id = begin(f)[0].job;
    assert.equal(starts, 0);
    f.emit({ ev: "started", job: id });
    assert.equal(starts, 1);
    assert.equal(finished, false);
    f.emit({ ev: "done", job: id });
    await p;
    assert.equal(finished, true);
  },
);
test(
  "FIFO reserves complete streams and a later stream cannot overtake an unfinished one",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t);
    const a = createWaveStream(),
      b = createWaveStream();
    const writes = [a.write(wave(30)), b.write(wave(30))];
    const jobs = [a.finish(), b.finish()];
    await until(() => begin(f).length === 1);
    assert.equal(f.commands.filter((c) => c.op === "data").length, 1);
    f.emit({ ev: "done", job: begin(f)[0].job });
    await until(() => begin(f).length === 2);
    f.emit({ ev: "done", job: begin(f)[1].job });
    await Promise.all([...writes, ...jobs]);
    assert.equal(f.children.length, 1);
  },
);
test(
  "cancel sends stop, waits its acknowledgement and reuses the same worker for recovery",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t),
      controller = new AbortController();
    const a = createWaveStream(controller.signal);
    await a.write(wave(1000));
    const first = a.finish();
    controller.abort(new DOMException("fixture interruption", "AbortError"));
    await assert.rejects(first, /fixture interruption/);
    const next = playWave(wave(30));
    assert.equal(
      begin(f).length,
      1,
      "next stream waits until reset is acknowledged",
    );
    f.emit({ ev: "stopped", job: begin(f)[0].job });
    await until(() => begin(f).length === 2);
    f.emit({ ev: "done", job: begin(f)[1].job });
    await next;
    assert.equal(f.children.length, 1);
  },
);
test(
  "a canceled queued middle stream is never submitted and later streams retain order",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t),
      controller = new AbortController();
    const first = playWave(wave(30)),
      middle = playWave(wave(30), controller.signal).catch((e) => e),
      last = playWave(wave(30));
    await until(() => begin(f).length === 1);
    controller.abort();
    assert.equal((await middle).name, "AbortError");
    f.emit({ ev: "done", job: begin(f)[0].job });
    await until(() => begin(f).length === 2);
    f.emit({ ev: "done", job: begin(f)[1].job });
    await Promise.all([first, last]);
    assert.equal(begin(f).length, 2);
  },
);
test(
  "format errors settle the stream and release the next job without corrupting native state",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t),
      bad = createWaveStream();
    await assert.rejects(bad.write(Buffer.from("bad")), /WAV/);
    await assert.rejects(bad.promise, /WAV/);
    const next = playWave(wave(30));
    await until(() => begin(f).length === 1);
    f.emit({ ev: "done", job: begin(f)[0].job });
    await next;
  },
);
test(
  "disposal rejects pending work and stale calls cannot respawn a worker until warmPlayer",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t);
    const pending = playWave(wave(30));
    await until(() => begin(f).length === 1);
    disposePlayer();
    await assert.rejects(pending, { name: "AbortError" });
    assert.throws(() => createWaveStream(), /已停止/);
    assert.equal(getPlayerDiagnostics().pid, null);
    assert.equal(f.children.length, 1);
    warmPlayer();
    const next = playWave(wave(30));
    await until(() => begin(f).length === 2);
    f.emit({ ev: "done", job: begin(f)[1].job });
    await next;
    assert.equal(f.children.length, 2);
  },
);
test(
  "onStart callback failure cancels its own job instead of escaping the stdout event handler",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fakeWorker(t),
      failure = new Error("fixture callback");
    const playing = playWave(wave(30), undefined, {
      onStart() {
        throw failure;
      },
    });
    await until(() => begin(f).length === 1);
    assert.doesNotThrow(() => f.emit({ ev: "started", job: begin(f)[0].job }));
    await assert.rejects(playing, (error) => error === failure);
    f.emit({ ev: "stopped", job: begin(f)[0].job });
  },
);
