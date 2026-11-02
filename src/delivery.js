import { cleanText, splitBeatSegments, normalizeSegmentKey } from "./text.js";

export const TONE_TOOL = {
  name: "voice_set_tone",
  tags: ["write"],
  description:
    "Set brief tones for the beats of the next pet_say, or the next pet_ask question, in order. Call before that speech tool in the same response. Send tones only; never repeat the speech text. This tool does not speak or display anything.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      tones: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 80,
        },
      },
    },
    required: ["tones"],
  },
};

export function supportsModelTone(cfg) {
  return (
    cfg.modelTone !== false &&
    cfg.autoRead !== false &&
    cfg.provider === "aliyun" &&
    /^qwen-audio-3\.[01]-tts-(plus|flash)$/.test(cfg.model ?? "")
  );
}

export function moodTone(mood) {
  const words = (
    typeof mood === "string"
      ? mood
      : Object.values(mood ?? {})
          .filter((value) => typeof value === "string")
          .join(" ")
  )
    .slice(0, 200)
    .toLowerCase();
  const moods = [
    [
      /happy|smile|grin|joy|cheer|开心|高兴|微笑|喜悦/,
      "开心、亲切，带一点笑意，不要夸张。",
    ],
    [
      /surpris|amaze|excite|wow|惊喜|惊讶|兴奋/,
      "惊喜、轻快，语调自然上扬，不要大喊。",
    ],
    [/sad|cry|upset|悲伤|伤心|难过|哭/, "低声、柔和，表达难过但不夸张哭腔。"],
    [
      /worr|concern|comfort|gentle|warm|担心|安慰|温柔|关切/,
      "轻声、耐心地安慰，语气温柔，停顿自然。",
    ],
    [/angry|annoy|怒|生气|不满/, "克制地表达不满，语气认真，不要大喊。"],
    [
      /think|confus|curious|疑惑|好奇|思考/,
      "带着好奇或思考的语气，问句自然上扬。",
    ],
    [/shy|blush|害羞|脸红/, "轻柔、略带害羞，保持自然。"],
    [/sleep|tired|困|疲惫|瞌睡/, "轻声、舒缓，稍显疲惫，保持清晰。"],
  ];
  return moods.find(([pattern]) => pattern.test(words))?.[1] ?? null;
}

export function deliveryInstruction(base, tone) {
  if (!tone) return base;
  const suffix = `本句的说话语气：${tone}`;
  const prefix = Array.from(base ?? "")
    .slice(0, Math.max(0, 500 - Array.from(suffix).length - 1))
    .join("");
  return prefix ? `${prefix}\n${suffix}` : suffix;
}

