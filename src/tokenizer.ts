import { parseArithmetic } from "./arithmetic.ts";
import type { Dialect, ParseOptions, Range } from "./ast.ts";
import {
  EXTGLOB_LEADS,
  isWhitespace,
  isWordChar,
  matchDelimiter,
  readBalanced,
  readExpansionExtent,
  readHereDocDelimiter,
  readHereDocHeader,
  skipHereDocBodies,
  skipQuoted,
} from "./scan.ts";

export enum TokenType {
  /** A bare or quoted word / argument */
  Word = "Word",
  /** An operator: |, ||, &&, ;, ;;, &, (, ), {, } */
  Operator = "Operator",
  /** Redirection operator: >, >>, <, <<, <<<, >&, <&, >|, <>, &>, &>> with optional fd */
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
  range: Range;
  /**
   * Value indexes where a line continuation was dropped. Each entry marks a
   * backslash-newline pair present in the source but not in `value`, so a
   * character at or past it sits two further right in the source per entry.
   * Absent when value and source agree, which is nearly always.
   */
  joins?: number[];
  /** A `'`, `"`, or `` ` `` inside this token's text never found its closing match before EOF. */
  unterminated?: true;
}

const KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "in",
  "function", "coproc", "select", "time",
  "!", "[[", "]]",
]);

/**
 * Builtins that declare variables. Their arguments are assignments rather than
 * ordinary words, so `declare -a X=(1 2)` is one command, not a command
 * followed by a subshell.
 */
const DECLARATION_BUILTINS = new Set(["declare", "typeset", "local", "export", "readonly"]);

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
    if (ch === "'" || ch === '"') { i = skipQuoted(text, i); continue; }
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

interface PendingHereDoc {
  delimiter: string;
  stripTabs: boolean;
}

