import type { ArithmeticExpr, Range, WordPart } from "./ast.ts";

/**
 * Parser for shell arithmetic — the inside of `$(( … ))`, `(( … ))` and the
 * three clauses of a C-style `for`.
 *
 * Precedence climbing over bash's operator set. The table is the grammar: a
 * higher number binds tighter, and `**` is the only right-associative binary
 * operator.
 */
const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6, "!=": 6,
  "<": 7, "<=": 7, ">": 7, ">=": 7,
  "<<": 8, ">>": 8,
  "+": 9, "-": 9,
  "*": 10, "/": 10, "%": 10,
  "**": 11,
};

const ASSIGNMENT_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);

/** Longest first, so `<<=` is never mis-read as `<<` then `=` */
const OPERATORS = [
  "<<=", ">>=",
  "**", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
  "+=", "-=", "*=", "/=", "%=", "&=", "^=", "|=",
  "=", "+", "-", "*", "/", "%", "<", ">", "!", "~", "&", "^", "|", "?", ":", ",",
  "(", ")", "[", "]",
];

/**
 * Resolves a `$…` expansion appearing inside arithmetic. Supplied by the shell
 * parser, which already knows how to read one.
 */
export type ExpansionReader = (text: string, pos: number) => { part: WordPart; next: number } | null;

/** Arithmetic that does not fit the grammar — the caller keeps the raw text */
class ArithmeticSyntaxError extends Error {}

interface Tok {
  kind: "number" | "name" | "op" | "expansion";
  value: string;
  start: number;
  end: number;
  part?: WordPart;
}

/**
 * Read a numeric literal: decimal, `0x` hex, leading-zero octal, or bash's
 * `base#digits`. Returns null when the text is not a number.
 */
function readNumber(raw: string): number | null {
  const based = raw.match(/^(\d+)#([0-9a-zA-Z@_]+)$/);
  if (based) {
    const base = parseInt(based[1]!, 10);
    if (base < 2 || base > 64) return null;
    let value = 0;
    for (const ch of based[2]!) {
      // bash's digit order past 9: a–z, then A–Z, then @ and _
      let digit: number;
      if (ch >= "0" && ch <= "9") digit = ch.charCodeAt(0) - 48;
      else if (ch >= "a" && ch <= "z") digit = ch.charCodeAt(0) - 87;
      else if (ch >= "A" && ch <= "Z") digit = base <= 36 ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 29;
      else if (ch === "@") digit = 62;
      else digit = 63;
      if (digit >= base) return null;
      value = value * base + digit;
    }
    return value;
  }

  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (/^0[0-7]+$/.test(raw)) return parseInt(raw, 8);
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
}

function lex(text: string, readExpansion: ExpansionReader): Tok[] {
  const toks: Tok[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }

    // A line continuation: the shell joins the lines before arithmetic ever
    // sees them, so the pair is whitespace here — `$((1\<newline>+2))` is 3
    if (ch === "\\" && text[i + 1] === "\n") { i += 2; continue; }

    if (ch === "$" || ch === "`") {
      const expansion = readExpansion(text, i);
      if (!expansion) throw new ArithmeticSyntaxError(`Unreadable expansion at ${i}`);
      toks.push({ kind: "expansion", value: text.slice(i, expansion.next), start: i, end: expansion.next, part: expansion.part });
      i = expansion.next;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < text.length && /[0-9a-zA-Z_#@]/.test(text[i]!)) i++;
      toks.push({ kind: "number", value: text.slice(start, i), start, end: i });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i]!)) i++;
      toks.push({ kind: "name", value: text.slice(start, i), start, end: i });
      continue;
    }

    const op = OPERATORS.find(candidate => text.startsWith(candidate, i));
    if (!op) throw new ArithmeticSyntaxError(`Unexpected character "${ch}" at ${i}`);
    toks.push({ kind: "op", value: op, start: i, end: i + op.length });
    i += op.length;
  }

  return toks;
}

class ArithmeticParser {
  private pos = 0;

