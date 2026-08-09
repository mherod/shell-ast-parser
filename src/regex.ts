import type { GlobBracketMember, Range, RegexNode, WordPart } from "./ast.ts";

/**
 * Parser for the POSIX extended regular expressions that follow `=~`.
 *
 * Two shell rules shape this, and neither is visible from the regex text
 * alone. A quoted run matches literally — `[[ $s =~ "a.b" ]]` looks for the
 * three characters `a.b` — and an expansion supplies its pattern at runtime,
 * so it can only be recorded, not parsed.
 */
export interface RegexContext {
  /** Resolve a `$…` expansion; the pattern it holds is not known statically */
  readExpansion: (text: string, pos: number) => { part: WordPart; next: number } | null;
  /** Read a `[…]` bracket expression, which is the same syntax globs use */
  readBracket: (text: string, pos: number) => { negated: boolean; members: GlobBracketMember[]; next: number } | null;
}

class RegexSyntaxError extends Error {}

class RegexParser {
  private pos = 0;

  constructor(private text: string, private offset: number, private ctx: RegexContext) {}

  private range(from: number, to: number): Range {
    return { start: this.offset + from, end: this.offset + to };
  }

  parse(): RegexNode {
    const node = this.parseAlternation();
    if (this.pos < this.text.length) {
      throw new RegexSyntaxError(`Unexpected "${this.text[this.pos]}" at ${this.pos}`);
    }
    return node;
  }

  private parseAlternation(): RegexNode {
    const start = this.pos;
    const alternatives = [this.parseSequence()];

    while (this.text[this.pos] === "|") {
      this.pos++;
      alternatives.push(this.parseSequence());
    }

    if (alternatives.length === 1) return alternatives[0]!;
    return { type: "RegexAlternation", alternatives, range: this.range(start, this.pos) };
  }

  private parseSequence(): RegexNode {
    const start = this.pos;
    const items: RegexNode[] = [];

    while (this.pos < this.text.length && this.text[this.pos] !== "|" && this.text[this.pos] !== ")") {
      items.push(this.parseQuantified());
    }

    if (items.length === 1) return items[0]!;
    return { type: "RegexSequence", items, range: this.range(start, this.pos) };
  }

  private parseQuantified(): RegexNode {
    const start = this.pos;
    let node = this.parseAtom();

    for (;;) {
      const bounds = this.readQuantifier();
      if (bounds === null) break;
      node = {
        type: "RegexQuantifier",
        operand: node,
        min: bounds.min,
        max: bounds.max,
        range: this.range(start, this.pos),
      };
    }

    return node;
  }

  /** `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` — a `{` that fits none of these is a literal */
  private readQuantifier(): { min: number; max: number | null } | null {
    const ch = this.text[this.pos];

    if (ch === "*") { this.pos++; return { min: 0, max: null }; }
    if (ch === "+") { this.pos++; return { min: 1, max: null }; }
    if (ch === "?") { this.pos++; return { min: 0, max: 1 }; }
    if (ch !== "{") return null;

    const close = this.text.indexOf("}", this.pos);
    if (close === -1) return null;

    const spec = this.text.slice(this.pos + 1, close);
    const match = spec.match(/^(\d+)(,(\d*))?$/);
    if (!match) return null;

    this.pos = close + 1;
    const min = parseInt(match[1]!, 10);
    if (match[2] === undefined) return { min, max: min };
    return { min, max: match[3] === "" ? null : parseInt(match[3]!, 10) };
  }

  /**
   * Give a backslash escape its meaning.
   *
   * Only one case is portable: a backslash before a metacharacter, which POSIX
   * defines as that literal character. Everything else recognised here is a GNU
   * extension that BSD and macOS libc do not implement, so it keeps a node type
   * of its own rather than being folded into a literal. Anything left over is
   * undefined by POSIX and stays a bare `RegexEscape`.
   */
  private escapeNode(escaped: string, start: number): RegexNode {
    const range = this.range(start, this.pos);

    if (ERE_METACHARACTERS.has(escaped)) {
      return { type: "RegexLiteral", value: escaped, range };
    }

    if (escaped >= "1" && escaped <= "9") {
      return { type: "RegexBackreference", group: Number(escaped), range };
    }

    const shorthand = SHORTHAND_CLASSES[escaped.toLowerCase()];
    if (shorthand !== undefined) {
      const negated = escaped === escaped.toUpperCase();
      return {
        type: "RegexShorthand",
        char: escaped,
        negated,
        equivalent: negated ? shorthand.replace("[", "[^") : shorthand,
        range,
      };
    }

    const boundary = BOUNDARY_KINDS[escaped];
    if (boundary !== undefined) {
      return { type: "RegexBoundary", kind: boundary, range };
    }

    return { type: "RegexEscape", char: escaped, range };
  }