class Tokenizer {
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
  /** Whether the next word is the pattern operand of `==` or `!=` (zsh) */
  private afterPatternOperator: boolean = false;
  private afterTimeKeyword: boolean = false;
  /** Plain parentheses currently delimiting an array assignment's values. */
  private arrayLiteralDepth: number = 0;
  /** Command-position state to restore after reading one redirect operand. */
  private commandStartBeforeRedirectTarget: boolean | null = null;
  private dialect: Dialect;
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
    if (value) {
      this.inDeclarationCommand = false;
      this.afterTimeKeyword = false;
    }
  }

  constructor(src: string, options: ParseOptions = {}) {
    this.src = src;
    this.dialect = options.dialect ?? "bash";
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) break;

      const ch = this.src[this.pos]!;

      if (ch === "\n") {
        // Inside `[[ … ]]` a newline is whitespace, not a terminator, so a
        // condition may span lines and break before `&&`. The `[` builtin is an
        // ordinary command and keeps the usual meaning.
        if (this.inTestCommand) {
          this.pos++;
          continue;
        }

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
        // zsh: a `#` pressed against a `(` is pattern syntax — the repeat
        // operator in `(#*)`, or a flag as in `(#i)` — not a comment. A comment
        // needs whitespace before it.
        const afterOpenParen = this.dialect === "zsh" && this.src[this.pos - 1] === "(";
        if (!afterOpenParen) {
          this.readComment();
          continue;
        }
      }

      // The operand of `=~` is a regex, so `(`, `)` and `|` belong to it rather
      // than to the surrounding test expression. In zsh the operand of `==` is
      // a glob pattern and groups the same way, so it is read whole too.
      if (this.afterRegexOperator || this.afterPatternOperator) {
        this.afterRegexOperator = false;
        this.afterPatternOperator = false;
        if (!this.src.startsWith("]]", this.pos)) {
          this.readRegexWord();
          continue;
        }
      }

      if (ch === "<" || ch === ">") {
        // zsh: `<->` and `<1-9>` are numeric ranges wherever a pattern may
        // appear, not redirects. No redirect has that shape. `<` is not a word
        // character, so the range is taken here rather than left to readWord,
        // which would consume nothing and spin.
        if (this.atNumericRange()) {
          this.readWord();
          continue;
        }

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

      // Digit(s) before redirect: e.g. 2> or 10>&1
      if (ch >= "0" && ch <= "9") {
        let i = this.pos;
        while (i < this.src.length && this.src[i]! >= "0" && this.src[i]! <= "9") i++;
        if (i < this.src.length && (this.src[i] === ">" || this.src[i] === "<")) {
          this.readRedirectOrProcessSub();
          continue;
        }
      }

      // `&>`/`&>>` redirect both stdout and stderr — checked before the plain
      // `&` operator so `make &> build.log` doesn't tokenize as a backgrounded
      // `make` followed by an unrelated `>` redirect.
      if (ch === "&" && this.src[this.pos + 1] === ">") {
        this.readAmpersandRedirect();
        continue;
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
        const closesArray = ch === ")" && this.arrayLiteralDepth > 0;
        const declarationContext = this.inDeclarationCommand;

        this.tokens.push({
          type: TokenType.Operator,
          value: ch,
          range: { start: this.pos, end: this.pos + 1 },
        });
        this.pos++;
        if (opensArray) this.arrayLiteralDepth++;
        if (closesArray) this.arrayLiteralDepth--;
        // Both ends of a group open a command position: `(` starts the one
        // inside, and after `)` a new command may follow — the body of a case
        // item begins right there, keywords and all.
        if (ch === "(" || ch === ")") this.atCommandStart = true;
        if (opensArray) this.inDeclarationCommand = declarationContext;
        if (ch === ")") this.recordFunctionDefinition();
        continue;
      }

      if (ch === "{" || ch === "}") {
        // A `{` that opens a group is followed by a blank — that is the rule
        // the shell enforces by insisting on the space in `{ cmd; }`. Without
        // one the brace belongs to the word, where `{a,b}` and `{0..9}` expand
        // and `{}` is literal. The closing `}` comes back with it.
        if (ch === "{" && !/[\s\n;]/.test(this.src[this.pos + 1] ?? " ")) {
          this.readWord();
          continue;
        }

        // In bash, a `}` not at command position is an ordinary word (e.g. `echo }`
        // or `{ echo }; }`). In zsh, a lone `}` mid-command is rejected as an
        // unexpected operator/closer, but `}word` is still a word.
        if (ch === "}" && !this.atCommandStart) {
          if (this.dialect !== "zsh" || !/[\s\n;]/.test(this.src[this.pos + 1] ?? " ")) {
            this.readWord();
            continue;
          }
        }

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

  /** zsh's `<->`, `<1-9>` and friends — no redirect has that shape */
  private atNumericRange(): boolean {
    return (
      this.dialect === "zsh" &&
      this.src[this.pos] === "<" &&
      /^<\d*-\d*>/.test(this.src.slice(this.pos, this.pos + 24))
    );
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length) {
      // A backslash-newline is a line continuation. The shell removes it before
      // parsing, so no token stands for it and the line it joins reads as one.
      if (this.src[this.pos] === "\\" && this.src[this.pos + 1] === "\n") {
        this.pos += 2;
        continue;
      }
      if (!isWhitespace(this.src[this.pos]!)) break;
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
      // zsh spells `;;&` as `;|`
      else if (this.dialect === "zsh" && ch === ";" && next === "|") { value = ";|"; this.pos++; }
    }

    this.tokens.push({
      type: TokenType.Operator,
      value,
      range: { start, end: this.pos },
    });
    this.atCommandStart = true;
  }

  private readAmpersandRedirect(): void {
    const start = this.pos;
    this.pos += 2; // consume "&>"
    let op = "&>";
    if (this.src[this.pos] === ">") {
      op = "&>>";
      this.pos++;
    }
    this.tokens.push({
      type: TokenType.Redirect,
      value: op,
      range: { start, end: this.pos },
    });
    this.beginRedirectTarget();
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
          this.beginRedirectTarget();

          // Read the delimiter with the same reader the nested scanners use, so
          // the two cannot disagree about what ends a body
          this.skipWhitespace();
          const delimStart = this.pos;
          const { delimiter, quoted, next } = readHereDocDelimiter(this.src, this.pos);
          this.pos = next;

          // Emit the delimiter as written, quotes included, so the parser can
          // tell `<<EOF` (expands) from `<<'EOF'` (literal).
          this.tokens.push({
            type: TokenType.Word,
            value: this.src.slice(delimStart, this.pos),
            range: { start: delimStart, end: this.pos },
          });

          this.pendingHereDocs.push({ delimiter, stripTabs });
          this.finishRedirectTarget();
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
    this.beginRedirectTarget();
  }

  private beginRedirectTarget(): void {
    this.commandStartBeforeRedirectTarget = this.atCommandStart;
    this.atCommandStart = false;
  }

  private finishRedirectTarget(): void {
    const commandStart = this.commandStartBeforeRedirectTarget;
    this.commandStartBeforeRedirectTarget = null;
    if (commandStart !== null) this.atCommandStart = commandStart;
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
    let unterminated = false;
    const joins: number[] = [];

    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;

      if (ch === "\\") {
        // A continuation joins the word to the next line and contributes
        // nothing to it: `PATH=/a\<newline>/b` is one value. The parser still
        // needs to know where the two characters went, or every offset it
        // computes past this point lands two short of the source.
        if (this.src[this.pos + 1] === "\n") {
          joins.push(value.length);
          this.pos += 2;
          continue;
        }

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
        // Single-quoted string: no expansions. After `$` it is the `$'…'` form,
        // where backslash escapes do work — including `\'`, which a plain
        // single-quoted string cannot contain at all.
        const ansiC = value.endsWith("$");
        value += ch;
        this.pos++;
        while (this.pos < this.src.length && this.src[this.pos] !== "'") {
          if (ansiC && this.src[this.pos] === "\\" && this.pos + 1 < this.src.length) {
            value += this.src[this.pos]! + this.src[this.pos + 1]!;
            this.pos += 2;
            continue;
          }
          value += this.src[this.pos];
          this.pos++;
        }
        if (this.pos < this.src.length) {
          value += "'";
          this.pos++;
        } else {
          unterminated = true;
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
            value += this.readDollar(true);
          } else if (c === "`") {
            const bt = this.readBacktick();
            value += bt.text;
            if (!bt.closed) unterminated = true;
          } else {
            value += c;
            this.pos++;
          }
        }
        if (this.pos < this.src.length) {
          value += '"';
          this.pos++;
        } else {
          unterminated = true;
        }
        continue;
      }

      if (ch === "$") {
        value += this.readDollar();
        continue;
      }

      if (ch === "`") {
        const bt = this.readBacktick();
        value += bt.text;
        if (!bt.closed) unterminated = true;
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

      // zsh: a `(…)` that closes a word is a glob qualifier — `bin(N)`,
      // `functions(-/FN)` — and belongs to it. An empty group is the `()` of a
      // function definition, and a trailing `=` opens an array literal, so
      // neither is absorbed.
      if (this.dialect === "zsh" && ch === "(" && this.pos > start &&
          !value.endsWith("=") && this.qualifierGroupLength() > 0) {
        value += this.readParenGroup(false);
        continue;
      }

      // zsh: `<->` is a numeric range, and it may sit inside a larger pattern
      // as in `$dir/<->-<->.data`. `<` is otherwise not a word character.
      if (this.atNumericRange()) {
        const match = /^<\d*-\d*>/.exec(this.src.slice(this.pos, this.pos + 24))!;
        value += match[0];
        this.pos += match[0].length;
        continue;
      }

      // An arithmetic array subscript may contain unquoted spaces. Keep the
      // balanced bracket group inside a potential assignment target, but only
      // when it is followed immediately by = or +=; ordinary words and glob
      // brackets must still stop at shell whitespace.
      if (
        ch === "[" &&
        (this.atCommandStart || this.inDeclarationCommand) &&
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
      ) {
        const bracket = readBalanced(this.src, this.pos, "[", "]");
        const suffix = this.src.slice(bracket.next, bracket.next + 2);
        if (bracket.closed && (suffix.startsWith("=") || suffix === "+=")) {
          value += this.src.slice(this.pos, bracket.next);
          this.pos = bracket.next;
          continue;
        }
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

    const isRedirectTarget = this.commandStartBeforeRedirectTarget !== null;

    // Check for [[ keyword (two chars)
    if (!isRedirectTarget && (value === "[[" || value === "]]")) {
      this.tokens.push({
        type: TokenType.Keyword,
        value,
        range: { start, end: this.pos },
      });
      this.atCommandStart = value === "[[";
      this.inTestCommand = value === "[[";
      return;
    }

    // Determine if this is a keyword, assignment, or word. `repeat` is a
    // keyword only in zsh; in bash it is an ordinary command name.
    if (this.arrayLiteralDepth === 0 && this.atCommandStart &&
        (KEYWORDS.has(value) || (this.dialect === "zsh" && value === "repeat"))) {
      this.tokens.push({
        type: TokenType.Keyword,
        value,
        range: { start, end: this.pos },
      });
      // Keywords like do, then, { start a new command context. `if`, `while`
      // and `until` do too — a command follows each of them, and without this
      // the `!` in `if ! grep …` arrives as a word and stops negating.
      const startsCommand = ["do", "then", "else", "elif", "!", "[[", "if", "while", "until", "time"].includes(value);
      this.atCommandStart = startsCommand;
      this.afterTimeKeyword = value === "time";
      return;
    }

    // Assignment: NAME=, NAME+=, NAME[sub]=, NAME[sub]+=
    // Valid at command start, and after a declaration builtin, where the
    // assignment is an argument: `declare -a X=(1 2)`
    if (!isRedirectTarget && hasEquals && equalsPos > 0 &&
        (this.atCommandStart || this.inDeclarationCommand)) {
      const name = value.slice(0, equalsPos);
      if (/^[a-zA-Z_][a-zA-Z0-9_]*(\[[^\]]+\])?\+?$/.test(name)) {
        this.tokens.push({
          type: TokenType.Assignment,
          value,
          range: { start, end: this.pos },
          ...(joins.length > 0 ? { joins } : {}),
          ...(unterminated ? { unterminated: true as const } : {}),
        });
        return;
      }
    }

    const wasCommandStart = this.atCommandStart;
    const wasAfterTime = this.afterTimeKeyword;
    this.afterTimeKeyword = false;
    const afterFunctionKeyword = this.lastTokenIs(TokenType.Keyword, "function");
    this.tokens.push({
      type: TokenType.Word,
      value,
      range: { start, end: this.pos },
      ...(joins.length > 0 ? { joins } : {}),
      ...(unterminated ? { unterminated: true as const } : {}),
    });

    if (isRedirectTarget) {
      this.finishRedirectTarget();
      return;
    }

    this.atCommandStart = wasAfterTime && (value === "-p" || value === "--");

    if (afterFunctionKeyword) this.definedFunctions.add(value);

    // A user function of the same name shadows the builtin
    if (this.arrayLiteralDepth === 0 && wasCommandStart &&
        DECLARATION_BUILTINS.has(value) && !this.definedFunctions.has(value)) {
      this.inDeclarationCommand = true;
    }
    if (this.inTestCommand && value === "=~") {
      this.afterRegexOperator = true;
    }
    // zsh compares with a glob pattern here, where `(a|b)` groups and `<1->`
    // is a number rather than a redirect
    if (this.dialect === "zsh" && this.inTestCommand && (value === "==" || value === "!=" || value === "=")) {
      this.afterPatternOperator = true;
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
      if (ch === "\\") {
        this.pos += this.pos + 1 < this.src.length ? 2 : 1;
        continue;
      }
      if (ch === "'" || ch === '"') { this.pos = skipQuoted(this.src, this.pos); continue; }

      // An expansion is one unit: the space in `${cached% *}` is inside it and
      // does not end the operand
      if (ch === "$" && (this.src[this.pos + 1] === "{" || this.src[this.pos + 1] === "(")) {
        this.readDollar();
        continue;
      }

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
   * Length of the `(…)` group at the cursor when it could be a glob qualifier:
   * one line, balanced, and no `$(` or backtick inside, since a substitution
   * there means the parens are shell code rather than qualifier characters.
   * Returns 0 when it does not qualify.
   */
  private qualifierGroupLength(): number {
    let depth = 0;

    for (let i = this.pos; i < this.src.length; i++) {
      const ch = this.src[i]!;
      if (ch === "\n" || ch === "`") return 0;
      if (ch === "$" && this.src[i + 1] === "(") return 0;

      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i - this.pos - 1;
      }
    }

    return 0;
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
      const extent = readExpansionExtent(raw, pos, this.dialect);
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

  /**
   * Read a delimited region, with `this.pos` just past its opener. Delegates
   * to the shared scanner in scan.ts — see its doc comment for the rules.
   */
  private readBalanced(open: string, close: string, depth: number = 1, shellCode: boolean = false, nestLoneBraces: boolean = false): { text: string; closed: boolean } {
    const result = readBalanced(this.src, this.pos - 1, open, close, depth, shellCode, nestLoneBraces);
    this.pos = result.next;
    return { text: result.body, closed: result.closed };
  }

  /** Read a $... expansion and return the raw text */
  private readDollar(quoted: boolean = false): string {
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
      // ${...} parameter expansion. Unquoted, zsh nests lone braces; inside
      // double quotes it closes at the first `}` like bash does everywhere.
      this.pos++;
      const { text, closed } = this.readBalanced("{", "}", 1, false, !quoted && this.dialect === "zsh");
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
  private readBacktick(): { text: string; closed: boolean } {
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
    const closed = this.pos < this.src.length;
    if (closed) {
      result += "`";
      this.pos++;
    }
    return { text: result, closed };
  }

  /** Read a parenthesized group: ( ... ) tracking nesting */
  private readParenGroup(shellCode: boolean = true): string {
    this.pos++; // skip (
    const { text, closed } = this.readBalanced("(", ")", 1, shellCode);
    return "(" + text + (closed ? ")" : "");
  }
}

export function tokenize(src: string, options: ParseOptions = {}): Token[] {
  return new Tokenizer(src, options).tokenize();
}
