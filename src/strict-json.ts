/**
 * Parses authenticated JSON without the duplicate-key ambiguity of
 * `JSON.parse`. Object keys are compared after JSON escape decoding, so
 * `"traceHash"` and `"trace\u0048ash"` are duplicates.
 */
export function parseStrictJson(
  source: string,
  label = "authenticated JSON",
): unknown {
  let cursor = 0;
  let depth = 0;

  const fail = (reason: string): never => {
    throw new Error(`${label} is invalid: ${reason} at byte ${cursor}`);
  };
  const whitespace = () => {
    while (
      source[cursor] === " " ||
      source[cursor] === "\n" ||
      source[cursor] === "\r" ||
      source[cursor] === "\t"
    ) {
      cursor += 1;
    }
  };
  const stringValue = (): string => {
    if (source[cursor] !== '"') fail("expected string");
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(source.slice(start, cursor)) as string;
        } catch {
          fail("malformed string");
        }
      }
      if (character === "\\") {
        cursor += 1;
        if (cursor >= source.length) fail("unterminated escape");
        if (source[cursor] === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(source.slice(cursor + 1, cursor + 5))) {
            fail("malformed unicode escape");
          }
          cursor += 5;
        } else {
          if (!/["\\/bfnrt]/.test(source[cursor]!)) {
            fail("malformed escape");
          }
          cursor += 1;
        }
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        fail("unescaped control character");
      }
      cursor += 1;
    }
    return fail("unterminated string");
  };
  const value = (): unknown => {
    whitespace();
    depth += 1;
    if (depth > 256) fail("maximum nesting depth exceeded");
    try {
      if (source[cursor] === "{") {
        cursor += 1;
        whitespace();
        const result: Record<string, unknown> = Object.create(null);
        const keys = new Set<string>();
        if (source[cursor] === "}") {
          cursor += 1;
          return result;
        }
        while (cursor < source.length) {
          whitespace();
          const key = stringValue();
          if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
          keys.add(key);
          whitespace();
          if (source[cursor] !== ":") fail("expected colon");
          cursor += 1;
          result[key] = value();
          whitespace();
          if (source[cursor] === "}") {
            cursor += 1;
            return result;
          }
          if (source[cursor] !== ",") fail("expected comma");
          cursor += 1;
        }
        return fail("unterminated object");
      }
      if (source[cursor] === "[") {
        cursor += 1;
        whitespace();
        const result: unknown[] = [];
        if (source[cursor] === "]") {
          cursor += 1;
          return result;
        }
        while (cursor < source.length) {
          result.push(value());
          whitespace();
          if (source[cursor] === "]") {
            cursor += 1;
            return result;
          }
          if (source[cursor] !== ",") fail("expected comma");
          cursor += 1;
        }
        return fail("unterminated array");
      }
      if (source[cursor] === '"') return stringValue();
      const remainder = source.slice(cursor);
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        remainder,
      )?.[0];
      if (number !== undefined) {
        cursor += number.length;
        const parsed = Number(number);
        if (!Number.isFinite(parsed)) fail("non-finite number");
        return parsed;
      }
      for (const [literal, parsed] of [
        ["true", true],
        ["false", false],
        ["null", null],
      ] as const) {
        if (source.startsWith(literal, cursor)) {
          cursor += literal.length;
          return parsed;
        }
      }
      return fail("unexpected token");
    } finally {
      depth -= 1;
    }
  };

  const parsed = value();
  whitespace();
  if (cursor !== source.length) fail("trailing content");
  return parsed;
}
