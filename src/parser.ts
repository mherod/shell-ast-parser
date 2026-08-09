import type {
  Script, Command, SimpleCommand, Pipeline, ListItem,
  CompoundWord, WordPart, Redirect, HereDoc, Assignment, ArrayLiteral, Range, QuoteContext,
  GlobBracketMember,
  IfClause, ForClause, ArithmeticForClause, ArithmeticCommand, ArithmeticExpr,
  LetCommand, LetExpression, TestCommand, TestExpr, RegexNode,
  WhileClause, UntilClause, RepeatClause, CaseClause, CaseItem,
  Subshell, BraceGroup, FunctionDef, Comment, Coproc,
  Dialect, ParseOptions,
} from "./ast.ts";
import { tokenize, readHereDocHeader, skipHereDocBodies, readExpansionExtent, splitArithmeticClauses, EXTGLOB_LEADS, type Token, TokenType } from "./tokenizer.ts";
import { parseArithmetic } from "./arithmetic.ts";
import { parseRegex } from "./regex.ts";

/** Single-operand conditional operators, from bash's test builtin */
const TEST_UNARY_OPS = new Set([
  "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-p", "-r", "-s", "-t",
  "-u", "-w", "-x", "-G", "-L", "-N", "-O", "-S", "-o", "-v", "-R", "-z", "-n",
]);

/** Two-operand conditional operators. `<` and `>` arrive as operator tokens. */
const TEST_BINARY_OPS = new Set([
  "=", "==", "!=", "=~",
  "-eq", "-ne", "-lt", "-le", "-gt", "-ge",
  "-ef", "-nt", "-ot",
]);

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f",
  n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

/**
 * Read the body of a `$'…'` string, starting just past the opening quote.
 * Unlike every other quoting form, these escapes stand for control characters.
 */
function readAnsiCString(raw: string, start: number): { value: string; next: number } {
  let i = start;
  let value = "";

  while (i < raw.length && raw[i] !== "'") {
    if (raw[i] !== "\\" || i + 1 >= raw.length) {
      value += raw[i];
      i++;
      continue;
    }

    const esc = raw[i + 1]!;
    const simple = ANSI_C_ESCAPES[esc];
    if (simple !== undefined) {
      value += simple;
      i += 2;
    } else if (esc === "x" || esc === "u" || esc === "U") {
      const width = esc === "x" ? 2 : esc === "u" ? 4 : 8;
      const digits = raw.slice(i + 2, i + 2 + width).match(/^[0-9a-fA-F]+/)?.[0] ?? "";
      if (digits.length > 0) {
        value += String.fromCodePoint(parseInt(digits, 16));
        i += 2 + digits.length;
      } else {
        value += esc;
        i += 2;
      }
    } else if (esc >= "0" && esc <= "7") {
      const digits = raw.slice(i + 1, i + 4).match(/^[0-7]+/)![0];
      value += String.fromCharCode(parseInt(digits, 8));
      i += 1 + digits.length;
    } else {
      // Not an escape sequence: the backslash stands for itself
      value += "\\" + esc;
      i += 2;
    }
  }

  if (i < raw.length) i++; // skip closing '
  return { value, next: i };
}

/**
 * Find the `]` closing a bracket expression that opens at `start`, or -1 if
 * there is none and the `[` is just a literal character.
 *
 * Two quirks of the syntax: `!` or `^` right after the `[` negates the set, and
 * a `]` in first position is a literal member rather than the terminator —
 * `[]a]` matches `]` or `a`.
 */
function findBracketClose(raw: string, start: number): number {
  let i = start + 1;
  if (raw[i] === "!" || raw[i] === "^") i++;
  if (raw[i] === "]") i++;

  while (i < raw.length) {
    // `[:alpha:]`, `[=a=]` and `[.a.]` carry their own `]`, which does not end
    // the enclosing expression
    const inner = raw[i] === "[" ? CLASS_DELIMITERS[raw[i + 1] ?? ""] : undefined;
    if (inner !== undefined) {
      const close = raw.indexOf(inner, i + 2);
      if (close !== -1) {
        i = close + inner.length;
        continue;
      }
    }

    if (raw[i] === "]") return i;
    i++;
  }

  return -1;
}

/** Opening character of a bracket sub-expression → the sequence that closes it */
const CLASS_DELIMITERS: Record<string, string | undefined> = {
  ":": ":]",
  "=": "=]",
  ".": ".]",
};

const CLASS_KINDS: Record<string, "class" | "equivalence" | "collating"> = {
  ":": "class",
  "=": "equivalence",
  ".": "collating",
};

/**
 * Break the inside of a bracket expression into its members. A `-` that has no
 * neighbour on one side is a literal, so `[-a]` and `[a-]` list a dash.
 */
function parseBracketMembers(inner: string, offset: number): GlobBracketMember[] {
  const members: GlobBracketMember[] = [];
  let i = 0;

  while (i < inner.length) {
    const closer = inner[i] === "[" ? CLASS_DELIMITERS[inner[i + 1] ?? ""] : undefined;
    if (closer !== undefined) {
      const close = inner.indexOf(closer, i + 2);
      if (close !== -1) {
        members.push({
          type: "GlobClass",
          name: inner.slice(i + 2, close),
          kind: CLASS_KINDS[inner[i + 1]!]!,
          range: { start: offset + i, end: offset + close + closer.length },
        });
        i = close + closer.length;
        continue;
      }
    }

    // `a-z`, but only when a character follows the dash
    if (inner[i + 1] === "-" && i + 2 < inner.length && inner[i + 2] !== "]") {
      members.push({
        type: "GlobRange",
        from: inner[i]!,
        to: inner[i + 2]!,
        range: { start: offset + i, end: offset + i + 3 },
      });
      i += 3;
      continue;
    }

    members.push({ type: "GlobChar", value: inner[i]!, range: { start: offset + i, end: offset + i + 1 } });
    i++;
  }

  return members;
}

/**
 * Split an extended glob's body on its top-level `|`. Nested groups, bracket
 * expressions and quotes are stepped over — `@(a|[b|c])` has one alternative
 * either side of the first bar only.
 */
function splitAlternatives(text: string): { text: string; offset: number }[] {
  const alternatives: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipQuoted(text, i); continue; }

    if (ch === "[") {
      const close = findBracketClose(text, i);
      if (close !== -1) { i = close + 1; continue; }
    }

    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      alternatives.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
    i++;
  }

  alternatives.push({ text: text.slice(start), offset: start });
  return alternatives;
}

/** Index just past the `)` matching the `(` at `open`, or -1 if unbalanced */
function matchingParen(raw: string, open: number): number {
  let depth = 0;

  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\") { i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

/** The characters zsh allows in a glob qualifier, e.g. `.`, `-/FN`, `om[1,3]` */
const QUALIFIER_CHARS = /^[-\w.,:@=%^+/*\[\]]+$/;

/**
 * zsh tells a qualifier from a pattern group by where it sits: `(N)` in
 * `bin(N)` closes the word and selects among the matches, while `(a|b)` in
 * `[[ $x == (a|b) ]]` is the whole pattern and matches text. So a group only
 * qualifies when something precedes it, it ends the word, and it holds no
 * alternation.
 */
function isQualifierGroup(raw: string, open: number): boolean {
  if (open === 0) return false;

  const close = matchingParen(raw, open);
  if (close !== raw.length) return false;

  const body = raw.slice(open + 1, close - 1);
  return body.length > 0 && !body.includes("|") && QUALIFIER_CHARS.test(body);
}

/**
 * Where the `}` closing the `{` at `open` sits, and what is inside — but only
 * when the braces expand. `{a}` and `${x}` do not: a list needs a comma and a
 * sequence needs `..`, so anything else is literal text the shell leaves alone.
 */
function readBraceExpansion(raw: string, open: number): { body: string; end: number; commas: number[] } | null {
  if (open > 0 && raw[open - 1] === "$") return null;

  const commas: number[] = [];
  let depth = 0;

  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === '"') { i = skipQuoted(raw, i) - 1; continue; }

    if (ch === "{") depth++;
    else if (ch === ",") { if (depth === 1) commas.push(i); }
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = raw.slice(open + 1, i);
        const expands = commas.length > 0 || /^[^.]*\.\.[^.]/.test(body);
        return expands ? { body, end: i + 1, commas } : null;
      }
    }
  }

  return null;
}

/** `{0..9}` and `{0..20..5}`, with the endpoints kept as written */
function readBraceSequence(body: string): { from: string; to: string; step: string | null } | null {
  const match = /^([^.]+)\.\.([^.]+?)(?:\.\.([^.]+))?$/.exec(body);
  return match ? { from: match[1]!, to: match[2]!, step: match[3] ?? null } : null;
}