  constructor(private toks: Tok[], private offset: number) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private atOp(...values: string[]): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.kind === "op" && values.includes(tok.value);
  }

  private expectOp(value: string): Tok {
    if (!this.atOp(value)) {
      throw new ArithmeticSyntaxError(`Expected "${value}"`);
    }
    return this.toks[this.pos++]!;
  }

  private range(from: number, to: number): Range {
    return { start: this.offset + from, end: this.offset + to };
  }

  private spanning(node: ArithmeticExpr, from: number): Range {
    return { start: this.offset + from, end: node.range.end };
  }

  parse(): ArithmeticExpr {
    const expr = this.parseComma();
    if (this.pos < this.toks.length) {
      throw new ArithmeticSyntaxError(`Trailing input at ${this.toks[this.pos]!.start}`);
    }
    return expr;
  }

  /** `a, b` — lowest precedence, left-associative */
  private parseComma(): ArithmeticExpr {
    let left = this.parseAssignment();

    while (this.atOp(",")) {
      this.pos++;
      const right = this.parseAssignment();
      left = { type: "ArithmeticBinary", op: ",", left, right, range: { start: left.range.start, end: right.range.end } };
    }

    return left;
  }

  /** `x = y`, `x += y`, … — right-associative, and only onto an assignable target */
  private parseAssignment(): ArithmeticExpr {
    const start = this.peek()?.start ?? 0;
    const left = this.parseConditional();

    const tok = this.peek();
    if (tok?.kind === "op" && ASSIGNMENT_OPS.has(tok.value)) {
      if (left.type !== "ArithmeticVariable" && left.type !== "ArithmeticSubscript") {
        throw new ArithmeticSyntaxError("Assignment to something that is not a variable");
      }
      this.pos++;
      const value = this.parseAssignment();
      return { type: "ArithmeticAssignment", op: tok.value, target: left, value, range: this.spanning(value, start) };
    }

    return left;
  }

  /** `c ? a : b` — right-associative; the middle is a full expression */
  private parseConditional(): ArithmeticExpr {
    const start = this.peek()?.start ?? 0;
    const condition = this.parseBinary(1);

    if (!this.atOp("?")) return condition;

    this.pos++;
    const whenTrue = this.parseComma();
    this.expectOp(":");
    const whenFalse = this.parseAssignment();

    return {
      type: "ArithmeticConditional",
      condition,
      then: whenTrue,
      else: whenFalse,
      range: this.spanning(whenFalse, start),
    };
  }

  private parseBinary(minPrecedence: number): ArithmeticExpr {
    let left = this.parseUnary();

    for (;;) {
      const tok = this.peek();
      if (tok?.kind !== "op") break;

      const precedence = BINARY_PRECEDENCE[tok.value];
      if (precedence === undefined || precedence < minPrecedence) break;

      this.pos++;
      // `**` is the one right-associative binary operator
      const right = this.parseBinary(tok.value === "**" ? precedence : precedence + 1);
      left = { type: "ArithmeticBinary", op: tok.value, left, right, range: { start: left.range.start, end: right.range.end } };
    }

    return left;
  }

  private parseUnary(): ArithmeticExpr {
    const tok = this.peek();

    if (tok?.kind === "op" && (tok.value === "++" || tok.value === "--")) {
      this.pos++;
      const operand = this.parseUnary();
      return { type: "ArithmeticUpdate", op: tok.value, prefix: true, operand, range: this.spanning(operand, tok.start) };
    }

    if (tok?.kind === "op" && (tok.value === "+" || tok.value === "-" || tok.value === "!" || tok.value === "~")) {
      this.pos++;
      const operand = this.parseUnary();
      return { type: "ArithmeticUnary", op: tok.value, operand, range: this.spanning(operand, tok.start) };
    }

    return this.parsePostfix();
  }

  private parsePostfix(): ArithmeticExpr {
    let expr = this.parsePrimary();

    while (this.atOp("++", "--")) {
      const tok = this.toks[this.pos++]!;
      expr = {
        type: "ArithmeticUpdate",
        op: tok.value as "++" | "--",
        prefix: false,
        operand: expr,
        range: { start: expr.range.start, end: this.offset + tok.end },
      };
    }

    return expr;
  }

  private parsePrimary(): ArithmeticExpr {
    const tok = this.peek();
    if (!tok) throw new ArithmeticSyntaxError("Unexpected end of expression");

    if (tok.kind === "number") {
      this.pos++;
      const value = readNumber(tok.value);
      if (value === null) throw new ArithmeticSyntaxError(`Invalid number "${tok.value}"`);
      return { type: "ArithmeticNumber", value, raw: tok.value, range: this.range(tok.start, tok.end) };
    }

    if (tok.kind === "expansion") {
      this.pos++;
      return { type: "ArithmeticSubstitution", part: tok.part!, range: this.range(tok.start, tok.end) };
    }

    if (tok.kind === "name") {
      this.pos++;

      if (this.atOp("[")) {
        this.pos++;
        const index = this.parseComma();
        const close = this.expectOp("]");
        return {
          type: "ArithmeticSubscript",
          name: tok.value,
          index,
          range: this.range(tok.start, close.end),
        };
      }

      return { type: "ArithmeticVariable", name: tok.value, range: this.range(tok.start, tok.end) };
    }

    if (tok.value === "(") {
      this.pos++;
      const inner = this.parseComma();
      this.expectOp(")");
      return inner;
    }

    throw new ArithmeticSyntaxError(`Unexpected "${tok.value}"`);
  }
}

/**
 * Parse arithmetic text into an expression tree, or return null when it does
 * not fit the grammar. Null rather than throwing: the caller always keeps the
 * raw text, and an unmodelled corner of bash arithmetic should not fail the
 * surrounding script.
 */
export function parseArithmetic(text: string, offset: number, readExpansion: ExpansionReader): ArithmeticExpr | null {
  if (text.trim() === "") return null;

  try {
    return new ArithmeticParser(lex(text, readExpansion), offset).parse();
  } catch (err) {
    if (err instanceof ArithmeticSyntaxError) return null;
    throw err;
  }
}
