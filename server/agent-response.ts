import { z } from 'zod';

export class AgentResponseError extends Error {
  constructor(
    message = 'The agent finished without a complete structured response. Saved responses are kept for recovery.',
  ) {
    super(message);
    this.name = 'AgentResponseError';
  }
}

// OpenCode text events are snapshots of a part, not deltas. A later assistant
// message can replace an interrupted draft after compaction or a tool step.
export class OpenCodeResponses {
  private parts = new Map<string, { message: string; text: string }>();

  add(event: any) {
    if (event.type !== 'text' || event.part?.type !== 'text' || typeof event.part.text !== 'string')
      return;
    const part = event.part;
    const key = part.id ? `${part.messageID || ''}/${part.id}` : `anonymous-${this.parts.size}`;
    this.parts.delete(key);
    this.parts.set(key, { message: part.messageID || key, text: part.text });
  }

  texts(): string[] {
    const messages = new Map<string, string[]>();
    for (const part of this.parts.values()) {
      const texts = messages.get(part.message) || [];
      texts.push(part.text);
      messages.set(part.message, texts);
    }
    // Keep individual complete parts preferred over a joined-message fallback.
    // Never join text from different assistant messages.
    return [...messages.values()].flatMap((parts) =>
      parts.length > 1 ? [parts.join(''), ...parts] : parts,
    );
  }
}

function candidates(text: string): string[] {
  const values: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char !== '{' && char !== '[') continue;
      start = i;
      depth = 1;
      quoted = false;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) {
      values.push(text.slice(start, i + 1));
      start = -1;
    }
  }
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  return [...new Set([text.trim(), ...fenced.reverse(), ...values.reverse()])];
}

export function parseAgentResponse(
  texts: string[],
  schema: z.ZodType,
  normalize?: (value: any) => unknown,
): any {
  let hasJSON = false;
  for (const text of [...texts].reverse()) {
    for (const candidate of candidates(text)) {
      let value: unknown;
      try {
        value = JSON.parse(candidate);
      } catch {
        continue;
      }
      hasJSON = true;
      try {
        return schema.parse(normalize ? normalize(value) : value);
      } catch {
        // A draft or unrelated JSON fragment must not hide a later valid result.
      }
    }
  }
  throw new AgentResponseError(
    hasJSON
      ? 'The agent returned JSON without the requested content. Saved responses are kept for recovery.'
      : undefined,
  );
}
