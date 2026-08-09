import { parseArithmetic } from "./arithmetic.ts";

export enum TokenType {
  /** A bare or quoted word / argument */
  Word = "Word",
  /** An operator: |, ||, &&, ;, ;;, &, (, ), {, } */
  Operator = "Operator",
  /** Redirection operator: >, >>, <, <<, <<<, >&, <&, >|, <> with optional fd */
  Redirect = "Redirect",
  /** Shell keywords: if, then, elif, else, fi, for, while, until, do, done, case, esac, in, function, coproc, select, [[ ]] */
  Keyword = "Keyword",
  /** Assignment: NAME=value */
  Assignment = "Assignment",
  /** Newline (significant in shell grammar) */
  Newline = "Newline",
  /** # comment */
  Comment = "Comment",
  /** End of input */
  EOF = "EOF",
  /** Here-document body */
  HereDocBody = "HereDocBody",
  /** The inside of a `(( … ))` arithmetic command, without the parens */
  Arithmetic = "Arithmetic",
}

export interface Token {
  type: TokenType;
  value: string;
  range: { start: number; end: number };
}

const KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "in",
  "function", "coproc", "select",
  "!", "[[", "]]",
]);

/**
 * Builtins that declare variables. Their arguments are assignments rather than
 * ordinary words, so `declare -a X=(1 2)` is one command, not a command
 * followed by a subshell.
 */
const DECLARATION_BUILTINS = new Set(["declare", "typeset", "local", "export", "readonly"]);

/** Characters that turn `(pattern-list)` into an extended glob */
export const EXTGLOB_LEADS = "?*+@!";

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

/**
 * `#` is absent from this list on purpose: it only opens a comment at the start
 * of a word, which `tokenize` has already handled before `readWord` runs. Mid
 * word it is an ordinary character, so `echo a#b` is one argument.
 */
function isWordChar(ch: string): boolean {
  return (
    ch !== "" &&
    !isWhitespace(ch) &&
    ch !== "\n" &&
    ch !== "|" &&
    ch !== "&" &&
    ch !== ";" &&
    ch !== "(" &&
    ch !== ")" &&
    ch !== "<" &&
    ch !== ">"
  );
}

/**
 * Whether the character at `pos` begins a word — true at the start of the
 * region, after whitespace, or after an operator that ends the previous word.
 * Only there does `#` open a comment.
 */
function startsWord(src: string, pos: number, regionStart: number): boolean {
  if (pos === regionStart) return true;
  const prev = src[pos - 1]!;
  return isWhitespace(prev) || prev === "\n" || prev === ";" || prev === "&" || prev === "|" || prev === "(";
}

/** Skip a quoted span in `text`, with `pos` on the opening quote */
function skipQuotedIn(text: string, pos: number): number {
  const quote = text[pos]!;
  let i = pos + 1;

  while (i < text.length && text[i] !== quote) {
    if (quote === '"' && text[i] === "\\") i += 2;
    else i++;
  }

  return i < text.length ? i + 1 : i;
}

/**
 * Index just past the delimiter matching the one at `open`, or -1 when it is
 * unbalanced. Quoted spans are skipped whole. `depth` above 1 is for openers
 * spelled with repeated delimiters, like `((`.
 */
function matchDelimiter(text: string, open: number, openCh: string, closeCh: string, depth: number = 1): number {
  let i = open + 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipQuotedIn(text, i); continue; }

    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }

  return -1;
}

/**
 * Split a C-style `for` header on its top-level `;`, keeping each clause's
 * offset so its nodes can still point at the source. Parens and quotes are
 * skipped, so a `;` inside either does not split.
 */
export function splitArithmeticClauses(text: string): { text: string; offset: number }[] {
  const clauses: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipQuotedIn(text, i); continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      clauses.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
    i++;
  }

  clauses.push({ text: text.slice(start), offset: start });
  return clauses;
}

/**
 * Extent of the `$…` or backtick expansion starting at `pos`, or null when
 * there is none. Shared by the arithmetic parser's two callers so both agree on
 * where an operand ends.
 */