export class DeliveryPlans {
  constructor({ now = Date.now, ttlMs = 30000, maxPlans = 8 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxPlans = maxPlans;
    this.plans = [];
    this.invalid = new Map();
  }
  prune() {
    const time = this.now();
    this.plans = this.plans.filter((p) => time - p.at < this.ttlMs);
    for (const [id, at] of this.invalid)
      if (time - at >= this.ttlMs) this.invalid.delete(id);
  }
  register(args, id, confirmed = true) {
    this.prune();
    if (Array.isArray(args?.tones)) {
      if (
        !args.tones.length ||
        args.tones.length > 5 ||
        args.tones.some(
          (tone) =>
            typeof tone !== "string" ||
            !tone.trim() ||
            Array.from(tone).length > 80,
        )
      )
        throw new Error(
          "请按顺序提供 1～5 个不超过 80 字的语气，不要复述正文。",
        );
      const plan = this.register(
        {
          lines: args.tones.map((tone, i) => ({ text: `ordinal:${i}`, tone })),
        },
        id,
        confirmed,
      );
      if (!plan.ordinal) {
        plan.ordinal = true;
        for (const line of plan.lines) {
          line.text = null;
          line.key = null;
          line.segments = [];
          line.closed = false;
        }
      }
      return plan;
    }
    if (
      !Array.isArray(args?.lines) ||
      args.lines.length < 1 ||
      args.lines.length > 5
    )
      throw new Error("语气标注须包含 1～5 句正文和语气。");
    const lines = args.lines.map((line) => {
      if (
        typeof line?.text !== "string" ||
        typeof line?.tone !== "string" ||
        !line.text.trim() ||
        !line.tone.trim() ||
        Array.from(line.text).length > 1200 ||
        Array.from(line.tone).length > 200
      )
        throw new Error("每句正文须为 1～1200 字，语气须为 1～200 字。");
      const text = cleanText(line.text, 1200);
      if (!text) throw new Error("语气标注的正文不能为空。");
      return {
        text,
        key: normalizeSegmentKey(text),
        tone: line.tone.trim(),
        segments: splitBeatSegments(text).map(normalizeSegmentKey),
        used: false,
      };
    });
    const signature = JSON.stringify(
      lines.map(({ text, tone }) => ({ text, tone })),
    );
    if (id && this.invalid.has(id))
      throw new Error("该语气标注已取消，请为新回复重新标注。");
    const old = id ? this.plans.find((p) => p.id === id) : null;
    if (old) {
      if (old.signature !== signature)
        throw new Error("同一次语气标注的内容发生变化。");
      old.confirmed ||= confirmed;
      return old;
    }
    const plan = { id, signature, lines, confirmed, at: this.now() };
    this.plans.push(plan);
    while (this.plans.length > this.maxPlans) this.plans.shift();
    return plan;
  }
  peek(text, prefix = false) {
    return this.find(text, prefix)?.tone ?? null;
  }
  find(text, prefix = false) {
    this.prune();
    const exact = cleanText(text, 1200),
      key = normalizeSegmentKey(exact);
    if (!key) return null;
    for (const plan of this.plans.filter((plan) => plan.confirmed))
      for (const line of plan.lines)
        if (!line.used && line.text === exact) return line;
    for (const plan of this.plans.filter((plan) => plan.confirmed))
      for (const line of plan.lines)
        if (
          !line.used &&
          (line.key === key ||
            line.segments.some((segment) => segment === key) ||
            (prefix && line.text?.startsWith(key)))
        )
          return line;
    return null;
  }
  reserve(callId) {
    this.prune();
    const plan = this.plans.find(
      (plan) =>
        plan.ordinal && !plan.reserved && plan.lines.some((line) => !line.used),
    );
    if (plan) plan.reserved = callId ?? Symbol("speech");
    return plan ?? null;
  }
  bind(plan, beats) {
    if (!plan?.ordinal) return;
    for (const [i, line] of plan.lines.entries())
      if (beats[i]) {
        line.text = cleanText(beats[i].text, Number.MAX_SAFE_INTEGER);
        line.key = normalizeSegmentKey(line.text);
        line.segments = splitBeatSegments(line.text).map(normalizeSegmentKey);
        line.closed = beats[i].closed;
      }
  }
  bindUnreserved(beats) {
    const plan = this.plans.find(
      (plan) =>
        plan.ordinal &&
        plan.confirmed &&
        !plan.reserved &&
        plan.lines.some((line) => !line.used),
    );
    if (plan) {
      plan.reserved = true;
      this.bind(plan, beats);
    }
    return plan ?? null;
  }
  claim(text) {
    this.prune();
    const exact = cleanText(text, Number.MAX_SAFE_INTEGER);
    for (const plan of this.plans)
      if (plan.confirmed)
        for (const line of plan.lines)
          if (!line.used && line.text === exact) {
            line.used = true;
            return line.tone;
          }
    return null;
  }
  clear() {
    for (const plan of this.plans)
      if (plan.id) this.invalid.set(plan.id, this.now());
    this.plans = [];
    while (this.invalid.size > 64)
      this.invalid.delete(this.invalid.keys().next().value);
    this.prune();
  }
  get pending() {
    this.prune();
    return this.plans.reduce(
      (sum, p) => sum + p.lines.filter((line) => !line.used).length,
      0,
    );
  }
}
