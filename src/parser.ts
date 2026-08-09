import type {
  Script, Command, SimpleCommand, Pipeline, ListItem,
  CompoundWord, WordPart, Redirect, HereDoc, Assignment, ArrayLiteral, Range,
  IfClause, ForClause, WhileClause, UntilClause, CaseClause, CaseItem,
  Subshell, BraceGroup, FunctionDef, Comment, Coproc,
} from "./ast.ts";
import { tokenize, type Token, TokenType } from "./tokenizer.ts";

/**
 * Read a parenthesised body, starting at the index of the opening paren.
 * Returns the text between the parens and the index just past the closing one.
 */
function readParenBody(raw: string, openParen: number): { body: string; next: number } {
  let i = openParen + 1;
  let body = "";
  let depth = 1;

  while (i < raw.length && depth > 0) {
    if (raw[i] === "(") depth++;
    else if (raw[i] === ")") depth--;
    if (depth > 0) { body += raw[i]; i++; }
  }
  if (i < raw.length) i++; // skip )

  return { body, next: i };
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
    return this.atAny(TokenType.Operator, ")", ";;", "}");
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

    if (tok.type === TokenType.Operator && tok.value === "(") {
      return this.parseSubshell();
    }

    return this.parseSimpleCommandOrFunctionDef();
  }

  // ── Simple command (with function def detection) ───────────────

  private parseSimpleCommandOrFunctionDef(): SimpleCommand | FunctionDef {
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
    const args: CompoundWord[] = [];

    // Collect args and redirects
    while (
      this.at(TokenType.Word) ||
      this.at(TokenType.Assignment) ||
      this.at(TokenType.Redirect)
    ) {
      if (this.at(TokenType.Redirect)) {
        redirects.push(this.parseRedirect());
      } else {
        const tok = this.advance();
        args.push(this.tokenToCompoundWord(tok));
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
    const name = append ? lhs.slice(0, -1) : lhs;
    const rawValue = tok.value.slice(eqIdx + 1);

    // `VAR=(a b c)` is an array literal, but `VAR= (cmd)` is an empty
    // assignment followed by a subshell — only adjacency tells them apart.
    if (rawValue.length === 0 && this.atAny(TokenType.Operator, "(") && this.peek().range.start === tok.range.end) {
      const value = this.parseArrayLiteral();
      return {
        type: "Assignment",
        name,
        append,
        value,
        range: { start: tok.range.start, end: value.range.end },
      };
    }

    return {
      type: "Assignment",
      name,
      append,
      value: rawValue.length > 0 ? this.rawToCompoundWord(rawValue, tok.range) : null,
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

  private parseFor(): ForClause {
    const start = this.expect(TokenType.Keyword, "for").range.start;
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

    // Consume ;;
    if (this.atAny(TokenType.Operator, ";;")) {
      this.advance();
    }

    const end = this.lastEnd(start);

    return {
      type: "CaseItem",
      patterns,
      body,
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

  private parseDoubleSquareBracket(): SimpleCommand {
    // Treat [[ ... ]] as a simple command for now
    const start = this.peek().range.start;
    const name = this.tokenToCompoundWord(this.advance()); // [[
    const args: CompoundWord[] = [];

    while (!this.atWord("]]")) {
      if (this.at(TokenType.EOF)) break;
      args.push(this.tokenToCompoundWord(this.advance()));
    }

    if (this.atWord("]]")) {
      args.push(this.tokenToCompoundWord(this.advance()));
    }

    const redirects = this.parseTrailingRedirects();

    return {
      type: "SimpleCommand",
      assignments: [],
      name,
      args,
      redirects,
      range: { start, end: this.lastEnd(start) },
    };
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

  private rawToCompoundWord(raw: string, range: { start: number; end: number }): CompoundWord {
    const parts = this.parseWordParts(raw, range);
    return {
      type: "CompoundWord",
      parts,
      range,
    };
  }

  /** Break a raw token string into WordParts (expansions, globs, literals) */
  private parseWordParts(raw: string, range: { start: number; end: number }): WordPart[] {
    const parts: WordPart[] = [];
    let i = 0;
    let literal = "";
    const flushLiteral = () => {
      if (literal.length > 0) {
        parts.push({
          type: "Word",
          value: literal,
          range, // approximate
        });
        literal = "";
      }
    };

    while (i < raw.length) {
      const ch = raw[i]!;

      if (ch === "$" && i + 1 < raw.length) {
        flushLiteral();
        const next = raw[i + 1]!;

        if (next === "{") {
          // ${...}
          i += 2;
          let expr = "";
          let depth = 1;
          while (i < raw.length && depth > 0) {
            if (raw[i] === "{") depth++;
            else if (raw[i] === "}") depth--;
            if (depth > 0) { expr += raw[i]; i++; }
          }
          if (i < raw.length) i++; // skip }
          parts.push({
            type: "VariableExpansion",
            expression: expr,
            braced: true,
            range,
          });
        } else if (next === "(") {
          if (i + 2 < raw.length && raw[i + 2] === "(") {
            // $(( arithmetic ))
            i += 3;
            let expr = "";
            while (i + 1 < raw.length && !(raw[i] === ")" && raw[i + 1] === ")")) {
              expr += raw[i];
              i++;
            }
            if (i + 1 < raw.length) i += 2; // skip ))
            parts.push({
              type: "ArithmeticExpansion",
              expression: expr,
              range,
            });
          } else {
            // $( command substitution )
            const bodyStart = i + 2;
            const { body, next } = readParenBody(raw, i + 1);
            i = next;
            parts.push({
              type: "CommandSubstitution",
              backtick: false,
              body: this.parseSubstitution(body, range.start + bodyStart),
              range,
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
            range,
          });
        } else if (/[0-9!?#$@*\-]/.test(next)) {
          parts.push({
            type: "VariableExpansion",
            expression: next,
            braced: false,
            range,
          });
          i += 2;
        } else {
          literal += ch;
          i++;
        }
      } else if ((ch === "<" || ch === ">") && raw[i + 1] === "(") {
        // <(cmd) / >(cmd) process substitution
        flushLiteral();
        const bodyStart = i + 2;
        const { body, next } = readParenBody(raw, i + 1);
        i = next;
        parts.push({
          type: "ProcessSubstitution",
          direction: ch,
          body: this.parseSubstitution(body, range.start + bodyStart),
          range,
        });
      } else if (ch === "`") {
        flushLiteral();
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
          body: this.parseSubstitution(body.replace(/\\([$`\\])/g, "$1"), range.start + bodyStart),
          range,
        });
      } else {
        literal += ch;
        i++;
      }
    }

    flushLiteral();

    if (parts.length === 0) {
      parts.push({ type: "Word", value: "", range });
    }

    return parts;
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
