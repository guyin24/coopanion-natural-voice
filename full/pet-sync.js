import http from "node:http";
import { normalizeSegmentKey, spokenSegments } from "../src/text.js";

const HOOK_SYM = Symbol.for("cortico.naturalVoice.petSyncHooked");
const WRAPPED_WS_SYM = Symbol.for("cortico.naturalVoice.wsWrapped");
const DEFAULT_GATE_TIMEOUT_MS = 1800;

let activeGateCheck = null;
let origServerEmit = null;
let patchedEmitRef = null;
const pendingQueue = [];
const knownPetPorts = new Set();
const verifiedSockets = new WeakSet();
let verifiedCount = 0,
  selfCheckTimer = null;
let syncMode = "waiting",
  syncReason = "尚未验证桌宠连接，文字直接显示。",
  lastVerifiedAt = null;

export function getBubbleSyncDiagnostics() {
  return {
    mode: syncMode,
    reason: syncReason,
    verifiedSockets: verifiedCount,
    lastVerifiedAt,
  };
}

function markVerified(ws) {
  if (verifiedSockets.has(ws)) return;
  verifiedSockets.add(ws);
  verifiedCount++;
  lastVerifiedAt = Date.now();
  syncMode = "active";
  syncReason = "已验证桌宠连接。";
  ws.once?.("close", () => {
    verifiedCount = Math.max(0, verifiedCount - 1);
    if (!verifiedCount) {
      syncMode = "degraded";
      syncReason = "桌宠连接已断开，文字直接显示。";
    }
  });
}

function releaseBubbleGroup(group) {
  const index = pendingQueue.indexOf(group);
  if (index === -1) return;
  pendingQueue.splice(index, 1);
  clearTimeout(group.timer);
  group.timer = null;
  for (const send of group.sends.splice(0)) {
    try {
      send();
    } catch {}
  }
}

export function claimPendingBubble(openingText) {
  const key = normalizeSegmentKey(openingText);
  const group = pendingQueue.find(
    (item) => !item.claimed && item.openingKey === key,
  );
  if (group) group.claimed = true;
  return group ?? null;
}

export function flushPendingBubbles(openingText, claimedGroup = undefined) {
  if (openingText !== undefined) {
    const key = normalizeSegmentKey(openingText);
    const group =
      claimedGroup === undefined
        ? pendingQueue.find((item) => item.openingKey === key)
        : claimedGroup;
    if (group?.openingKey === key) releaseBubbleGroup(group);
    return;
  }
  while (pendingQueue.length > 0) releaseBubbleGroup(pendingQueue[0]);
}

function spokenPetMessage(data, maxChars) {
  if (typeof data !== "string" || !data.startsWith('{"t":')) return null;
  if (!data.startsWith('{"t":"say",') && !data.startsWith('{"t":"ask",'))
    return null;
  try {
    const msg = JSON.parse(data);
    const opening = spokenSegments(
      {
        source: "desktop-pet",
        type: "desktop-pet.self",
        meta: {
          kind: msg.t,
          beats: msg.beats,
          question: msg.question,
        },
      },
      maxChars,
    )[0];
    if (opening)
      return {
        id: typeof msg.id === "string" ? `${msg.t}:${msg.id}` : null,
        openingKey: normalizeSegmentKey(opening),
      };
  } catch {}
  return null;
}

function enqueueBubbleSend(message, send, timeoutMs) {
  // The same pet frame can be broadcast to multiple wrapped sockets. One
  // readiness notification releases those copies, but not a later reply with
  // identical wording and a different wire id.
  let group = message.id
    ? pendingQueue.find((item) => item.id === message.id)
    : null;
  if (!group) {
    group = { ...message, sends: [], timer: null };
    group.timer = setTimeout(() => releaseBubbleGroup(group), timeoutMs);
    group.timer.unref?.();
    pendingQueue.push(group);
  }
  group.sends.push(send);
  return group;
}