/** `<1->`, `<-9>`, `<1-9>`, `<->` — an open end is null */
function readNumericRange(raw: string, at: number): { min: number | null; max: number | null; end: number } | null {
  const match = /^<(\d*)-(\d*)>/.exec(raw.slice(at));
  if (!match) return null;

  return {
    min: match[1] === "" ? null : parseInt(match[1]!, 10),
    max: match[2] === "" ? null : parseInt(match[2]!, 10),
    end: at + match[0].length,
  };
}

/**
 * The literal text of a word that is nothing but literal text, or null when it
 * expands. `\(` and `'('` both resolve to `(`, which is how a group survives
 * into `[ … ]`.
 */
function literalValue(word: CompoundWord | undefined): string | null {
  if (word === undefined || word.parts.length !== 1) return null;
  const part = word.parts[0]!;
  return part.type === "Word" ? part.value : null;
}

/** Words that end an operand run inside `[ … ]` */
function isBracketKeyword(word: CompoundWord | undefined): boolean {
  const value = literalValue(word);
  return value === "-a" || value === "-o" || value === ")" || value === "]";
}

/**
 * Strip one layer of wrapping quotes, reporting how far the text shifted so
 * ranges stay aligned. Only a fully-quoted word is unwrapped.
 */
function unwrapQuotes(raw: string): { text: string; offset: number } {
  const quote = raw[0];
  const wrapped = (quote === "'" || quote === '"') && raw.length >= 2 && raw.endsWith(quote);
  return wrapped ? { text: raw.slice(1, -1), offset: 1 } : { text: raw, offset: 0 };
}

/** Skip a quoted span starting at the opening quote; returns the index past it */
function skipQuoted(raw: string, start: number): number {
  const quote = raw[start]!;
  let i = start + 1;

  while (i < raw.length && raw[i] !== quote) {
    // Backslash escapes exist inside double quotes only
    if (quote === '"' && raw[i] === "\\") i += 2;
    else i++;
  }

  return i < raw.length ? i + 1 : i;
}

/**
 * Whether the character at `pos` begins a word — true at the start of the
 * region, after whitespace, or after an operator that ends the previous word.
 * Only there does `#` open a comment.
 */
function startsWord(raw: string, pos: number, regionStart: number): boolean {
  if (pos === regionStart) return true;
  const prev = raw[pos - 1]!;
  return prev === " " || prev === "\t" || prev === "\n" || prev === ";" || prev === "&" || prev === "|" || prev === "(";
}

/**
 * Read a delimited region, starting at the index of its opener. Quoted spans
 * are skipped whole, so a delimiter inside a string does not close the region:
 * `$(grep ")" file)` runs to the last paren, not the quoted one.
 *
 * `depth` above 1 is for openers spelled with repeated delimiters, like `$((`.
 * The extra closers land at the end of the body, so they are trimmed off.
 *
 * `shellCode` marks regions whose contents are shell code — `$( )` and `<( )` —
 * where `#` opens a comment and `<<` opens a heredoc whose body must be stepped
 * over. It stays off for `${ }`, where `#` is the length and prefix-strip
 * operator, and for arithmetic.
 */
function readDelimited(raw: string, open: number, openCh: string, closeCh: string, depth: number = 1, shellCode: boolean = false): { body: string; next: number } {
  const extraClosers = depth - 1;
  const start = open + 1;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let i = start;

  while (i < raw.length) {
    const ch = raw[i]!;

    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipQuoted(raw, i); continue; }

    if (shellCode && ch === "#" && startsWord(raw, i, start)) {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }

    if (shellCode && ch === "<" && raw[i + 1] === "<") {
      const header = readHereDocHeader(raw, i);
      if (header) {
        heredocs.push({ delimiter: header.delimiter, stripTabs: header.stripTabs });
        i = header.next;
        continue;
      }
    }

    if (ch === "\n" && heredocs.length > 0) {
      i = skipHereDocBodies(raw, i + 1, heredocs);
      heredocs.length = 0;
      continue;
    }

    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }

  let body = raw.slice(start, i);
  for (let n = 0; n < extraClosers && body.endsWith(closeCh); n++) {
    body = body.slice(0, -1);
  }

  return { body, next: i < raw.length ? i + 1 : i };
}

/** `$( )` and `<( )` bodies hold shell code, so `#` opens a comment */
function readParenBody(raw: string, openParen: number): { body: string; next: number } {
  return readDelimited(raw, openParen, "(", ")", 1, true);
}

/**
 * Move every range in a subtree by `offset`. Range objects are shared between
 * sibling nodes (a word's parts all point at the token range), so each one is
 * shifted at most once.
 */
function shiftRanges(node: unknown, offset: number, seen: Set<object> = new Set()): void {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) shiftRanges(item, offset, seen);
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "range" && value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      const r = value as Range;
      r.start += offset;
      r.end += offset;
    } else {
      shiftRanges(value, offset, seen);
    }
  }
}

export class ParseError extends Error {
  constructor(message: string, public token: Token) {
    super(`${message} at position ${token.range.start} (got "${token.value}")`);
    this.name = "ParseError";
  }
}

export class Parser {
  private tokens: Token[];
  private pos: number = 0;
  private comments: Comment[] = [];
  /** Heredoc targets awaiting a body, in the order the tokenizer will emit them */
  private pendingHereDocs: HereDoc[] = [];
  /**
   * Functions defined so far. A function shadows a builtin of the same name
   * only once its definition has run, so a single forward pass matches the
   * shell: names seen earlier in the source shadow, later ones do not.
   */
  private definedFunctions: Set<string> = new Set();
  private dialect: Dialect;

  constructor(tokens: Token[], options: ParseOptions = {}) {
    this.tokens = tokens;
    this.dialect = options.dialect ?? "bash";
  }

  parse(): Script {
    const start = this.peek().range.start;
    const commands = this.parseCompoundList(true);

    // A terminator that closes nothing — a stray `)` or `}` — ends the list
    // here, and everything after it would be dropped without a word. A short
    // script that looks complete is the worst outcome for a caller auditing
    // what a script runs, so refuse to return one.
    if (!this.at(TokenType.EOF)) {
      throw new ParseError("Unexpected token", this.peek());
    }

    const end = this.peek().range.end;

    return {
      type: "Script",
      commands,
      comments: this.comments,
      range: { start, end },
    };
  }

