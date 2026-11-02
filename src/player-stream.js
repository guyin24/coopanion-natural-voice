import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_AUDIO_BYTES,
  validateWave,
  normalizeWaveLoudness,
  measureWaveGain,
} from "./audio.js";

const source = fileURLToPath(new URL("./native/PcmPlayer.cs", import.meta.url));
const script = `$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies 'System.Web.Extensions.dll' -TypeDefinition ([IO.File]::ReadAllText('${source.replaceAll("'", "''")}')); [NaturalVoicePcmPlayer]::Run()`;
const encoded = Buffer.from(script, "utf16le").toString("base64");
let worker = null,
  enabled = true,
  sequence = 0;
const queue = [];
const abortError = () => new DOMException("操作已取消。", "AbortError");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function rejectWrites(job, error) {
  for (const write of job.writes.values()) write.reject(error);
  job.writes.clear();
}
function releaseJob(job) {
  clearTimeout(job.timer);
  clearTimeout(job.stopTimer);
  job.signal?.removeEventListener("abort", job.abort);
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  pump();
}
function failWorker(state, error) {
  if (state.dead) return;
  state.dead = true;
  if (worker !== state) return;
  worker = null;
  for (const job of queue.splice(0)) {
    clearTimeout(job.timer);
    clearTimeout(job.stopTimer);
    job.signal?.removeEventListener("abort", job.abort);
    rejectWrites(job, error);
    job.result.reject(error);
  }
  try {
    state.child.stdin.end();
    state.child.kill();
  } catch {}
}
function send(state, command) {
  if (state.dead) throw new Error("Windows 音频播放进程已退出。");
  state.child.stdin.write(JSON.stringify(command) + "\n", (error) => {
    if (error) failWorker(state, new Error("Windows 音频管道写入失败。"));
  });
}
function setReference(state, active) {
  const method = active ? "ref" : "unref";
  state.child[method]?.();
  state.child.stdin[method]?.();
  state.child.stdout[method]?.();
  state.child.stderr?.[method]?.();
}
function createWorker() {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const state = { child, ready: false, dead: false, buffer: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data) => {
    state.stderr = (state.stderr + data).slice(-3000);
  });
  child.stdin.on?.("error", () =>
    failWorker(state, new Error("Windows 音频管道已关闭。")),
  );
  child.stdout.on("data", (data) => {
    state.buffer += data;
    let newline;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.ev === "ready") {
        state.ready = true;
        pump();
        continue;
      }
      const job = queue[0];
      if (!job || message.job !== job.id) continue;
      if (message.ev === "started") {
        try {
          job.options.onStart?.();
        } catch (error) {
          cancelJob(job, error);
        }
      } else if (message.ev === "queued") {
        job.writes.get(message.seq)?.resolve();
        job.writes.delete(message.seq);
      } else if (message.ev === "done") {
        job.result.resolve(message);
        releaseJob(job);
      } else if (message.ev === "stopped") releaseJob(job);
      else if (message.ev === "error") {
        const error = new Error("Windows 连续音频播放失败。");
        rejectWrites(job, error);
        job.result.reject(error);
        releaseJob(job);
      }
    }
  });
  child.once("error", () =>
    failWorker(state, new Error("无法启动 Windows 音频播放进程。")),
  );
  child.once("close", () =>
    failWorker(state, new Error("Windows 音频播放进程已退出。")),
  );
  setReference(state, false);
  return state;
}
function getWorker() {
  if (!enabled)
    throw new DOMException("播放器已停止，请先启用语音。", "AbortError");
  if (!worker || worker.dead) worker = createWorker();
  return worker;
}
function pump() {
  if (!queue.length) {
    if (worker) setReference(worker, false);
    return;
  }
  if (!enabled) return;
  let state;
  try {
    state = getWorker();
  } catch (error) {
    const job = queue[0];
    rejectWrites(job, error);
    job.result.reject(error);
    releaseJob(job);
    return;
  }
  setReference(state, true);
  const job = queue[0];
  if (!state.ready || job.cancelled || !job.format) return;
  try {
    if (!job.begun) {
      job.begun = true;
      send(state, { op: "begin", job: job.id, ...job.format });
    }
    for (const chunk of job.pending.splice(0))
      send(state, {
        op: "data",
        job: job.id,
        seq: chunk.seq,
        data: chunk.pcm.toString("base64"),
      });
    if (job.ended && !job.endSent) {
      job.endSent = true;
      send(state, { op: "end", job: job.id });
    }
  } catch (error) {
    failWorker(state, error);
  }
}
function cancelJob(job, reason = abortError()) {
  if (job.cancelled || !queue.includes(job)) return;
  job.cancelled = true;
  job.pending.length = 0;
  rejectWrites(job, reason);
  job.result.reject(reason);
  if (queue[0] === job && job.begun && worker?.ready && !worker.dead) {
    try {
      send(worker, { op: "stop", job: job.id });
    } catch (error) {
      failWorker(worker, error);
      return;
    }
    job.stopTimer = setTimeout(() => {
      if (worker && queue.includes(job))
        failWorker(worker, new Error("Windows 播放器未响应停止请求。"));
    }, 1500);
    job.stopTimer.unref?.();
  } else releaseJob(job);
}
function pcmOf(bytes) {
  const wav = validateWave(bytes);
  let format;
  const parts = [];
  for (let at = 12; at + 8 <= wav.length;) {
    const kind = wav.toString("ascii", at, at + 4),
      length = wav.readUInt32LE(at + 4);
    if (kind === "fmt ")
      format = {
        rate: wav.readUInt32LE(at + 12),
        channels: wav.readUInt16LE(at + 10),
        bits: wav.readUInt16LE(at + 22),
      };
    if (kind === "data") parts.push(wav.subarray(at + 8, at + 8 + length));
    at += 8 + length + (length % 2);
  }
  let pcm = Buffer.concat(parts);
  if (format.bits === 8) {
    const converted = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++)
      converted.writeInt16LE((pcm[i] - 128) * 256, i * 2);
    pcm = converted;
  }
  return { format: { rate: format.rate, channels: format.channels }, pcm };
}
export function warmPlayer() {
  enabled = true;
  if (process.platform === "win32") getWorker();
}
export function disposePlayer() {
  enabled = false;
  const error = abortError();
  for (const job of queue.splice(0)) {
    clearTimeout(job.timer);
    clearTimeout(job.stopTimer);
    job.signal?.removeEventListener("abort", job.abort);
    rejectWrites(job, error);
    job.result.reject(error);
  }
  if (worker) {
    const state = worker;
    worker = null;
    try {
      state.child.stdin.end(JSON.stringify({ op: "shutdown" }) + "\n");
    } catch {}
    const timer = setTimeout(() => {
      try {
        state.child.kill();
      } catch {}
    }, 1500);
    timer.unref?.();
  }
}
export function getPlayerDiagnostics() {
  return {
    pid: worker?.child.pid ?? null,
    ready: Boolean(worker?.ready),
    enabled,
    queued: queue.length,
    active: Boolean(queue[0]?.begun),
  };
}
export function createWaveStream(signal, options = {}) {
  if (process.platform !== "win32")
    throw new Error("此版本的音频播放仅支持 Windows。");
  signal?.throwIfAborted();
  if (!enabled)
    throw new DOMException("播放器已停止，请先启用语音。", "AbortError");
  const result = deferred();
  const job = {
    id: String(++sequence),
    signal,
    options,
    result,
    writes: new Map(),
    pending: [],
    format: null,
    gain: options.gain,
    totalBytes: 0,
    seq: 0,
    ended: false,
    begun: false,
    cancelled: false,
  };
  job.abort = () => cancelJob(job, signal.reason ?? abortError());
  signal?.addEventListener("abort", job.abort, { once: true });
  job.timer = setTimeout(
    () => cancelJob(job, new Error("音频播放超过 5 分钟，已停止。")),
    300000,
  );
  job.timer.unref?.();
  queue.push(job);
  return {
    write(bytes) {
      if (job.cancelled) return Promise.reject(signal?.reason ?? abortError());
      if (job.ended) return Promise.reject(new Error("音频流已经结束。"));
      try {
        job.gain ??= measureWaveGain(bytes, options);
        const { format, pcm } = pcmOf(
          normalizeWaveLoudness(bytes, { ...options, gain: job.gain }),
        );
        if (
          job.format &&
          (job.format.rate !== format.rate ||
            job.format.channels !== format.channels)
        )
          throw new Error("同一音频流的采样率和声道必须一致。");
        if (job.totalBytes + pcm.length > MAX_AUDIO_BYTES)
          throw new Error("TTS 音频超过 16 MB。");
        job.format = format;
        job.totalBytes += pcm.length;
        const ack = deferred(),
          seq = ++job.seq;
        job.writes.set(seq, ack);
        job.pending.push({ seq, pcm });
        pump();
        return ack.promise;
      } catch (error) {
        cancelJob(job, error);
        return Promise.reject(error);
      }
    },
    finish() {
      if (job.cancelled) return result.promise;
      job.ended = true;
      if (!job.format) {
        result.resolve({ bytes: 0, underflowCount: 0, underflowMs: 0 });
        releaseJob(job);
      } else pump();
      return result.promise;
    },
    cancel: (reason) => cancelJob(job, reason ?? abortError()),
    promise: result.promise,
  };
}
export async function playWave(bytes, signal, options = {}) {
  const stream = createWaveStream(signal, options),
    writing = stream.write(bytes);
  writing.catch(() => {});
  const done = stream.finish();
  try {
    await Promise.all([writing, done]);
  } catch (error) {
    stream.cancel(error);
    throw error;
  }
}