export function readExpansionExtent(text: string, pos: number): number | null {
  if (text[pos] === "`") {
    const close = text.indexOf("`", pos + 1);
    return close === -1 ? text.length : close + 1;
  }

  if (text[pos] !== "$") return null;
  const next = text[pos + 1];

  if (next === "{") {
    const end = matchDelimiter(text, pos + 1, "{", "}");
    return end === -1 ? null : end;
  }

  if (next === "(") {
    const arithmetic = text[pos + 2] === "(";
    const end = arithmetic
      ? matchDelimiter(text, pos + 2, "(", ")", 2)
      : matchDelimiter(text, pos + 1, "(", ")");
    return end === -1 ? null : end;
  }

  if (next !== undefined && /[a-zA-Z_]/.test(next)) {
    let end = pos + 1;
    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end]!)) end++;
    return end;
  }

  if (next !== undefined && /[0-9!?#$@*\-]/.test(next)) return pos + 2;

  return null;
}

/**
 * Read a heredoc operator's delimiter, with `pos` on the first `<`. Returns
 * null when this is not a heredoc — `<<<` is a here-string, whose operand is an
 * ordinary word rather than a body.
 *
 * Exported because the parser re-scans token text and needs the identical rule.
 */
export function readHereDocHeader(
  text: string,
  pos: number,
): { delimiter: string; stripTabs: boolean; next: number } | null {
  if (text[pos] !== "<" || text[pos + 1] !== "<" || text[pos + 2] === "<") return null;

  let i = pos + 2;
  let stripTabs = false;
  if (text[i] === "-") { stripTabs = true; i++; }
  while (i < text.length && isWhitespace(text[i]!)) i++;

  let delimiter = "";
  if (text[i] === "'" || text[i] === '"') {
    const quote = text[i]!;
    i++;
    while (i < text.length && text[i] !== quote) { delimiter += text[i]; i++; }
    if (i < text.length) i++;
  } else {
    while (i < text.length && !isWhitespace(text[i]!) && text[i] !== "\n") {
      delimiter += text[i];
      i++;
    }
  }

  return delimiter === "" ? null : { delimiter, stripTabs, next: i };
}

/**
 * Skip the bodies queued by heredoc operators on the line just ended, with
 * `pos` on the first character after that newline. Bodies are raw text — no
 * quote, comment or delimiter rule applies inside them — so a scanner looking
 * for a closing `)` has to step over them wholesale.
 */
export function skipHereDocBodies(
  text: string,
  pos: number,
  queue: readonly { delimiter: string; stripTabs: boolean }[],
): number {
  let i = pos;

  for (const hd of queue) {
    while (i < text.length) {
      const lineEnd = text.indexOf("\n", i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const line = text.slice(i, end);
      i = lineEnd === -1 ? text.length : lineEnd + 1;
      if ((hd.stripTabs ? line.replace(/^\t+/, "") : line) === hd.delimiter) break;
    }
  }

  return i;
}

export interface PendingHereDoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
}

export class Tokenizer {
  private src: string;
  private pos: number = 0;
  private tokens: Token[] = [];
  private pendingHereDocs: PendingHereDoc[] = [];
  private _atCommandStart: boolean = true;
  /** Whether we are inside a `declare`-style command, where args may be assignments */
  private inDeclarationCommand: boolean = false;
  /** Whether we are between `[[` and `]]`, where `<` and `>` compare strings */
  private inTestCommand: boolean = false;
  /** Whether the next word is the regex operand of `=~` */
  private afterRegexOperator: boolean = false;
  /**
   * Functions defined so far. A function shadows a builtin of the same name
   * only once its definition has run, so a single forward pass matches the
   * shell: names seen earlier in the source shadow, later ones do not.
   */
  private definedFunctions: Set<string> = new Set();

  /** Whether the last non-whitespace token allows a keyword next */
  private get atCommandStart(): boolean {
    return this._atCommandStart;
  }

  /** Reaching a new command position ends any declaration context */
  private set atCommandStart(value: boolean) {
    this._atCommandStart = value;
    if (value) this.inDeclarationCommand = false;
  }

  constructor(src: string) {
    this.src = src;
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) break;

      const ch = this.src[this.pos]!;

      if (ch === "\n") {
        this.tokens.push({
          type: TokenType.Newline,
          value: "\n",
          range: { start: this.pos, end: this.pos + 1 },
        });
        this.pos++;
        this.atCommandStart = true;
        this.consumePendingHereDocs();
        continue;
      }

      if (ch === "#") {
        this.readComment();
        continue;
      }

      // The operand of `=~` is a regex, so `(`, `)` and `|` belong to it rather
      // than to the surrounding test expression
      if (this.afterRegexOperator) {
        this.afterRegexOperator = false;
        if (!this.src.startsWith("]]", this.pos)) {
          this.readRegexWord();
          continue;
        }
      }

      if (ch === "<" || ch === ">") {
        // Inside `[[ … ]]` these compare strings; only process substitution
        // still takes a paren group there
        if (this.inTestCommand && this.src[this.pos + 1] !== "(") {
          this.tokens.push({ type: TokenType.Operator, value: ch, range: { start: this.pos, end: this.pos + 1 } });
          this.pos++;
          continue;
        }
        this.readRedirectOrProcessSub();
        continue;
      }

      // Digit before redirect: e.g. 2>
      if (ch >= "0" && ch <= "9" && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1]!;
        if (next === ">" || next === "<") {
          this.readRedirectOrProcessSub();
          continue;
        }
      }

      if (ch === "|" || ch === "&" || ch === ";") {
        this.readOperator();
        continue;
      }

      // `(( … ))` arithmetic command. Attempted before the plain-paren path
      // because `<` inside it is an operator, not a redirection.
      const forHeader = this.lastTokenIs(TokenType.Keyword, "for");
      if (ch === "(" && this.src[this.pos + 1] === "(" &&
          (this.atCommandStart || forHeader) &&
          this.readArithmeticCommand(forHeader)) {
        continue;
      }

      if (ch === "(" || ch === ")") {
        // A `(` glued to an assignment opens an array literal, not a subshell.
        // It is inside the same command, so declaration context survives it and
        // `declare -a X=(1 2) Y=(3)` keeps recognising Y as an assignment.
        const prev = this.tokens[this.tokens.length - 1];
        const opensArray = ch === "(" &&
          prev?.type === TokenType.Assignment &&
          prev.range.end === this.pos;
        const declarationContext = this.inDeclarationCommand;

        this.tokens.push({
          type: TokenType.Operator,
          value: ch,
          range: { start: this.pos, end: this.pos + 1 },
        });
        this.pos++;
        if (ch === "(") this.atCommandStart = true;
        if (opensArray) this.inDeclarationCommand = declarationContext;
        if (ch === ")") this.recordFunctionDefinition();
        continue;
      }

      if (ch === "{" || ch === "}") {
        if (this.atCommandStart && (ch === "{" || ch === "}")) {
          this.tokens.push({
            type: TokenType.Keyword,
            value: ch,
            range: { start: this.pos, end: this.pos + 1 },
          });
        } else {
          this.tokens.push({
            type: TokenType.Operator,
            value: ch,
            range: { start: this.pos, end: this.pos + 1 },
          });
        }
        this.pos++;
        if (ch === "{") this.atCommandStart = true;
        continue;
      }

      // Word, keyword, or assignment
      this.readWord();
    }

    this.tokens.push({
      type: TokenType.EOF,
      value: "",
      range: { start: this.pos, end: this.pos },
    });

    return this.tokens;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && isWhitespace(this.src[this.pos]!)) {
      this.pos++;
    }
  }

  private readComment(): void {
    const start = this.pos;
    this.pos++; // skip #
    while (this.pos < this.src.length && this.src[this.pos] !== "\n") {
      this.pos++;
    }
    this.tokens.push({
      type: TokenType.Comment,
      value: this.src.slice(start, this.pos),
      range: { start, end: this.pos },
    });
  }

  private readOperator(): void {
    const start = this.pos;
    const ch = this.src[this.pos]!;
    this.pos++;

    let value = ch;
    if (this.pos < this.src.length) {
      const next = this.src[this.pos]!;
      if (ch === "|" && next === "|") { value = "||"; this.pos++; }
      else if (ch === "&" && next === "&") { value = "&&"; this.pos++; }
      else if (ch === ";" && next === ";") {
        value = ";;";
        this.pos++;
        // `;;&` keeps testing later patterns; `;&` falls through to the next body
        if (this.src[this.pos] === "&") { value = ";;&"; this.pos++; }
      }
      else if (ch === ";" && next === "&") { value = ";&"; this.pos++; }
    }

    this.tokens.push({
      type: TokenType.Operator,
      value,
      range: { start, end: this.pos },
    });
    this.atCommandStart = true;
  }

  private readRedirectOrProcessSub(): void {
    const start = this.pos;
    let fd: string = "";

    // optional fd number prefix
    while (this.pos < this.src.length && this.src[this.pos]! >= "0" && this.src[this.pos]! <= "9") {
      fd += this.src[this.pos]!;
      this.pos++;
    }

    const ch = this.src[this.pos]!;
    this.pos++;
    let op = fd + ch;

    if (this.pos < this.src.length) {
      const next = this.src[this.pos]!;

      // Process substitution: <( or >(
      if (next === "(" && fd === "") {
        // Treat as word-level (process sub) — emit as word token
        // Back up and read as word
        this.pos = start;
        this.readWord();
        return;
      }

      if (ch === ">" && next === ">") { op = fd + ">>"; this.pos++; }
      else if (ch === ">" && next === "&") { op = fd + ">&"; this.pos++; }
      else if (ch === ">" && next === "|") { op = fd + ">|"; this.pos++; }
      else if (ch === "<" && next === "<") {
        this.pos++;
        if (this.pos < this.src.length && this.src[this.pos] === "<") {
          op = fd + "<<<"; this.pos++;
        } else {
          // Check for <<-
          let heredocOp = fd + "<<";
          let stripTabs = false;
          if (this.pos < this.src.length && this.src[this.pos] === "-") {
            stripTabs = true;
            heredocOp += "-";
            this.pos++;
          }
          op = heredocOp;

          this.tokens.push({
            type: TokenType.Redirect,
            value: op,
            range: { start, end: this.pos },
          });
          this.atCommandStart = false;

          // Read the delimiter
          this.skipWhitespace();
          const delimStart = this.pos;
          let delimiter = "";
          let quoted = false;

          if (this.pos < this.src.length && (this.src[this.pos] === "'" || this.src[this.pos] === '"')) {
            quoted = true;
            const quote = this.src[this.pos]!;
            this.pos++;
            while (this.pos < this.src.length && this.src[this.pos] !== quote) {
              delimiter += this.src[this.pos];
              this.pos++;
            }
            if (this.pos < this.src.length) this.pos++; // closing quote
          } else {
            while (this.pos < this.src.length && !isWhitespace(this.src[this.pos]!) && this.src[this.pos] !== "\n") {
              delimiter += this.src[this.pos];
              this.pos++;
            }
          }

          // Emit the delimiter as written, quotes included, so the parser can
          // tell `<<EOF` (expands) from `<<'EOF'` (literal).
          this.tokens.push({
            type: TokenType.Word,
            value: this.src.slice(delimStart, this.pos),
            range: { start: delimStart, end: this.pos },
          });

          this.pendingHereDocs.push({ delimiter, stripTabs, quoted });
          return;
        }
      }
      else if (ch === "<" && next === "&") { op = fd + "<&"; this.pos++; }
      else if (ch === "<" && next === ">") { op = fd + "<>"; this.pos++; }
    }

    this.tokens.push({
      type: TokenType.Redirect,
      value: op,
      range: { start, end: this.pos },
    });
    this.atCommandStart = false;
  }

  private consumePendingHereDocs(): void {
    while (this.pendingHereDocs.length > 0) {
      const hd = this.pendingHereDocs.shift()!;
      const start = this.pos;
      let content = "";
      while (this.pos < this.src.length) {
        const lineStart = this.pos;
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") {
          this.pos++;
        }
        const line = this.src.slice(lineStart, this.pos);
        const trimmed = hd.stripTabs ? line.replace(/^\t+/, "") : line;

        if (trimmed === hd.delimiter) {
          if (this.pos < this.src.length) this.pos++; // skip newline after delimiter
          break;
        }

        content += line;
        if (this.pos < this.src.length) {
          content += "\n";
          this.pos++;
        }
      }

      this.tokens.push({
        type: TokenType.HereDocBody,
        value: content,
        range: { start, end: this.pos },
      });
    }
  }

  private readWord(): void {
    const start = this.pos;
    let value = "";
    let hasEquals = false;
    let equalsPos = -1;

    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;

      if (ch === "\\") {
        // Escape: take next char literally
        value += ch;
        this.pos++;
        if (this.pos < this.src.length) {
          value += this.src[this.pos];
          this.pos++;
        }
        continue;
      }

      if (ch === "'") {
        // Single-quoted string: no expansions
        value += ch;
        this.pos++;
        while (this.pos < this.src.length && this.src[this.pos] !== "'") {
          value += this.src[this.pos];
          this.pos++;
        }
        if (this.pos < this.src.length) {
          value += "'";
          this.pos++;
        }
        continue;
      }

      if (ch === '"') {
        // Double-quoted string: allows $, `, \ escapes
        value += ch;
        this.pos++;
        while (this.pos < this.src.length && this.src[this.pos] !== '"') {
          const c = this.src[this.pos]!;
          if (c === "\\") {
            value += c;
            this.pos++;
            if (this.pos < this.src.length) {
              value += this.src[this.pos];
              this.pos++;
            }
          } else if (c === "$" && (this.src[this.pos + 1] === "(" || this.src[this.pos + 1] === "{")) {
            // A substitution nests its own quotes: "$(grep ")" f)" does not end
            // at the quote inside the substitution
            value += this.readDollar();
          } else if (c === "`") {
            value += this.readBacktick();
          } else {
            value += c;
            this.pos++;
          }
        }
        if (this.pos < this.src.length) {
          value += '"';
          this.pos++;
        }
        continue;
      }

      if (ch === "$") {
        value += this.readDollar();
        continue;
      }

      if (ch === "`") {
        value += this.readBacktick();
        continue;
      }

      // Process substitution <() or >() at word level
      if ((ch === "<" || ch === ">") && this.pos + 1 < this.src.length && this.src[this.pos + 1] === "(") {
        value += ch;
        this.pos++;
        value += this.readParenGroup();
        continue;
      }

      // Extended glob: ?( *( +( @( !( — the group belongs to the word, not to a
      // subshell. `!` is excluded at the start of a command, where it is the
      // pipeline negation keyword and `!(cmd)` negates a subshell.
      if (EXTGLOB_LEADS.includes(ch) && this.src[this.pos + 1] === "(" &&
          !(ch === "!" && this.atCommandStart && this.pos === start)) {
        value += ch;
        this.pos++;
        // A pattern list, not shell code: no comments or heredocs inside
        value += this.readParenGroup(false);
        continue;
      }

      if (!isWordChar(ch)) break;

      if (ch === "=" && !hasEquals) {
        hasEquals = true;
        equalsPos = value.length;
      }

      value += ch;
      this.pos++;
    }

    if (value === "") return;

    // Check for [[ keyword (two chars)
    if (value === "[[" || value === "]]") {
      this.tokens.push({
        type: TokenType.Keyword,
        value,
        range: { start, end: this.pos },
      });
      this.atCommandStart = value === "[[";
      this.inTestCommand = value === "[[";
      return;
    }

    // Determine if this is a keyword, assignment, or word
    if (this.atCommandStart && KEYWORDS.has(value)) {
      this.tokens.push({
        type: TokenType.Keyword,
        value,
        range: { start, end: this.pos },
      });
      // Keywords like do, then, { start a new command context
      const startsCommand = ["do", "then", "else", "elif", "!", "[["].includes(value);
      this.atCommandStart = startsCommand;
      return;
    }

    // Assignment: NAME=, NAME+=, NAME[sub]=, NAME[sub]+=
    // Valid at command start, and after a declaration builtin, where the
    // assignment is an argument: `declare -a X=(1 2)`
    if (hasEquals && equalsPos > 0 && (this.atCommandStart || this.inDeclarationCommand)) {
      const name = value.slice(0, equalsPos);
      if (/^[a-zA-Z_][a-zA-Z0-9_]*(\[[^\]]+\])?\+?$/.test(name)) {
        this.tokens.push({
          type: TokenType.Assignment,
          value,
          range: { start, end: this.pos },
        });
        return;
      }
    }

    const wasCommandStart = this.atCommandStart;
    const afterFunctionKeyword = this.lastTokenIs(TokenType.Keyword, "function");
    this.tokens.push({
      type: TokenType.Word,
      value,
      range: { start, end: this.pos },
    });
    this.atCommandStart = false;

    if (afterFunctionKeyword) this.definedFunctions.add(value);

    // A user function of the same name shadows the builtin
    if (wasCommandStart && DECLARATION_BUILTINS.has(value) && !this.definedFunctions.has(value)) {
      this.inDeclarationCommand = true;
    }
    if (this.inTestCommand && value === "=~") {
      this.afterRegexOperator = true;
    }
  }

  /**
   * Read the regex following `=~` as one word. Parentheses group, and inside
   * them spaces are part of the pattern — `[[ $s =~ (a b)+ ]]` is one operand,
   * which is why bash needs the parens to write a space or `|` at all.
   */
  private readRegexWord(): void {
    const start = this.pos;
    let depth = 0;

    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;

      if (ch === "\n") break;
      if (ch === "\\") { this.pos += 2; continue; }
      if (ch === "'" || ch === '"') { this.skipQuoted(ch); continue; }

      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0) depth--;
      // Whitespace alone ends the operand: a `]]` inside it belongs to the
      // pattern, as in `[[:digit:]]`, and the shell needs a space before the
      // real closing `]]` regardless
      else if (depth === 0 && isWhitespace(ch)) break;

      this.pos++;
    }

    this.tokens.push({
      type: TokenType.Word,
      value: this.src.slice(start, this.pos),
      range: { start, end: this.pos },
    });
    this.atCommandStart = false;
  }

  /**
   * Called on `)`: the `name ( )` that just closed is a function definition, so
   * `name` shadows any builtin of the same name from here on. `(cmd)` is a
   * subshell and does not match, since a word must sit directly before the `(`.
   */
  private recordFunctionDefinition(): void {
    const open = this.tokens[this.tokens.length - 2];
    const name = this.tokens[this.tokens.length - 3];

    if (open?.type === TokenType.Operator && open.value === "(" && name?.type === TokenType.Word) {
      this.definedFunctions.add(name.value);
    }
  }

  private lastTokenIs(type: TokenType, value: string): boolean {
    const last = this.tokens[this.tokens.length - 1];
    return last?.type === type && last.value === value;
  }

  /**
   * Try to read `(( … ))` as an arithmetic command, returning false to leave
   * `this.pos` untouched when it is not one.
   *
   * `((cd /tmp) && ls)` is a legitimate pair of nested subshells, so the text
   * is trial-parsed as arithmetic first and only claimed if it fits — the same
   * disambiguation bash performs.
   *
   * `forHeader` allows the `;`-separated clauses of `for (( … ; … ; … ))`,
   * which are three expressions rather than one.
   */
  private readArithmeticCommand(forHeader: boolean): boolean {
    const start = this.pos;
    const end = matchDelimiter(this.src, this.pos + 1, "(", ")", 2);
    if (end === -1 || this.src[end - 2] !== ")") return false;

    const expression = this.src.slice(start + 2, end - 2);
    // A placeholder part is enough here: this only asks "is this arithmetic?",
    // and the parser re-parses the text with real expansion handling.
    const fits = (text: string) => parseArithmetic(text, 0, (raw, pos) => {
      const extent = readExpansionExtent(raw, pos);
      return extent === null
        ? null
        : { part: { type: "Word", value: raw.slice(pos, extent), quoted: null, range: { start: pos, end: extent } }, next: extent };
    }) !== null;

    if (forHeader) {
      // Every non-empty clause must parse; `for ((;;))` is all-empty and valid
      const clauses = splitArithmeticClauses(expression);
      if (!clauses.every(clause => clause.text.trim() === "" || fits(clause.text))) return false;
    } else if (!fits(expression)) {
      return false;
    }

    this.tokens.push({ type: TokenType.Arithmetic, value: expression, range: { start, end } });
    this.pos = end;
    this.atCommandStart = false;
    return true;
  }

  /** Skip a quoted span. `this.pos` must be on the opening quote. */
  private skipQuoted(quote: string): void {
    this.pos++;
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      // Backslash escapes exist inside double quotes only
      if (quote === '"' && this.src[this.pos] === "\\") this.pos += 2;
      else this.pos++;
    }
    if (this.pos < this.src.length) this.pos++;
  }

  /**
   * Read a delimited region, with `this.pos` just past its opener. Quoted
   * spans are skipped whole, so a delimiter inside a string does not close the
   * region: `$(grep ")" file)` runs to the last paren, not the quoted one.
   *
   * `depth` above 1 is for openers spelled with repeated delimiters, like
   * `$((`. The extra closers land at the end of the collected text, so they
   * are trimmed back off.
   *
   * `shellCode` marks regions whose contents are shell code — `$( )` and
   * `<( )` — where `#` opens a comment and `<<` opens a heredoc whose body must
   * be stepped over. It stays off for `${ }`, where `#` is the length and
   * prefix-strip operator, and for arithmetic.
   */
  private readBalanced(open: string, close: string, depth: number = 1, shellCode: boolean = false): { text: string; closed: boolean } {
    const extraClosers = depth - 1;
    const start = this.pos;
    const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
    let closed = false;

    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;

      if (ch === "\\") { this.pos += 2; continue; }
      if (ch === "'" || ch === '"') { this.skipQuoted(ch); continue; }

      if (shellCode && ch === "#" && startsWord(this.src, this.pos, start)) {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos++;
        continue;
      }

      if (shellCode && ch === "<" && this.src[this.pos + 1] === "<") {
        const header = readHereDocHeader(this.src, this.pos);
        if (header) {
          heredocs.push({ delimiter: header.delimiter, stripTabs: header.stripTabs });
          this.pos = header.next;
          continue;
        }
      }

      if (ch === "\n" && heredocs.length > 0) {
        this.pos = skipHereDocBodies(this.src, this.pos + 1, heredocs);
        heredocs.length = 0;
        continue;
      }

      if (ch === open) { depth++; }
      else if (ch === close) {
        depth--;
        if (depth === 0) { closed = true; break; }
      }
      this.pos++;
    }

    let text = this.src.slice(start, this.pos);
    if (closed) this.pos++;
    for (let n = 0; n < extraClosers && text.endsWith(close); n++) {
      text = text.slice(0, -close.length);
    }

    return { text, closed };
  }

  /** Read a $... expansion and return the raw text */
  private readDollar(): string {
    let result = "$";
    this.pos++; // skip $

    if (this.pos >= this.src.length) return result;

    const ch = this.src[this.pos]!;

    if (ch === "(") {
      this.pos++;
      if (this.pos < this.src.length && this.src[this.pos] === "(") {
        // $(( arithmetic ))
        this.pos++;
        const { text, closed } = this.readBalanced("(", ")", 2);
        result += "((" + text + (closed ? "))" : "");
      } else {
        // $( command substitution ) — holds shell code, so # opens a comment
        const { text, closed } = this.readBalanced("(", ")", 1, true);
        result += "(" + text + (closed ? ")" : "");
      }
    } else if (ch === "{") {
      // ${...} parameter expansion
      this.pos++;
      const { text, closed } = this.readBalanced("{", "}");
      result += "{" + text + (closed ? "}" : "");
    } else if (ch === "!" || ch === "?" || ch === "#" || ch === "$" || ch === "@" || ch === "*" || ch === "-" || ch === "0") {
      // Special parameters
      result += ch;
      this.pos++;
    } else if (/[a-zA-Z_]/.test(ch)) {
      // $NAME
      while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.src[this.pos]!)) {
        result += this.src[this.pos];
        this.pos++;
      }
    } else if (/[0-9]/.test(ch)) {
      // Positional parameter $1-$9
      result += ch;
      this.pos++;
    }

    return result;
  }

  /** Read a backtick command substitution */
  private readBacktick(): string {
    let result = "`";
    this.pos++; // skip `
    while (this.pos < this.src.length && this.src[this.pos] !== "`") {
      if (this.src[this.pos] === "\\") {
        result += this.src[this.pos];
        this.pos++;
        if (this.pos < this.src.length) {
          result += this.src[this.pos];
          this.pos++;
        }
      } else {
        result += this.src[this.pos];
        this.pos++;
      }
    }
    if (this.pos < this.src.length) {
      result += "`";
      this.pos++;
    }
    return result;
  }

  /** Read a parenthesized group: ( ... ) tracking nesting */
  private readParenGroup(shellCode: boolean = true): string {
    this.pos++; // skip (
    const { text, closed } = this.readBalanced("(", ")", 1, shellCode);
    return "(" + text + (closed ? ")" : "");
  }
}

export function tokenize(src: string): Token[] {
  return new Tokenizer(src).tokenize();
}
