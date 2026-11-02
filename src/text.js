export function cleanText(text, maxChars) {
  const clean = text
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > maxChars
    ? chars.slice(0, maxChars).join("") + "。后文省略。"
    : clean;
}

export function spokenText(event, maxChars) {
  if (event.source !== "desktop-pet" || event.type !== "desktop-pet.self")
    return "";
  const meta = event.meta;
  if (!meta || typeof meta !== "object") return "";
  let text;
  if (meta.kind === "say" && Array.isArray(meta.beats)) {
    text = meta.beats
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("");
  } else if (meta.kind === "ask" && typeof meta.question === "string")
    text = meta.question;
  else return "";
  return cleanText(text, maxChars);
}

const SENTENCE_END_RE = /[。！？!?；;\n]/;
const CLAUSE_END_RE = /[，,：:、—…~～]/;
const IMMEDIATE_CLAUSE_END_RE = /[，,：:、~～]/;

export function normalizeSegmentKey(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[。！？!?；;\n，,：:、—…~～\s]+$/g, "").trim();
}

/**
 * Prefix-deterministic first-segment splitter:
 * Splits at the first sentence end (>= 2 chars) or first clause punctuation (>= 4 chars)
 * whenever followed by non-whitespace text. Because the decision depends only on the prefix
 * up to the punctuation + 1 following char, streaming extraction and final spokenSegments
 * always produce the exact same first segment.
 */
function splitFirstSegment(trimmed) {
  let charCount = 0;
  let i = 0;
  while (i < trimmed.length) {
    const cp = trimmed.codePointAt(i);
    const chLen = cp > 0xffff ? 2 : 1;
    const ch = trimmed.slice(i, i + chLen);
    charCount++;
    i += chLen;
    const isSent = SENTENCE_END_RE.test(ch);
    const isClause = !isSent && CLAUSE_END_RE.test(ch);
    if ((isSent && charCount >= 2) || (isClause && charCount >= 4)) {
      while (
        i < trimmed.length &&
        (SENTENCE_END_RE.test(trimmed[i]) || CLAUSE_END_RE.test(trimmed[i]))
      ) {
        i++;
      }
      const rest = trimmed.slice(i).trim();
      if (rest.length > 0) {
        return [trimmed.slice(0, i).trim(), rest];
      }
      break;
    }
  }
  return [trimmed, ""];
}

export function splitBeatSegments(text, nextMax = 28, maxParts = 5) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const [first, remainder] = splitFirstSegment(trimmed);
  if (!remainder) return [first];

  const out = [first];
  const sentences = remainder.match(
    /[^。！？!?；;\n]+[。！？!?；;\n]*|.+$/g,
  ) ?? [remainder];
  let current = "";
  for (const raw of sentences) {
    const piece = raw.trim();
    if (!piece) continue;
    const combined = current ? `${current} ${piece}` : piece;
    if (
      current &&
      Array.from(combined).length > nextMax &&
      out.length < maxParts - 1
    ) {
      out.push(current);
      current = piece;
    } else {
      current = combined;
    }
  }
  if (current) out.push(current);
  return out;
}

export function spokenSegments(event, maxChars) {
  if (event?.source !== "desktop-pet" || event?.type !== "desktop-pet.self")
    return [];
  const meta = event.meta;
  if (!meta || typeof meta !== "object") return [];
  if (
    meta.kind === "say" &&
    Array.isArray(meta.beats) &&
    meta.beats.length > 0
  ) {
    let remaining = maxChars;
    const rawSegments = [];
    for (const beat of meta.beats) {
      if (typeof beat?.text !== "string" || remaining <= 0) continue;
      const cleaned = cleanText(beat.text, remaining);
      if (!cleaned) continue;
      remaining -= Array.from(cleaned).length;
      rawSegments.push(...splitBeatSegments(cleaned));
      if (cleaned.endsWith("。后文省略。")) break;
    }
    if (rawSegments.length <= 5) return rawSegments;
    return [...rawSegments.slice(0, 4), rawSegments.slice(4).join(" ")];
  }
  const full = spokenText(event, maxChars);
  if (!full) return [];
  return splitBeatSegments(full);
}

function readJsonStringField(rawArgs, fieldName) {
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"`, "g");
  const match = re.exec(rawArgs);
  if (!match) return null;
  let idx = match.index + match[0].length;
  let raw = "";
  let closed = false;
  while (idx < rawArgs.length) {
    const ch = rawArgs[idx];
    if (ch === '"') {
      closed = true;
      break;
    }
    if (ch === "\\") {
      if (idx + 1 >= rawArgs.length) break;
      const next = rawArgs[idx + 1];
      if (next === "u") {
        if (idx + 6 > rawArgs.length) break;
        raw += rawArgs.slice(idx, idx + 6);
        idx += 6;
        continue;
      }
      raw += rawArgs.slice(idx, idx + 2);
      idx += 2;
      continue;
    }
    raw += ch;
    idx++;
  }
  try {
    return { value: JSON.parse(`"${raw}"`), closed };
  } catch {
    return null;
  }
}