  // ── Helpers ────────────────────────────────────────────────────

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: "", range: { start: 0, end: 0 } };
  }

  private advance(): Token {
    const tok = this.peek();
    this.pos++;
    return tok;
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.peek();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new ParseError(`Expected ${type}${value ? ` "${value}"` : ""}`, tok);
    }
    return this.advance();
  }

  private at(type: TokenType, value?: string): boolean {
    const tok = this.peek();
    return tok.type === type && (value === undefined || tok.value === value);
  }

  private atAny(type: TokenType, ...values: string[]): boolean {
    const tok = this.peek();
    return tok.type === type && values.includes(tok.value);
  }

  /** Check if next token has this value, regardless of whether it's Word or Keyword */
  private atWord(value: string): boolean {
    const tok = this.peek();
    return tok.value === value && (tok.type === TokenType.Keyword || tok.type === TokenType.Word);
  }

  /** Expect a token by value, accepting either Word or Keyword type */
  private expectWord(value: string): Token {
    const tok = this.peek();
    if (tok.value !== value) {
      throw new ParseError(`Expected "${value}"`, tok);
    }
    return this.advance();
  }

  private skipNewlines(): void {
    while (this.at(TokenType.Newline) || this.at(TokenType.Comment) || this.at(TokenType.HereDocBody)) {
      if (this.at(TokenType.Comment)) {
        const tok = this.advance();
        this.comments.push({
          type: "Comment",
          value: tok.value,
          range: tok.range,
        });
      } else if (this.at(TokenType.HereDocBody)) {
        this.consumeHereDocBody();
      } else {
        this.advance();
      }
    }
  }

  private skipNewlinesAndSemicolons(): void {
    while (
      this.at(TokenType.Newline) ||
      this.atAny(TokenType.Operator, ";") ||
      this.at(TokenType.Comment) ||
      this.at(TokenType.HereDocBody)
    ) {
      if (this.at(TokenType.Comment)) {
        const tok = this.advance();
        this.comments.push({
          type: "Comment",
          value: tok.value,
          range: tok.range,
        });
      } else if (this.at(TokenType.HereDocBody)) {
        this.consumeHereDocBody();
      } else {
        this.advance();
      }
    }
  }

  /**
   * The tokenizer emits heredoc bodies after the newline that closes the command,
   * in the order the delimiters were declared. Attach each body to the heredoc
   * that claimed it, so `cmd <<A <<B` fills A then B.
   */
  private consumeHereDocBody(): void {
    const tok = this.expect(TokenType.HereDocBody);
    const target = this.pendingHereDocs.shift();
    if (target) {
      target.content = tok.value;
    }
  }

  // ── Compound list (script body) ────────────────────────────────

  /**
   * `stopAtBrace` reads a zsh condition, where a `{` that follows it opens the
   * body: `if (( x )) { … }`. It only stops once something has been read, so a
   * brace group can still be the condition itself.
   */
  private parseCompoundList(_topLevel: boolean = false, stopAtBrace: boolean = false): Command[] {
    const commands: Command[] = [];
    this.skipNewlinesAndSemicolons();

    while (!this.at(TokenType.EOF) && !this.isListTerminator()) {
      if (stopAtBrace && commands.length > 0 && this.atBraceGroup()) break;

      const before = this.pos;
      const cmd = this.parseList();

      // A parse path that consumes nothing would spin here forever. Fail loudly
      // instead: an unparseable token is a bug report, not an infinite loop.
      if (this.pos === before) {
        throw new ParseError("Unexpected token", this.peek());
      }

      commands.push(cmd);

      // Consume list terminators
      if (this.atAny(TokenType.Operator, ";", "&")) {
        const op = this.advance();
        if (op.value === "&") {
          cmd.background = true;
          cmd.range = { start: cmd.range.start, end: op.range.end };
        }
      }

      this.skipNewlinesAndSemicolons();
    }

    return commands;
  }

  private isListTerminator(): boolean {
    const tok = this.peek();
    const terminators = ["fi", "done", "esac", "then", "else", "elif", "do", "}", ")", "]]"];
    if (terminators.includes(tok.value) && (tok.type === TokenType.Keyword || tok.type === TokenType.Word)) {
      return true;
    }
    // A closing `}` mid-line tokenizes as an Operator, but still ends the list
    return this.atAny(TokenType.Operator, ")", ";;", ";&", ";;&", ";|", "}");
  }

  // ── List: pipeline (&&/|| pipeline)* ───────────────────────────

  private parseList(): ListItem {
    let left: ListItem = this.parsePipeline();

    while (this.atAny(TokenType.Operator, "&&", "||")) {
      const op = this.advance();
      this.skipNewlines();
      const right = this.parsePipeline();
      left = {
        type: "List",
        left,
        op: op.value as "&&" | "||",
        right,
        background: false,
        range: { start: left.range.start, end: right.range.end },
      };
    }

    return left;
  }

  // ── Pipeline: [!] command (| command)* ─────────────────────────

  private parsePipeline(): Pipeline {
    const start = this.peek().range.start;
    let negated = false;

    // A lone `!` always negates; no command is named that, so accept it however
    // the tokenizer classified it
    if (this.atAny(TokenType.Keyword, "!") || this.atAny(TokenType.Word, "!")) {
      this.advance();
      negated = true;
    }

    const commands: Command[] = [this.parseCommand()];

    while (this.atAny(TokenType.Operator, "|") && !this.atAny(TokenType.Operator, "||")) {
      this.advance();
      this.skipNewlines();
      commands.push(this.parseCommand());
    }

    const end = commands[commands.length - 1]!.range.end;

    return {
      type: "Pipeline",
      negated,
      commands,
      background: false,
      range: { start, end },
    };
  }

  // ── Command dispatch ───────────────────────────────────────────

  private parseCommand(): Command {
    const tok = this.peek();

    // Compound commands
    if (tok.type === TokenType.Keyword) {
      switch (tok.value) {
        case "if": return this.parseIf();
        case "for": return this.parseFor();
        case "while": return this.parseWhile();
        case "until": return this.parseUntil();
        case "repeat": return this.parseRepeat();
        case "case": return this.parseCase();
        case "function": return this.parseFunctionKeyword();
        case "coproc": return this.parseCoproc();
        case "[[": return this.parseDoubleSquareBracket();
      }
    }

    // `{` only tokenizes as a Keyword at command start, so `function f { ... }`
    // and `coproc NAME { ... }` deliver it as an Operator. Dispatch on the value.
    if (tok.value === "{" && (tok.type === TokenType.Keyword || tok.type === TokenType.Operator)) {
      return this.parseBraceGroup();
    }

    if (tok.type === TokenType.Arithmetic) {
      return this.parseArithmeticCommand();
    }

    if (tok.type === TokenType.Operator && tok.value === "(") {
      return this.parseSubshell();
    }

    return this.parseSimpleCommandOrFunctionDef();
  }

  // ── Simple command (with function def detection) ───────────────

  private parseSimpleCommandOrFunctionDef(): SimpleCommand | FunctionDef | LetCommand | TestCommand {
    const start = this.peek().range.start;
    const assignments: Assignment[] = [];
    const redirects: Redirect[] = [];

    // Collect leading assignments
    while (this.at(TokenType.Assignment)) {
      assignments.push(this.parseAssignment());
    }

    // Collect leading redirects
    while (this.at(TokenType.Redirect)) {
      redirects.push(this.parseRedirect());
    }

    if (!this.at(TokenType.Word) && !this.at(TokenType.Keyword, "[[")) {
      // Assignment-only command
      const end = this.pos > 0 ? this.tokens[this.pos - 1]!.range.end : start;
      return {
        type: "SimpleCommand",
        assignments,
        name: null,
        args: [],
        redirects,
        range: { start, end },
      };
    }

    // Function def check: word followed by ()
    if (this.at(TokenType.Word) && this.pos + 2 < this.tokens.length) {
      const next1 = this.tokens[this.pos + 1];
      const next2 = this.tokens[this.pos + 2];
      if (next1?.type === TokenType.Operator && next1.value === "(" &&
          next2?.type === TokenType.Operator && next2.value === ")") {
        return this.parseFunctionDef();
      }
    }

    const nameToken = this.advance();
    const name = this.tokenToCompoundWord(nameToken);

    // Builtins whose arguments are an expression rather than plain words —
    // unless a function defined earlier has taken the name, in which case this
    // is an ordinary call to it
    const builtin = literalValue(name);
    if (builtin !== null && !this.definedFunctions.has(builtin)) {
      if (builtin === "let") {
        return this.parseLetCommand(start, assignments, redirects);
      }
      if (builtin === "[" || builtin === "test") {
        return this.parseBracketTest(start, builtin, assignments, redirects);
      }
    }

    const args: (CompoundWord | Assignment)[] = [];

    // Collect args and redirects
    while (
      this.at(TokenType.Word) ||
      this.at(TokenType.Assignment) ||
      this.at(TokenType.Redirect)
    ) {
      if (this.at(TokenType.Redirect)) {
        redirects.push(this.parseRedirect());
      } else if (this.at(TokenType.Assignment)) {
        // The tokenizer only marks these past the command name for declaration
        // builtins, where `X=(1 2)` is an argument rather than a subshell
        args.push(this.parseAssignment());
      } else {
        args.push(this.tokenToCompoundWord(this.advance()));
      }
    }

    // A body may already be here when the command is the last line of input
    while (this.at(TokenType.HereDocBody)) {
      this.consumeHereDocBody();
    }

    const end = this.lastEnd(start);

    return {
      type: "SimpleCommand",
      assignments,
      name,
      args,
      redirects,
      range: { start, end },
    };
  }

  // ── Assignments ────────────────────────────────────────────────

  private parseAssignment(): Assignment {
    const tok = this.expect(TokenType.Assignment);
    const eqIdx = tok.value.indexOf("=");
    const lhs = tok.value.slice(0, eqIdx);
    const append = lhs.endsWith("+");
    const target = append ? lhs.slice(0, -1) : lhs;
    const rawValue = tok.value.slice(eqIdx + 1);

    // NAME[subscript] — the subscript is a word in its own right, so `$i` in
    // `ITEMS[$i]=x` expands
    const subscripted = target.match(/^([^[]+)\[(.+)\]$/);
    const name = subscripted ? subscripted[1]! : target;
    const subscript = subscripted
      ? this.rawToCompoundWord(
          subscripted[2]!,
          { start: tok.range.start + name.length + 1, end: tok.range.start + name.length + 1 + subscripted[2]!.length },
          tok.range.start + name.length + 1,
        )
      : null;

    // `VAR=(a b c)` is an array literal, but `VAR= (cmd)` is an empty
    // assignment followed by a subshell — only adjacency tells them apart.
    if (rawValue.length === 0 && this.atAny(TokenType.Operator, "(") && this.peek().range.start === tok.range.end) {
      const value = this.parseArrayLiteral();
      return {
        type: "Assignment",
        name,
        subscript,
        append,
        value,
        range: { start: tok.range.start, end: value.range.end },
      };
    }

    return {
      type: "Assignment",
      name,
      subscript,
      append,
      // The value starts after the `=`, so its parts are offset from the token
      value: rawValue.length > 0
        ? this.rawToCompoundWord(rawValue, { start: tok.range.start + eqIdx + 1, end: tok.range.end }, tok.range.start + eqIdx + 1)
        : null,
      range: tok.range,
    };
  }

  private parseArrayLiteral(): ArrayLiteral {
    const start = this.expect(TokenType.Operator, "(").range.start;
    const elements: CompoundWord[] = [];

    this.skipNewlines();
    while (!this.atAny(TokenType.Operator, ")")) {
      if (this.at(TokenType.EOF)) {
        throw new ParseError("Unterminated array assignment", this.peek());
      }
      // An element like `x=1` tokenizes as an Assignment; it is a word here
      elements.push(this.tokenToCompoundWord(this.advance()));
      this.skipNewlines();
    }

    const end = this.expect(TokenType.Operator, ")").range.end;
    return { type: "ArrayLiteral", elements, range: { start, end } };
  }

  // ── Redirections ───────────────────────────────────────────────

  private parseRedirect(): Redirect {
    const tok = this.expect(TokenType.Redirect);
    const op = tok.value;

    // Parse fd prefix
    let fd: number | null = null;
    let opPart = op;
    const fdMatch = op.match(/^(\d+)(.*)/);
    if (fdMatch) {
      fd = parseInt(fdMatch[1]!, 10);
      opPart = fdMatch[2]!;
    }

    // For heredoc, create a HereDoc target
    if (opPart === "<<" || opPart === "<<-") {
      const delimTok = this.expect(TokenType.Word);
      const quote = delimTok.value[0];
      const quoted = (quote === "'" || quote === '"') && delimTok.value.endsWith(quote) && delimTok.value.length >= 2;
      const target: HereDoc = {
        type: "HereDoc",
        delimiter: quoted ? delimTok.value.slice(1, -1) : delimTok.value,
        content: "",
        stripTabs: opPart === "<<-",
        quoted,
        range: { start: delimTok.range.start, end: delimTok.range.end },
      };
      this.pendingHereDocs.push(target);
      return {
        type: "Redirect",
        fd,
        op: opPart as any,
        target,
        range: { start: tok.range.start, end: delimTok.range.end },
      };
    }

    const targetTok = this.advance();
    return {
      type: "Redirect",
      fd,
      op: opPart as any,
      target: this.tokenToCompoundWord(targetTok),
      range: { start: tok.range.start, end: targetTok.range.end },
    };
  }

  // ── Compound commands ──────────────────────────────────────────

  /** Whether a `{` sits here, however the tokenizer classified it */
  private atBraceGroup(): boolean {
    const tok = this.peek();
    return tok.value === "{" && (tok.type === TokenType.Keyword || tok.type === TokenType.Operator);
  }

  /**
   * zsh's brace form: `if cond { … } elif cond { … } else { … }`. The braces
   * delimit the body, so there is no `then` to open it and no `fi` to close it.
   */
  private parseBraceIf(start: number, condition: Script): IfClause {
    const thenBody = this.wrapScript([this.parseBraceGroup()]);

    const elifs: { condition: Script; then: Script }[] = [];
    this.skipNewlines();
    while (this.atWord("elif")) {
      this.advance();
      this.skipNewlines();
      const elifCond = this.wrapScript(this.parseCompoundList(false, true));
      elifs.push({ condition: elifCond, then: this.wrapScript([this.parseBraceGroup()]) });
      this.skipNewlines();
    }

    let elseBody: Script | null = null;
    if (this.atWord("else")) {
      this.advance();
      this.skipNewlines();
      // `else { … }`, or `else if …` continuing the chain
      elseBody = this.wrapScript([this.atBraceGroup() ? this.parseBraceGroup() : this.parseCommand()]);
    }

    const redirects = this.parseTrailingRedirects();
    const end = this.lastEnd(start);

    return {
      type: "IfClause",
      condition,
      then: thenBody,
      elifs,
      else: elseBody,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseIf(): IfClause {
    const start = this.expect(TokenType.Keyword, "if").range.start;
    this.skipNewlines();
    const condition = this.wrapScript(this.parseCompoundList(false, this.dialect === "zsh"));

    // zsh writes the body in braces instead: `if (( x )) { … }`, with no `then`
    // and no `fi`. `else` may follow with braces of its own.
    if (this.dialect === "zsh" && !this.atWord("then") && this.atBraceGroup()) {
      return this.parseBraceIf(start, condition);
    }

    this.expectWord("then");
    this.skipNewlines();
    const thenBody = this.wrapScript(this.parseCompoundList());

    const elifs: { condition: Script; then: Script }[] = [];
    while (this.atWord("elif")) {
      this.advance();
      this.skipNewlines();
      const elifCond = this.wrapScript(this.parseCompoundList());
      this.expectWord("then");
      this.skipNewlines();
      const elifBody = this.wrapScript(this.parseCompoundList());
      elifs.push({ condition: elifCond, then: elifBody });
    }

    let elseBody: Script | null = null;
    if (this.atWord("else")) {
      this.advance();
      this.skipNewlines();
      elseBody = this.wrapScript(this.parseCompoundList());
    }

    const end = this.expectWord("fi").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "IfClause",
      condition,
      then: thenBody,
      elifs,
      else: elseBody,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  /**
   * `let expr [expr …]`, with the command name already consumed. Each argument
   * is arithmetic; wrapping quotes are removed first, since `let "i = 1"` and
   * `let i=1` mean the same thing.
   */
  private parseLetCommand(start: number, assignments: Assignment[], redirects: Redirect[]): LetCommand {
    const expressions: LetExpression[] = [];

    while (this.at(TokenType.Word) || this.at(TokenType.Assignment) || this.at(TokenType.Redirect)) {
      if (this.at(TokenType.Redirect)) {
        redirects.push(this.parseRedirect());
        continue;
      }

      const tok = this.advance();
      const { text, offset } = unwrapQuotes(tok.value);
      expressions.push({
        text,
        parsed: this.parseArithmeticText(text, tok.range.start + offset),
        range: tok.range,
      });
    }

    return {
      type: "LetCommand",
      assignments,
      expressions,
      redirects,
      range: { start, end: this.lastEnd(start) },
    };
  }

  private parseArithmeticCommand(): ArithmeticCommand {
    const tok = this.expect(TokenType.Arithmetic);
    const redirects = this.parseTrailingRedirects();

    return {
      type: "ArithmeticCommand",
      expression: tok.value,
      // +2 to step over the `((`
      parsed: this.parseArithmeticText(tok.value, tok.range.start + 2),
      redirects,
      range: {
        start: tok.range.start,
        end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : tok.range.end,
      },
    };
  }

  /**
   * `for (( init; condition; update ))`. Clauses split on top-level `;` — a
   * nested `;` cannot occur inside parens or quotes, both of which are skipped.
   */
  private parseArithmeticFor(start: number): ArithmeticForClause {
    const tok = this.expect(TokenType.Arithmetic);
    const clauses = splitArithmeticClauses(tok.value);
    const parseClause = (index: number): ArithmeticExpr | null => {
      const clause = clauses[index];
      return clause === undefined
        ? null
        : this.parseArithmeticText(clause.text, tok.range.start + 2 + clause.offset);
    };

    const init = parseClause(0);
    const condition = parseClause(1);
    const update = parseClause(2);

    if (this.atAny(TokenType.Operator, ";")) this.advance();
    this.skipNewlines();
    this.expectWord("do");
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    const end = this.expectWord("done").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "ArithmeticForClause",
      init,
      condition,
      update,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseFor(): ForClause | ArithmeticForClause {
    const start = this.expect(TokenType.Keyword, "for").range.start;

    if (this.at(TokenType.Arithmetic)) {
      return this.parseArithmeticFor(start);
    }

    const variables = [this.expect(TokenType.Word).value];

    // zsh deals the words out between several variables: `for k v in a b c d`
    while (this.dialect === "zsh" && this.at(TokenType.Word) && this.peek().value !== "in") {
      variables.push(this.advance().value);
    }

    let words: CompoundWord[] | null = null;
    this.skipNewlines();
    if (this.peek().value === "in" && (this.at(TokenType.Keyword) || this.at(TokenType.Word))) {
      this.advance();
      words = [];
      while (this.at(TokenType.Word)) {
        words.push(this.tokenToCompoundWord(this.advance()));
      }
    } else if (this.dialect === "zsh" && this.atAny(TokenType.Operator, "(")) {
      // zsh gives the list in parens instead: `for x (a b) …`
      words = this.parseParenWordList();
    }

    // Skip optional ; or newline before do
    if (this.atAny(TokenType.Operator, ";")) this.advance();
    this.skipNewlines();

    return this.parseForBody(start, variables, words);
  }

  /** zsh's parenthesised word list: `for x (a b) …` */
  private parseParenWordList(): CompoundWord[] {
    this.expect(TokenType.Operator, "(");

    const words: CompoundWord[] = [];
    this.skipNewlines();
    while (!this.atAny(TokenType.Operator, ")")) {
      if (this.at(TokenType.EOF)) {
        throw new ParseError("Unterminated for-loop word list", this.peek());
      }
      words.push(this.tokenToCompoundWord(this.advance()));
      this.skipNewlines();
    }

    this.expect(TokenType.Operator, ")");
    return words;
  }

  /**
   * The body, once the word list is read. Normally `do … done`; zsh also takes
   * a single command in its place, whichever way the list was written, so
   * `for x (a b) cmd` and `for x in a b<newline>cmd` both end up here. The short
   * form means what the long one means, so both land on the same node.
   */
  private parseForBody(start: number, variables: string[], words: CompoundWord[] | null): ForClause {
    if (this.dialect === "zsh" && !this.atWord("do")) {
      const body = this.wrapScript([this.parseCommand()]);
      const redirects = this.parseTrailingRedirects();
      const last = redirects[redirects.length - 1];
      return {
        type: "ForClause",
        variables,
        words,
        body,
        redirects,
        range: { start, end: last ? last.range.end : body.range.end },
      };
    }

    this.expectWord("do");
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    const end = this.expectWord("done").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "ForClause",
      variables,
      words,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  /**
   * zsh's counted loop: `repeat 3 do … done`, or `repeat $n { … }`. The count is
   * a word rather than a number, since the shell expands it first.
   */
  private parseRepeat(): RepeatClause {
    const start = this.expect(TokenType.Keyword, "repeat").range.start;
    const count = this.tokenToCompoundWord(this.advance());

    if (this.atAny(TokenType.Operator, ";")) this.advance();
    this.skipNewlines();

    let body: Script;
    let end: number;
    if (this.atWord("do")) {
      this.advance();
      this.skipNewlines();
      body = this.wrapScript(this.parseCompoundList());
      end = this.expectWord("done").range.end;
    } else {
      body = this.wrapScript([this.parseCommand()]);
      end = body.range.end;
    }

    const redirects = this.parseTrailingRedirects();
    return {
      type: "RepeatClause",
      count,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseWhile(): WhileClause {
    const start = this.expect(TokenType.Keyword, "while").range.start;
    this.skipNewlines();
    const condition = this.wrapScript(this.parseCompoundList());
    this.expectWord("do");
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    const end = this.expectWord("done").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "WhileClause",
      condition,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseUntil(): UntilClause {
    const start = this.expect(TokenType.Keyword, "until").range.start;
    this.skipNewlines();
    const condition = this.wrapScript(this.parseCompoundList());
    this.expectWord("do");
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    const end = this.expectWord("done").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "UntilClause",
      condition,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseCase(): CaseClause {
    const start = this.expect(TokenType.Keyword, "case").range.start;
    const wordTok = this.advance();
    const word = this.tokenToCompoundWord(wordTok);
    this.skipNewlines();
    // "in" may be tokenized as Word or Keyword depending on context
    const inTok = this.peek();
    if (inTok.value !== "in") {
      throw new ParseError('Expected "in"', inTok);
    }
    this.advance();
    this.skipNewlines();

    const items: CaseItem[] = [];
    while (!this.atWord("esac")) {
      if (this.at(TokenType.EOF)) break;
      items.push(this.parseCaseItem());
      this.skipNewlinesAndSemicolons();
    }

    const end = this.expectWord("esac").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "CaseClause",
      word,
      items,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  /**
   * Whether the `(` at the cursor opens a group inside the pattern rather than
   * the case item. Scan to its match: if the next token starts where that `)`
   * ends, with no space between, the two are one word and so is the pattern.
   */
  private parenBelongsToPattern(): boolean {
    let depth = 0;

    for (let i = this.pos; i < this.tokens.length; i++) {
      const tok = this.tokens[i]!;
      if (tok.type !== TokenType.Operator) continue;

      if (tok.value === "(") depth++;
      else if (tok.value === ")") {
        depth--;
        if (depth === 0) {
          const next = this.tokens[i + 1];
          return next !== undefined && next.range.start === tok.range.end && next.type !== TokenType.Newline;
        }
      }
    }

    return false;
  }

  /**
   * One case pattern, however many tokens the tokenizer made of it. A pattern
   * runs to the `|` that starts the next alternative or the `)` that ends the
   * list, and in between it may hold a group — `(scalar|integer)*` — or even an
   * unquoted space, as in `(*# SKIP*)`. Gaps are refilled so the text still
   * lines up with the source it came from.
   */
  private parsePatternWord(): CompoundWord {
    const start = this.peek().range.start;
    let text = "";
    let end = start;
    let depth = 0;

    while (!this.at(TokenType.EOF) && !this.at(TokenType.Newline)) {
      const tok = this.peek();
      const operator = tok.type === TokenType.Operator;

      if (depth === 0 && operator && (tok.value === ")" || tok.value === "|") && text !== "") break;

      if (operator && tok.value === "(") depth++;
      else if (operator && tok.value === ")") depth--;

      if (text !== "" && tok.range.start > end) text += " ".repeat(tok.range.start - end);
      text += tok.value;
      end = tok.range.end;
      this.advance();
    }

    return this.rawToCompoundWord(text, { start, end }, start);
  }

  private parseCaseItem(): CaseItem {
    const start = this.peek().range.start;

    // Optional leading `(`. It may instead belong to the pattern, as in
    // `(scalar|integer)*)` — what tells them apart is the space: a pattern is
    // one word, so its closing `)` is followed immediately by more of it,
    // while the item's `)` is followed by the body.
    const grouped = this.atAny(TokenType.Operator, "(") && this.parenBelongsToPattern();
    if (this.atAny(TokenType.Operator, "(") && !grouped) {
      this.advance();
    }

    const patterns: CompoundWord[] = [this.parsePatternWord()];

    while (this.atAny(TokenType.Operator, "|")) {
      this.advance();
      patterns.push(this.parsePatternWord());
    }

    this.expect(TokenType.Operator, ")");
    this.skipNewlines();

    const commands = this.parseCompoundList();
    const body = this.wrapScript(commands);

    let terminator: CaseItem["terminator"] = null;
    if (this.atAny(TokenType.Operator, ";;", ";&", ";;&", ";|")) {
      terminator = this.advance().value as CaseItem["terminator"];
    }

    const end = this.lastEnd(start);

    return {
      type: "CaseItem",
      patterns,
      body,
      terminator,
      range: { start, end },
    };
  }

  private parseSubshell(): Subshell {
    const start = this.expect(TokenType.Operator, "(").range.start;
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    const end = this.expect(TokenType.Operator, ")").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "Subshell",
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseBraceGroup(): BraceGroup {
    const start = this.expectWord("{").range.start;
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    let end = this.expectWord("}").range.end;

    // zsh: `{ … } always { … }` runs the second group either way, so the two
    // belong to one command rather than reading as a stray `always`
    let always: Script | null = null;
    if (this.dialect === "zsh" && this.atWord("always")) {
      this.advance();
      this.skipNewlines();
      this.expectWord("{");
      this.skipNewlines();
      always = this.wrapScript(this.parseCompoundList());
      end = this.expectWord("}").range.end;
    }

    const redirects = this.parseTrailingRedirects();

    return {
      type: "BraceGroup",
      body,
      always,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseDoubleSquareBracket(): TestCommand {
    const start = this.expectWord("[[").range.start;
    this.skipNewlines();
    const expression = this.atWord("]]") || this.at(TokenType.EOF) ? null : this.parseTestOr();

    // `]]` closes the condition and is not optional. Accepting its absence
    // turned an unterminated `[[` into a tree that silently dropped operands.
    this.expectWord("]]");
    const redirects = this.parseTrailingRedirects();

    return {
      type: "TestCommand",
      style: "[[",
      expression,
      assignments: [],
      redirects,
      range: { start, end: this.lastEnd(start) },
    };
  }

  /**
   * `[ … ]` and `test …`, with the command name already consumed.
   *
   * Unlike `[[ … ]]` this is an ordinary command: its operands are words the
   * shell expands, `-a` and `-o` do the joining, and grouping parens have to be
   * quoted or escaped to survive. So the operands are collected first and the
   * expression is read from the resolved words, letting `\(` and `'('` both
   * count as a group.
   */
  private parseBracketTest(
    start: number,
    style: "[" | "test",
    assignments: Assignment[],
    redirects: Redirect[],
  ): TestCommand {
    const operands: CompoundWord[] = [];

    while (this.at(TokenType.Word) || this.at(TokenType.Redirect)) {
      if (this.at(TokenType.Redirect)) {
        // `[ a < b ]` really does redirect — the shell reads it that way too
        redirects.push(this.parseRedirect());
        continue;
      }
      if (style === "[" && this.atWord("]")) break;
      operands.push(this.tokenToCompoundWord(this.advance()));
    }

    if (style === "[" && this.atWord("]")) this.advance();
    redirects.push(...this.parseTrailingRedirects());

    const cursor = { index: 0 };
    const expression = operands.length === 0 ? null : this.parseBracketOr(operands, cursor);

    return {
      type: "TestCommand",
      style,
      expression,
      assignments,
      redirects,
      range: { start, end: this.lastEnd(start) },
    };
  }

  private parseBracketOr(words: CompoundWord[], cursor: { index: number }): TestExpr {
    let left = this.parseBracketAnd(words, cursor);

    while (literalValue(words[cursor.index]) === "-o") {
      cursor.index++;
      const right = this.parseBracketAnd(words, cursor);
      left = { type: "TestLogical", op: "-o", left, right, range: { start: left.range.start, end: right.range.end } };
    }

    return left;
  }

  private parseBracketAnd(words: CompoundWord[], cursor: { index: number }): TestExpr {
    let left = this.parseBracketNegation(words, cursor);

    while (literalValue(words[cursor.index]) === "-a") {
      cursor.index++;
      const right = this.parseBracketNegation(words, cursor);
      left = { type: "TestLogical", op: "-a", left, right, range: { start: left.range.start, end: right.range.end } };
    }

    return left;
  }

  private parseBracketNegation(words: CompoundWord[], cursor: { index: number }): TestExpr {
    const word = words[cursor.index];
    if (literalValue(word) !== "!") return this.parseBracketPrimary(words, cursor);

    cursor.index++;
    const operand = this.parseBracketNegation(words, cursor);
    return { type: "TestNegation", operand, range: { start: word!.range.start, end: operand.range.end } };
  }

  private parseBracketPrimary(words: CompoundWord[], cursor: { index: number }): TestExpr {
    const word = words[cursor.index];
    if (word === undefined) {
      const last = words[words.length - 1];
      const empty: CompoundWord = { type: "CompoundWord", parts: [], range: last?.range ?? { start: 0, end: 0 } };
      return { type: "TestValue", word: empty, range: empty.range };
    }

    if (literalValue(word) === "(") {
      cursor.index++;
      const inner = this.parseBracketOr(words, cursor);
      if (literalValue(words[cursor.index]) === ")") cursor.index++;
      return inner;
    }

    cursor.index++;
    const op = literalValue(word);

    if (op !== null && TEST_UNARY_OPS.has(op) && cursor.index < words.length &&
        !isBracketKeyword(words[cursor.index])) {
      const operand = words[cursor.index++]!;
      return { type: "TestUnary", op, operand, range: { start: word.range.start, end: operand.range.end } };
    }

    const next = literalValue(words[cursor.index]);
    if (next !== null && TEST_BINARY_OPS.has(next) && cursor.index + 1 < words.length) {
      cursor.index++;
      const right = words[cursor.index++]!;
      return {
        type: "TestBinary",
        op: next,
        left: word,
        right,
        // Never a regex: the builtin has no `=~`, only the `[[ … ]]` keyword does
        regex: null,
        range: { start: word.range.start, end: right.range.end },
      };
    }

    return { type: "TestValue", word, range: word.range };
  }

  // ── Test expressions: || binds loosest, then &&, then ! ────────

  private parseTestOr(): TestExpr {
    let left = this.parseTestAnd();

    this.skipNewlines();
    while (this.atAny(TokenType.Operator, "||")) {
      this.advance();
      this.skipNewlines();
      const right = this.parseTestAnd();
      left = { type: "TestLogical", op: "||", left, right, range: { start: left.range.start, end: right.range.end } };
      this.skipNewlines();
    }

    return left;
  }

  private parseTestAnd(): TestExpr {
    let left = this.parseTestNegation();

    // A condition may break across lines, so a comment can sit between an
    // operand and the operator that joins it. Inside `[[ … ]]` the tokenizer
    // emits no newlines, so this only ever collects comments.
    this.skipNewlines();
    while (this.atAny(TokenType.Operator, "&&")) {
      this.advance();
      this.skipNewlines();
      const right = this.parseTestNegation();
      left = { type: "TestLogical", op: "&&", left, right, range: { start: left.range.start, end: right.range.end } };
      this.skipNewlines();
    }

    return left;
  }

  private parseTestNegation(): TestExpr {
    if (!this.atWord("!")) return this.parseTestPrimary();

    const start = this.advance().range.start;
    const operand = this.parseTestNegation();
    return { type: "TestNegation", operand, range: { start, end: operand.range.end } };
  }

  private parseTestPrimary(): TestExpr {
    if (this.atAny(TokenType.Operator, "(")) {
      this.advance();
      const inner = this.parseTestOr();
      if (this.atAny(TokenType.Operator, ")")) this.advance();
      return inner;
    }

    const tok = this.advance();
    const word = this.tokenToCompoundWord(tok);

    // `-f file` — a unary operator only when an operand actually follows
    if (TEST_UNARY_OPS.has(tok.value) && this.startsTestOperand()) {
      const operand = this.tokenToCompoundWord(this.advance());
      return { type: "TestUnary", op: tok.value, operand, range: { start: tok.range.start, end: operand.range.end } };
    }

    const opTok = this.peek();
    const isBinary = (opTok.type === TokenType.Word && TEST_BINARY_OPS.has(opTok.value)) ||
      (opTok.type === TokenType.Operator && (opTok.value === "<" || opTok.value === ">"));

    if (isBinary) {
      this.advance();

      // `[[ $s =~ ]]` has no operand; the closing `]]` is not one
      const rightTok = this.atWord("]]") || this.at(TokenType.EOF) ? null : this.advance();
      const right = rightTok === null
        ? { type: "CompoundWord" as const, parts: [], range: { start: opTok.range.end, end: opTok.range.end } }
        : this.tokenToCompoundWord(rightTok);

      return {
        type: "TestBinary",
        op: opTok.value,
        left: word,
        right,
        // The operand's parts were split as a glob, so the pattern is read from
        // the token text instead
        regex: rightTok !== null && opTok.value === "=~"
          ? this.parseRegexText(rightTok.value, rightTok.range.start)
          : null,
        range: { start: tok.range.start, end: right.range.end },
      };
    }

    return { type: "TestValue", word, range: tok.range };
  }

  /** Whether the next token is a word an operator could act on */
  private startsTestOperand(): boolean {
    const tok = this.peek();
    if (tok.type !== TokenType.Word) return false;
    return !TEST_BINARY_OPS.has(tok.value);
  }

  // ── Functions ──────────────────────────────────────────────────

  private parseFunctionDef(): FunctionDef {
    const start = this.peek().range.start;
    const nameTok = this.advance();
    this.definedFunctions.add(nameTok.value);
    this.advance(); // (
    this.advance(); // )
    this.skipNewlines();
    const body = this.parseCommand();
    const redirects = this.parseTrailingRedirects();

    return {
      type: "FunctionDef",
      name: nameTok.value,
      body,
      args: [],
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : body.range.end },
    };
  }

  private parseFunctionKeyword(): FunctionDef {
    const start = this.expect(TokenType.Keyword, "function").range.start;

    // zsh: `function { … }` defines nothing and runs the body at once, so there
    // is no name to bind. Any words after the body are its positional arguments.
    const anonymous = this.dialect === "zsh" && !this.at(TokenType.Word);
    const nameTok = anonymous ? null : this.expect(TokenType.Word);
    if (nameTok) this.definedFunctions.add(nameTok.value);

    // Optional ()
    if (this.atAny(TokenType.Operator, "(")) {
      this.advance();
      this.expect(TokenType.Operator, ")");
    }

    this.skipNewlines();
    const body = this.parseCommand();
    const args = anonymous ? this.parseWordList() : [];
    const redirects = this.parseTrailingRedirects();

    const last = redirects[redirects.length - 1] ?? args[args.length - 1];
    return {
      type: "FunctionDef",
      name: nameTok?.value ?? null,
      body,
      args,
      redirects,
      range: { start, end: last ? last.range.end : body.range.end },
    };
  }

  /** Plain words up to the end of the command, for an anonymous function's args */
  private parseWordList(): CompoundWord[] {
    const words: CompoundWord[] = [];
    while (this.at(TokenType.Word) || this.at(TokenType.Assignment)) {
      words.push(this.tokenToCompoundWord(this.advance()));
    }
    return words;
  }

  private parseCoproc(): Coproc {
    const start = this.expect(TokenType.Keyword, "coproc").range.start;

    let name: string | null = null;
    // Check if next token is a name (not a keyword that starts a command)
    if (this.at(TokenType.Word)) {
      const next = this.tokens[this.pos + 1];
      // `{` after a name is an Operator, not a Keyword — match on value
      if (next && (next.value === "{" ||
          (next.type === TokenType.Keyword && ["while", "for", "if", "until", "case"].includes(next.value)))) {
        name = this.advance().value;
      }
    }

    this.skipNewlines();
    const body = this.parseCommand();
    const redirects = this.parseTrailingRedirects();

    return {
      type: "Coproc",
      name,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : body.range.end },
    };
  }

  // ── Utilities ──────────────────────────────────────────────────

  private parseTrailingRedirects(): Redirect[] {
    const redirects: Redirect[] = [];
    while (this.at(TokenType.Redirect)) {
      redirects.push(this.parseRedirect());
    }
    return redirects;
  }

  private tokenToCompoundWord(tok: Token): CompoundWord {
    const parts = this.parseWordParts(tok.value, tok.range);
    return {
      type: "CompoundWord",
      parts,
      range: tok.range,
    };
  }

  private rawToCompoundWord(raw: string, range: Range, offset: number = range.start): CompoundWord {
    const parts = this.parseWordParts(raw, range, offset);
    return {
      type: "CompoundWord",
      parts,
      range,
    };
  }

  /**
   * Break a raw token string into WordParts (expansions, quotes, literals).
   *
   * `offset` is the absolute source position of `raw[0]`, which is not always
   * the start of the token: an assignment passes only the text after the `=`.
   *
   * Quoting is tracked as it scans, because it decides what is an expansion at
   * all: `'$(rm -rf /)'` is inert text, not a command substitution.
   */
  private parseWordParts(raw: string, range: Range, offset: number = range.start): WordPart[] {
    const parts: WordPart[] = [];
    let i = 0;
    let literal = "";
    let literalStart = 0;
    let quote: QuoteContext = null;
    /** how many parts existed when the current quote opened */
    let partsAtQuoteOpen = 0;

    const at = (start: number, end: number): Range => ({ start: offset + start, end: offset + end });

    const addLiteral = (text: string, from: number) => {
      if (literal.length === 0) literalStart = from;
      literal += text;
    };

    const flushLiteral = (end: number) => {
      if (literal.length > 0) {
        parts.push({ type: "Word", value: literal, quoted: quote, range: at(literalStart, end) });
        literal = "";
      }
    };

    while (i < raw.length) {
      const ch = raw[i]!;

      // ── Quote transitions ──
      if (quote === null && (ch === "'" || ch === '"')) {
        flushLiteral(i);
        quote = ch === "'" ? "single" : "double";
        partsAtQuoteOpen = parts.length;
        literalStart = i + 1;
        i++;
        continue;
      }

      if (quote !== null && ch === (quote === "single" ? "'" : '"')) {
        // `''` and `""` are an empty word, but `"$X"` is just the expansion
        if (literal.length === 0 && parts.length === partsAtQuoteOpen) {
          parts.push({ type: "Word", value: "", quoted: quote, range: at(literalStart - 1, i + 1) });
        }
        flushLiteral(i);
        quote = null;
        i++;
        continue;
      }

      // Inside single quotes nothing is special — not even a backslash
      if (quote === "single") {
        addLiteral(ch, i);
        i++;
        continue;
      }

      // ── $'…' (escapes resolved) and $"…" (a double-quoted string) ──
      if (quote === null && ch === "$" && (raw[i + 1] === "'" || raw[i + 1] === '"')) {
        flushLiteral(i);
        if (raw[i + 1] === "'") {
          const { value, next } = readAnsiCString(raw, i + 2);
          parts.push({ type: "Word", value, quoted: "single", range: at(i, next) });
          i = next;
        } else {
          quote = "double";
          partsAtQuoteOpen = parts.length;
          literalStart = i + 2;
          i += 2;
        }
        continue;
      }

      // ── Backslash escapes ──
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === undefined) {
          addLiteral(ch, i);
          i++;
        } else if (quote === "double") {
          // Only these five are escapable in double quotes; elsewhere the
          // backslash is an ordinary character
          if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
            addLiteral(next, i);
            i += 2;
          } else {
            addLiteral(ch, i);
            i++;
          }
        } else if (next === "\n") {
          i += 2; // line continuation: both characters vanish
        } else {
          addLiteral(next, i);
          i += 2;
        }
        continue;
      }

      if (ch === "$" && i + 1 < raw.length) {
        flushLiteral(i);
        const next = raw[i + 1]!;

        const start = i;

        if (next === "{") {
          // ${...}
          const { body: expr, next: after } = readDelimited(raw, i + 1, "{", "}");
          i = after;
          parts.push({
            type: "VariableExpansion",
            expression: expr,
            braced: true,
            quoted: quote,
            range: at(start, i),
          });
        } else if (next === "(") {
          if (i + 2 < raw.length && raw[i + 2] === "(") {
            // $(( arithmetic ))
            const exprStart = i + 3;
            const { body: expr, next: after } = readDelimited(raw, i + 2, "(", ")", 2);
            i = after;
            parts.push({
              type: "ArithmeticExpansion",
              expression: expr,
              parsed: this.parseArithmeticText(expr, offset + exprStart),
              quoted: quote,
              range: at(start, i),
            });
          } else {
            // $( command substitution )
            const bodyStart = i + 2;
            const { body, next: after } = readParenBody(raw, i + 1);
            i = after;
            parts.push({
              type: "CommandSubstitution",
              backtick: false,
              body: this.parseSubstitution(body, offset + bodyStart),
              quoted: quote,
              range: at(start, i),
            });
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          i++;
          let name = "";
          while (i < raw.length && /[a-zA-Z0-9_]/.test(raw[i]!)) {
            name += raw[i];
            i++;
          }

          // zsh subscripts without braces: `$arg[2]` and the slice `$arg[0,1]`
          // are the expansion, where bash would read a glob bracket after it
          if (this.dialect === "zsh" && raw[i] === "[") {
            const close = findBracketClose(raw, i);
            if (close !== -1) {
              name += raw.slice(i, close + 1);
              i = close + 1;
            }
          }

          parts.push({
            type: "VariableExpansion",
            expression: name,
            braced: false,
            quoted: quote,
            range: at(start, i),
          });
        } else if (this.dialect === "zsh" && next === "#" && /[a-zA-Z_]/.test(raw[i + 2] ?? "")) {
          // zsh: `$#arg` is the length of `arg`, not `$#` followed by a word
          i += 2;
          let name = "#";
          while (i < raw.length && /[a-zA-Z0-9_]/.test(raw[i]!)) {
            name += raw[i];
            i++;
          }
          parts.push({
            type: "VariableExpansion",
            expression: name,
            braced: false,
            quoted: quote,
            range: at(start, i),
          });
        } else if (/[0-9!?#$@*\-]/.test(next)) {
          i += 2;
          parts.push({
            type: "VariableExpansion",
            expression: next,
            braced: false,
            quoted: quote,
            range: at(start, i),
          });
        } else {
          addLiteral(ch, i);
          i++;
        }
      } else if (quote === null && ch === "{" && readBraceExpansion(raw, i) !== null) {
        // `{a,b}` and `{0..9}` — the shell writes out one copy of the word per
        // item, so this is neither a glob nor an expansion of a variable
        const brace = readBraceExpansion(raw, i)!;
        flushLiteral(i);
        const start = i;
        const bodyStart = i + 1;
        i = brace.end;

        const sequence = brace.commas.length === 0 ? readBraceSequence(brace.body) : null;
        if (sequence) {
          parts.push({
            type: "BraceExpansion",
            kind: "sequence",
            value: raw.slice(start, i),
            ...sequence,
            range: at(start, i),
          });
        } else {
          // Split on the top-level commas already found, so a nested `{x,y}`
          // stays inside its item
          const bounds = [bodyStart - 1, ...brace.commas, i - 1];
          const items = bounds.slice(0, -1).map((from, index) => {
            const itemStart = from + 1;
            const text = raw.slice(itemStart, bounds[index + 1]!);
            return this.rawToCompoundWord(text, at(itemStart, itemStart + text.length), offset + itemStart);
          });
          parts.push({
            type: "BraceExpansion",
            kind: "list",
            value: raw.slice(start, i),
            items,
            range: at(start, i),
          });
        }
      } else if (quote === null && this.dialect === "zsh" && ch === "(" && isQualifierGroup(raw, i)) {
        // zsh glob qualifier: `bin(N)`, `*(-/FN)` — it selects among what the
        // pattern matched rather than matching text of its own
        flushLiteral(i);
        const start = i;
        const close = matchingParen(raw, i);
        i = close;
        parts.push({
          type: "GlobPattern",
          kind: "qualifier",
          value: raw.slice(start, i),
          qualifiers: raw.slice(start + 1, i - 1),
          range: at(start, i),
        });
      } else if (quote === null && this.dialect === "zsh" && ch === "<" && readNumericRange(raw, i) !== null) {
        // zsh numeric range: `<1->` matches a number, not a redirect
        const parsed = readNumericRange(raw, i)!;
        flushLiteral(i);
        const start = i;
        i = parsed.end;
        parts.push({
          type: "GlobPattern",
          kind: "numeric-range",
          value: raw.slice(start, i),
          min: parsed.min,
          max: parsed.max,
          range: at(start, i),
        });
      } else if (quote === null && this.dialect === "zsh" && ch === "(" && matchingParen(raw, i) !== -1) {
        // zsh bare group: `(a|b)` is what bash writes `@(a|b)`, so it carries
        // no operator
        flushLiteral(i);
        const start = i;
        const bodyStart = i + 1;
        const close = matchingParen(raw, i);
        const body = raw.slice(bodyStart, close - 1);
        i = close;
        parts.push({
          type: "GlobPattern",
          kind: "extended",
          value: raw.slice(start, i),
          op: null,
          alternatives: splitAlternatives(body).map(alternative =>
            this.rawToCompoundWord(
              alternative.text,
              at(bodyStart + alternative.offset, bodyStart + alternative.offset + alternative.text.length),
              offset + bodyStart + alternative.offset,
            ),
          ),
          range: at(start, i),
        });
      } else if (quote === null && EXTGLOB_LEADS.includes(ch) && raw[i + 1] === "(" &&
                 !(this.dialect === "zsh" && isQualifierGroup(raw, i + 1))) {
        // Extended glob: ?(a|b), *(…), +(…), @(…), !(…)
        flushLiteral(i);
        const start = i;
        const bodyStart = i + 2;
        const { body, next } = readDelimited(raw, i + 1, "(", ")");
        i = next;
        parts.push({
          type: "GlobPattern",
          kind: "extended",
          value: raw.slice(start, i),
          op: ch as "?" | "*" | "+" | "@" | "!",
          // Each alternative is a word, so expansions and nested globs inside
          // it become nodes rather than text
          alternatives: splitAlternatives(body).map(alternative =>
            this.rawToCompoundWord(
              alternative.text,
              at(bodyStart + alternative.offset, bodyStart + alternative.offset + alternative.text.length),
              offset + bodyStart + alternative.offset,
            ),
          ),
          range: at(start, i),
        });
      } else if (quote === null && (ch === "*" || ch === "?")) {
        // Glob metacharacters only glob unquoted — "*.ts" is a literal filename
        flushLiteral(i);
        parts.push({ type: "GlobPattern", kind: "wildcard", value: ch, range: at(i, i + 1) });
        i++;
      } else if (quote === null && ch === "[" && findBracketClose(raw, i) !== -1) {
        const close = findBracketClose(raw, i);
        flushLiteral(i);
        const negated = raw[i + 1] === "!" || raw[i + 1] === "^";
        const innerStart = i + 1 + (negated ? 1 : 0);
        parts.push({
          type: "GlobPattern",
          kind: "bracket",
          value: raw.slice(i, close + 1),
          negated,
          members: parseBracketMembers(raw.slice(innerStart, close), offset + innerStart),
          range: at(i, close + 1),
        });
        i = close + 1;
      } else if (quote === null && (ch === "<" || ch === ">") && raw[i + 1] === "(") {
        // <(cmd) / >(cmd) process substitution — never inside quotes
        flushLiteral(i);
        const start = i;
        const bodyStart = i + 2;
        const { body, next } = readParenBody(raw, i + 1);
        i = next;
        parts.push({
          type: "ProcessSubstitution",
          direction: ch,
          body: this.parseSubstitution(body, offset + bodyStart),
          range: at(start, i),
        });
      } else if (ch === "`") {
        flushLiteral(i);
        const start = i;
        i++;
        const bodyStart = i;
        let body = "";
        while (i < raw.length && raw[i] !== "`") {
          if (raw[i] === "\\") { body += raw[i]!; i++; if (i < raw.length) { body += raw[i]!; i++; } }
          else { body += raw[i]; i++; }
        }
        if (i < raw.length) i++;
        parts.push({
          type: "CommandSubstitution",
          backtick: true,
          // Inside backticks, \` \$ \\ stand for the bare character
          body: this.parseSubstitution(body.replace(/\\([$`\\])/g, "$1"), offset + bodyStart),
          quoted: quote,
          range: at(start, i),
        });
      } else {
        addLiteral(ch, i);
        i++;
      }
    }

    flushLiteral(i);

    if (parts.length === 0) {
      parts.push({ type: "Word", value: "", quoted: null, range });
    }

    return parts;
  }

  /** Parse the operand of `=~` as an extended regular expression */
  private parseRegexText(text: string, offset: number): RegexNode | null {
    return parseRegex(text, offset, {
      readExpansion: (raw, pos) => this.readExpansionPart(raw, pos, offset),
      readBracket: (raw, pos) => {
        const close = findBracketClose(raw, pos);
        if (close === -1) return null;

        const negated = raw[pos + 1] === "!" || raw[pos + 1] === "^";
        const innerStart = pos + 1 + (negated ? 1 : 0);
        return {
          negated,
          members: parseBracketMembers(raw.slice(innerStart, close), offset + innerStart),
          next: close + 1,
        };
      },
    });
  }

  /** Resolve a `$…` expansion inside embedded syntax into a real word part */
  private readExpansionPart(raw: string, pos: number, offset: number): { part: WordPart; next: number } | null {
    const extent = readExpansionExtent(raw, pos);
    if (extent === null) return null;

    const range = { start: offset + pos, end: offset + extent };
    const part = this.parseWordParts(raw.slice(pos, extent), range, offset + pos)[0];

    return part === undefined ? null : { part, next: extent };
  }

  /**
   * Parse arithmetic text, resolving any `$…` operands through the same word
   * machinery the rest of the parser uses, so `$(( $(f) + 1 ))` keeps a real
   * `CommandSubstitution` rather than a string.
   */
  private parseArithmeticText(text: string, offset: number): ArithmeticExpr | null {
    return parseArithmetic(text, offset, (raw, pos) => this.readExpansionPart(raw, pos, offset));
  }

  /**
   * Parse the inside of a `$(...)` or backtick substitution as its own script.
   * Ranges come out relative to the captured text, so shift them onto the
   * absolute source offset the body started at.
   */
  private parseSubstitution(body: string, offset: number): Script {
    // The dialect carries into the substitution: `$(…)` inside a zsh script is
    // still zsh
    const options = { dialect: this.dialect };
    const script = new Parser(tokenize(body, options), options).parse();
    shiftRanges(script, offset);
    return script;
  }

  private wrapScript(commands: Command[]): Script {
    const start = commands.length > 0 ? commands[0]!.range.start : 0;
    const end = commands.length > 0 ? commands[commands.length - 1]!.range.end : 0;
    return {
      type: "Script",
      commands,
      comments: [],
      range: { start, end },
    };
  }

  private lastEnd(fallback: number): number {
    if (this.pos > 0) {
      return this.tokens[this.pos - 1]!.range.end;
    }
    return fallback;
  }
}

export function parse(tokens: Token[], options: ParseOptions = {}): Script {
  return new Parser(tokens, options).parse();
}
