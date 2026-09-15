import { ClawpatchError } from "./errors.js";

// Opening tag of an inline reasoning block (`<think>…</think>` and friends)
// that a reasoning model puts at the very start of `content` when the server
// has no reasoning parser configured.
const LEADING_REASONING_OPEN = /^\s*<(think|thinking|reasoning)>/iu;

export function extractJson(text: string): unknown | null {
  // A reply that is valid JSON as a whole is the answer, whatever its strings
  // quote — a finding can mention `</think>` followed by a `{}` literal.
  try {
    return JSON.parse(text);
  } catch {}
  // A leading reasoning block can hold unbalanced braces (`if (x) {`) or a
  // draft object, so try the answer that follows it before scanning the rest.
  const afterReasoning = textAfterLeadingReasoningBlock(text);
  if (afterReasoning !== null) {
    const parsed = extractJsonCandidate(afterReasoning);
    if (parsed !== null) {
      return parsed;
    }
  }
  return extractJsonCandidate(text);
}

// Only a block that *starts* the text is treated as reasoning, and it ends at
// its first matching close tag: a `</think>` anywhere else is answer content.
function textAfterLeadingReasoningBlock(text: string): string | null {
  const open = LEADING_REASONING_OPEN.exec(text);
  const tag = open?.[1];
  if (open === null || tag === undefined) {
    return null;
  }
  const close = new RegExp(`</${tag}\\s*>`, "giu");
  close.lastIndex = open[0].length;
  const match = close.exec(text);
  return match === null ? null : text.slice(match.index + match[0].length);
}

function extractJsonCandidate(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {}
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenceMatch && fenceMatch[1]) {
    const candidate = fenceMatch[1].trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  let firstBrace = text.indexOf("{");
  while (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            const candidate = text.slice(firstBrace, i + 1);
            try {
              return JSON.parse(candidate);
            } catch {
              firstBrace = text.indexOf("{", i + 1);
              break;
            }
          }
        }
      }
    }
    if (depth !== 0) {
      firstBrace = -1;
    }
  }
  return null;
}

export function parseCodexJson(raw: string): unknown {
  const parsed = extractJson(raw.trim());
  if (parsed !== null) {
    return parsed;
  }
  const preview = safeProviderPreview(raw);
  throw new ClawpatchError(
    `codex provider produced unparseable JSON output (preview: ${preview})`,
    8,
    "malformed-output",
  );
}

export function safeProviderPreview(value: string, maxLength = 200): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}