export function wrapPetWebSocket(ws) {
  if (!ws || typeof ws.send !== "function" || ws[WRAPPED_WS_SYM]) return ws;
  const origSend = ws.send;
  let pendingGroup = null;
  ws[WRAPPED_WS_SYM] = true;
  ws.send = function patchedPetSend(data, ...rest) {
    const gate = activeGateCheck?.();
    if (gate?.enabled) {
      const message = spokenPetMessage(data, gate.maxChars ?? 1200);
      if (message) {
        pendingGroup = enqueueBubbleSend(
          message,
          () => origSend.call(this, data, ...rest),
          gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
        );
        return;
      }
      if (
        pendingQueue.includes(pendingGroup) &&
        typeof data === "string" &&
        data.startsWith('{"t":"status",')
      ) {
        pendingGroup.sends.push(() => origSend.call(this, data, ...rest));
        return;
      }
    }
    return origSend.call(this, data, ...rest);
  };
  return ws;
}

function inspectSocketForWs(socket, verified = false) {
  if (!socket || typeof socket !== "object") return;
  if (!verified && !knownPetPorts.has(socket.localPort)) return;
  try {
    const symbols = Object.getOwnPropertySymbols(socket);
    for (const sym of symbols) {
      if (sym.description === "websocket") {
        const ws = socket[sym];
        if (ws && typeof ws.send === "function") {
          wrapPetWebSocket(ws);
          markVerified(ws);
        }
      }
    }
  } catch {}
}

export function scanActivePetSockets() {
  // Existing verified wrappers survive a World restart. Unknown existing
  // sockets are deliberately left alone; verify only a fresh pet upgrade.
  return getBubbleSyncDiagnostics();
}

function installHttpUpgradeHook() {
  if (http.Server.prototype[HOOK_SYM]) return;
  const previousEmit = http.Server.prototype.emit;
  origServerEmit = previousEmit;
  Object.defineProperty(http.Server.prototype, HOOK_SYM, {
    value: true,
    configurable: true,
  });
  patchedEmitRef = function patchedServerEmit(
    event,
    req,
    socket,
    head,
    ...rest
  ) {
    const result = previousEmit.call(this, event, req, socket, head, ...rest);
    if (
      activeGateCheck &&
      event === "upgrade" &&
      socket &&
      typeof req?.url === "string"
    ) {
      try {
        const url = new URL(req.url, "http://localhost");
        const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          socket.remoteAddress,
        );
        if (
          url.pathname === "/socket" &&
          url.searchParams.get("role") === "pet" &&
          loopback
        ) {
          if (socket.localPort) knownPetPorts.add(socket.localPort);
          inspectSocketForWs(socket, true);
          queueMicrotask(() => inspectSocketForWs(socket, true));
        }
      } catch {}
    }
    return result;
  };
  http.Server.prototype.emit = patchedEmitRef;
}

function uninstallHttpUpgradeHook() {
  if (!http.Server.prototype[HOOK_SYM]) return;
  if (origServerEmit && http.Server.prototype.emit === patchedEmitRef) {
    http.Server.prototype.emit = origServerEmit;
  }
  delete http.Server.prototype[HOOK_SYM];
  origServerEmit = null;
  patchedEmitRef = null;
}

export function setBubbleSyncGate(checkFn) {
  clearTimeout(selfCheckTimer);
  selfCheckTimer = null;
  activeGateCheck = checkFn;
  if (checkFn) {
    try {
      installHttpUpgradeHook();
      scanActivePetSockets();
      selfCheckTimer = setTimeout(() => {
        if (!verifiedCount) {
          syncMode = "degraded";
          syncReason = "未观察到可验证的桌宠连接，文字直接显示。";
        }
      }, 5000);
      selfCheckTimer.unref?.();
    } catch {
      activeGateCheck = null;
      syncMode = "degraded";
      syncReason = "宿主同步接口不可用，文字直接显示。";
      flushPendingBubbles();
    }
  } else {
    flushPendingBubbles();
    uninstallHttpUpgradeHook();
  }
  return getBubbleSyncDiagnostics();
}