function parseStreamingScript(script, scriptClosed) {
  let src = script;
  if (!scriptClosed) {
    src = src.replace(/【[^】]*$/, "").replace(/[＜<][^＞>\n]{0,32}$/, "");
  }
  const beats = [];
  let curText = "";
  let hasAction = false;
  let actions = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "【") {
      const end = src.indexOf("】", i + 1);
      if (end < 0) {
        curText += src.slice(i);
        break;
      }
      if (curText.trim() || hasAction) {
        if (curText.trim())
          beats.push({ text: curText.trim(), closed: true, actions });
      }
      curText = "";
      hasAction = true;
      actions = src
        .slice(i + 1, end)
        .split(/[,，、\s]+/)
        .filter(Boolean);
      i = end + 1;
      continue;
    }
    if (ch === "<" || ch === "＜") {
      const close = ch === "<" ? ">" : "＞";
      const end = src.indexOf(close, i + 1);
      const inner = end < 0 ? "" : src.slice(i + 1, end);
      if (end < 0 || inner.length > 32 || /\n/.test(inner)) {
        curText += ch;
        i++;
        continue;
      }
      i = end + 1;
      continue;
    }
    curText += ch;
    i++;
  }
  if (curText.trim()) {
    beats.push({ text: curText.trim(), closed: scriptClosed, actions });
  }
  return beats;
}

export function streamBeatMetadata(toolName, rawArgs, isDone = false) {
  if (typeof rawArgs !== "string") return [];
  if (toolName === "pet_say") {
    const field = readJsonStringField(rawArgs, "script");
    if (field) return parseStreamingScript(field.value, field.closed || isDone);
    try {
      const beats = JSON.parse(rawArgs).beats;
      return Array.isArray(beats)
        ? beats
            .filter((beat) => typeof beat.text === "string")
            .map((beat) => ({ ...beat, closed: true }))
        : [];
    } catch {
      return [];
    }
  }
  if (toolName === "pet_ask") {
    const field = readJsonStringField(rawArgs, "question");
    return field
      ? [{ text: field.value, closed: field.closed || isDone, actions: [] }]
      : [];
  }
  return [];
}

function isPunctuationClosedFirstSegment(seg) {
  if (!seg) return false;
  const chars = Array.from(seg);
  const last = chars[chars.length - 1];
  if (SENTENCE_END_RE.test(last) && chars.length >= 2) return true;
  if (IMMEDIATE_CLAUSE_END_RE.test(last) && chars.length >= 4) return true;
  return false;
}

export function extractStreamSegments(
  toolName,
  rawArgs,
  isDone = false,
  maxChars = 1200,
) {
  if (typeof rawArgs !== "string" || !rawArgs) return [];
  const finalized = [];
  let remaining = maxChars;

  const pushBeat = (rawText, beatClosed) => {
    if (!rawText || remaining <= 0) return;
    const cleaned = cleanText(rawText, remaining);
    if (!cleaned) return;
    remaining -= Array.from(cleaned).length;
    const segs = splitBeatSegments(cleaned);
    if (beatClosed || isDone) {
      finalized.push(...segs);
    } else if (segs.length > 1) {
      finalized.push(...segs.slice(0, -1));
    } else if (
      segs.length === 1 &&
      finalized.length === 0 &&
      isPunctuationClosedFirstSegment(segs[0])
    ) {
      finalized.push(segs[0]);
    }
  };

  if (toolName === "pet_say") {
    const scriptField = readJsonStringField(rawArgs, "script");
    if (scriptField) {
      const beats = parseStreamingScript(
        scriptField.value,
        scriptField.closed || isDone,
      );
      for (const beat of beats) pushBeat(beat.text, beat.closed);
      return finalized.slice(0, 5);
    }
    const beatsMatch =
      /"beats"\s*:\s*\[\s*\{[^{}]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(
        rawArgs,
      );
    if (beatsMatch) {
      try {
        pushBeat(JSON.parse(`"${beatsMatch[1]}"`), true);
      } catch {}
    }
    return finalized.slice(0, 5);
  }

  if (toolName === "pet_ask") {
    const qField = readJsonStringField(rawArgs, "question");
    if (qField) {
      pushBeat(qField.value, qField.closed || isDone);
    }
    return finalized.slice(0, 5);
  }

  return [];
}

/**
 * Extracts the live streaming progress of the very first spoken segment (Segment 0)
 * so duplex WebSocket TTS can feed characters (`continue-task`) before the segment even closes.
 */
export function extractStreamFirstProgress(
  toolName,
  rawArgs,
  isDone = false,
  maxChars = 1200,
) {
  if (typeof rawArgs !== "string" || !rawArgs) return null;
  let firstBeat = null;
  if (toolName === "pet_say") {
    const scriptField = readJsonStringField(rawArgs, "script");
    if (scriptField) {
      const beats = parseStreamingScript(
        scriptField.value,
        scriptField.closed || isDone,
      );
      if (beats.length > 0) firstBeat = beats[0];
    }
  } else if (toolName === "pet_ask") {
    const qField = readJsonStringField(rawArgs, "question");
    if (qField && qField.value.trim()) {
      firstBeat = {
        text: qField.value.trim(),
        closed: qField.closed || isDone,
      };
    }
  }
  if (!firstBeat || !firstBeat.text) return null;
  const cleaned = cleanText(firstBeat.text, maxChars);
  if (!cleaned) return null;
  const segs = splitBeatSegments(cleaned);
  if (!segs.length) return null;
  const seg0 = segs[0];
  const closed = Boolean(
    firstBeat.closed ||
    isDone ||
    segs.length > 1 ||
    isPunctuationClosedFirstSegment(seg0),
  );
  return { text: seg0, closed };
}

export function extractStreamPreview(toolName, rawArgs, maxChars = 1200) {
  return extractStreamSegments(toolName, rawArgs, false, maxChars)[0] ?? "";
}
