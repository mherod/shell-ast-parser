import type {
  Script, Command, SimpleCommand, Pipeline, ListItem,
  CompoundWord, WordPart, Redirect, HereDoc, Assignment, ArrayLiteral, Range, QuoteContext,
  IfClause, ForClause, ArithmeticForClause, ArithmeticCommand, ArithmeticExpr,
  LetCommand, LetExpression, TestCommand, TestExpr,
  WhileClause, UntilClause, CaseClause, CaseItem,
  Subshell, BraceGroup, FunctionDef, Comment, Coproc,
} from "./ast.ts";
import { tokenize, readHereDocHeader, skipHereDocBodies, readExpansionExtent, splitArithmeticClauses, EXTGLOB_LEADS, type Token, TokenType } from "./tokenizer.ts";
import { parseArithmetic } from "./arithmetic.ts";

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
    if (raw[i] === "]") return i;
    i++;
  }

  return -1;
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

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Script {
    const start = this.peek().range.start;
    const commands = this.parseCompoundList(true);
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

  private parseCompoundList(_topLevel: boolean = false): Command[] {
    const commands: Command[] = [];
    this.skipNewlinesAndSemicolons();

    while (!this.at(TokenType.EOF) && !this.isListTerminator()) {
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
    return this.atAny(TokenType.Operator, ")", ";;", ";&", ";;&", "}");
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

    if (this.atAny(TokenType.Keyword, "!")) {
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

  private parseSimpleCommandOrFunctionDef(): SimpleCommand | FunctionDef | LetCommand {
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

    // `let` evaluates each argument as arithmetic — the builtin spelling of
    // `(( … ))`. A function of the same name would shadow it, which is not
    // tracked here.
    if (name.parts.length === 1 && name.parts[0]!.type === "Word" && name.parts[0]!.value === "let") {
      return this.parseLetCommand(start, assignments, redirects);
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

  private parseIf(): IfClause {
    const start = this.expect(TokenType.Keyword, "if").range.start;
    this.skipNewlines();
    const condition = this.wrapScript(this.parseCompoundList());
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

    const varTok = this.expect(TokenType.Word);
    const variable = varTok.value;

    let words: CompoundWord[] | null = null;
    this.skipNewlines();
    if (this.peek().value === "in" && (this.at(TokenType.Keyword) || this.at(TokenType.Word))) {
      this.advance();
      words = [];
      while (this.at(TokenType.Word)) {
        words.push(this.tokenToCompoundWord(this.advance()));
      }
    }

    // Skip optional ; or newline before do
    if (this.atAny(TokenType.Operator, ";")) this.advance();
    this.skipNewlines();
    this.expectWord("do");
    this.skipNewlines();
    const body = this.wrapScript(this.parseCompoundList());
    const end = this.expectWord("done").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "ForClause",
      variable,
      words,
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

  private parseCaseItem(): CaseItem {
    const start = this.peek().range.start;

    // Optional leading (
    if (this.atAny(TokenType.Operator, "(")) this.advance();

    const patterns: CompoundWord[] = [];
    patterns.push(this.tokenToCompoundWord(this.advance()));

    while (this.atAny(TokenType.Operator, "|")) {
      this.advance();
      patterns.push(this.tokenToCompoundWord(this.advance()));
    }

    this.expect(TokenType.Operator, ")");
    this.skipNewlines();

    const commands = this.parseCompoundList();
    const body = this.wrapScript(commands);

    let terminator: ";;" | ";&" | ";;&" | null = null;
    if (this.atAny(TokenType.Operator, ";;", ";&", ";;&")) {
      terminator = this.advance().value as ";;" | ";&" | ";;&";
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
    const end = this.expectWord("}").range.end;
    const redirects = this.parseTrailingRedirects();

    return {
      type: "BraceGroup",
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : end },
    };
  }

  private parseDoubleSquareBracket(): TestCommand {
    const start = this.expectWord("[[").range.start;
    const expression = this.atWord("]]") || this.at(TokenType.EOF) ? null : this.parseTestOr();

    if (this.atWord("]]")) this.advance();
    const redirects = this.parseTrailingRedirects();

    return {
      type: "TestCommand",
      expression,
      redirects,
      range: { start, end: this.lastEnd(start) },
    };
  }

  // ── Test expressions: || binds loosest, then &&, then ! ────────

  private parseTestOr(): TestExpr {
    let left = this.parseTestAnd();

    while (this.atAny(TokenType.Operator, "||")) {
      this.advance();
      this.skipNewlines();
      const right = this.parseTestAnd();
      left = { type: "TestLogical", op: "||", left, right, range: { start: left.range.start, end: right.range.end } };
    }

    return left;
  }

  private parseTestAnd(): TestExpr {
    let left = this.parseTestNegation();

    while (this.atAny(TokenType.Operator, "&&")) {
      this.advance();
      this.skipNewlines();
      const right = this.parseTestNegation();
      left = { type: "TestLogical", op: "&&", left, right, range: { start: left.range.start, end: right.range.end } };
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
      const right = this.tokenToCompoundWord(this.advance());
      return { type: "TestBinary", op: opTok.value, left: word, right, range: { start: tok.range.start, end: right.range.end } };
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
    this.advance(); // (
    this.advance(); // )
    this.skipNewlines();
    const body = this.parseCommand();
    const redirects = this.parseTrailingRedirects();

    return {
      type: "FunctionDef",
      name: nameTok.value,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : body.range.end },
    };
  }

  private parseFunctionKeyword(): FunctionDef {
    const start = this.expect(TokenType.Keyword, "function").range.start;
    const nameTok = this.expect(TokenType.Word);

    // Optional ()
    if (this.atAny(TokenType.Operator, "(")) {
      this.advance();
      this.expect(TokenType.Operator, ")");
    }

    this.skipNewlines();
    const body = this.parseCommand();
    const redirects = this.parseTrailingRedirects();

    return {
      type: "FunctionDef",
      name: nameTok.value,
      body,
      redirects,
      range: { start, end: redirects.length > 0 ? redirects[redirects.length - 1]!.range.end : body.range.end },
    };
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
      } else if (quote === null && EXTGLOB_LEADS.includes(ch) && raw[i + 1] === "(") {
        // Extended glob: ?(a|b), *(…), +(…), @(…), !(…). The whole group is one
        // pattern — its alternatives are not parsed, matching how [abc] is kept
        // whole.
        flushLiteral(i);
        const start = i;
        const { next } = readDelimited(raw, i + 1, "(", ")");
        i = next;
        parts.push({ type: "GlobPattern", value: raw.slice(start, i), range: at(start, i) });
      } else if (quote === null && (ch === "*" || ch === "?")) {
        // Glob metacharacters only glob unquoted — "*.ts" is a literal filename
        flushLiteral(i);
        parts.push({ type: "GlobPattern", value: ch, range: at(i, i + 1) });
        i++;
      } else if (quote === null && ch === "[" && findBracketClose(raw, i) !== -1) {
        const close = findBracketClose(raw, i);
        flushLiteral(i);
        parts.push({ type: "GlobPattern", value: raw.slice(i, close + 1), range: at(i, close + 1) });
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

  /**
   * Parse arithmetic text, resolving any `$…` operands through the same word
   * machinery the rest of the parser uses, so `$(( $(f) + 1 ))` keeps a real
   * `CommandSubstitution` rather than a string.
   */
  private parseArithmeticText(text: string, offset: number): ArithmeticExpr | null {
    return parseArithmetic(text, offset, (raw, pos) => {
      const extent = readExpansionExtent(raw, pos);
      if (extent === null) return null;

      const slice = raw.slice(pos, extent);
      const range = { start: offset + pos, end: offset + extent };
      const part = this.parseWordParts(slice, range, offset + pos)[0];

      return part === undefined ? null : { part, next: extent };
    });
  }

  /**
   * Parse the inside of a `$(...)` or backtick substitution as its own script.
   * Ranges come out relative to the captured text, so shift them onto the
   * absolute source offset the body started at.
   */
  private parseSubstitution(body: string, offset: number): Script {
    const script = new Parser(tokenize(body)).parse();
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

export function parse(tokens: Token[]): Script {
  return new Parser(tokens).parse();
}