  private parseAtom(): RegexNode {
    const start = this.pos;
    const ch = this.text[start];

    if (ch === "(") {
      this.pos++;
      const body = this.parseAlternation();
      if (this.text[this.pos] !== ")") throw new RegexSyntaxError("Unclosed group");
      this.pos++;
      return { type: "RegexGroup", body, range: this.range(start, this.pos) };
    }

    if (ch === "[") {
      const bracket = this.ctx.readBracket(this.text, this.pos);
      if (bracket === null) throw new RegexSyntaxError("Unclosed bracket expression");
      this.pos = bracket.next;
      return {
        type: "RegexClass",
        negated: bracket.negated,
        members: bracket.members,
        range: this.range(start, this.pos),
      };
    }

    // A quoted run is matched literally, however much regex syntax it contains
    if (ch === "'" || ch === '"') {
      const close = this.text.indexOf(ch, start + 1);
      const end = close === -1 ? this.text.length : close;
      this.pos = close === -1 ? this.text.length : close + 1;
      return { type: "RegexLiteral", value: this.text.slice(start + 1, end), range: this.range(start, this.pos) };
    }

    if (ch === "$" || ch === "`") {
      const expansion = this.ctx.readExpansion(this.text, start);
      if (expansion !== null) {
        this.pos = expansion.next;
        return { type: "RegexExpansion", part: expansion.part, range: this.range(start, this.pos) };
      }
      // A `$` that expands nothing is the end anchor
    }

    if (ch === "^" || ch === "$") {
      this.pos++;
      return { type: "RegexAnchor", kind: ch === "^" ? "start" : "end", range: this.range(start, this.pos) };
    }

    if (ch === ".") {
      this.pos++;
      return { type: "RegexAny", range: this.range(start, this.pos) };
    }

    if (ch === "\\") {
      const escaped = this.text[start + 1];
      if (escaped === undefined) throw new RegexSyntaxError("Trailing backslash");
      this.pos += 2;
      return this.escapeNode(escaped, start);
    }

    if (ch === undefined || ch === ")") throw new RegexSyntaxError("Unexpected end of pattern");

    // Run of ordinary characters, stopping before anything with its own meaning
    let end = start;
    while (end < this.text.length && !REGEX_SPECIAL.has(this.text[end]!)) end++;
    if (end === start) end = start + 1;

    // A quantifier binds only the last character, so leave it for the next atom
    if (end - start > 1 && REGEX_QUANTIFIER_LEADS.has(this.text[end] ?? "")) end--;

    this.pos = end;
    return { type: "RegexLiteral", value: this.text.slice(start, end), range: this.range(start, this.pos) };
  }
}

const REGEX_SPECIAL = new Set(["(", ")", "[", "]", "{", "}", "|", "^", "$", ".", "\\", "*", "+", "?", "'", '"', "`"]);
const REGEX_QUANTIFIER_LEADS = new Set(["*", "+", "?", "{"]);

/** Escaping one of these is the only escape POSIX ERE actually defines */
const ERE_METACHARACTERS = new Set([".", "[", "]", "\\", "(", ")", "*", "+", "?", "{", "}", "|", "^", "$"]);

/** GNU shorthands, with the bracket expression each stands for */
const SHORTHAND_CLASSES: Record<string, string | undefined> = {
  w: "[[:alnum:]_]",
  s: "[[:space:]]",
};

const BOUNDARY_KINDS: Record<string, "word" | "notWord" | "wordStart" | "wordEnd" | "bufferStart" | "bufferEnd" | undefined> = {
  b: "word",
  B: "notWord",
  "<": "wordStart",
  ">": "wordEnd",
  "`": "bufferStart",
  "'": "bufferEnd",
};

/**
 * Parse `text` as an extended regular expression, or return null when it does
 * not fit. Null rather than throwing: the operand's text is kept either way,
 * and an unusual pattern should not fail the surrounding script.
 */
export function parseRegex(text: string, offset: number, ctx: RegexContext): RegexNode | null {
  if (text === "") return null;

  try {
    return new RegexParser(text, offset, ctx).parse();
  } catch (err) {
    if (err instanceof RegexSyntaxError) return null;
    throw err;
  }
}
