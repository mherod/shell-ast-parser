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

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

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
    ch !== ">" &&
    ch !== "#"
  );
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
  /** Whether the last non-whitespace token allows a keyword next */
  private atCommandStart: boolean = true;

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

      if (ch === "<" || ch === ">") {
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

      if (ch === "(" || ch === ")") {
        this.tokens.push({
          type: TokenType.Operator,
          value: ch,
          range: { start: this.pos, end: this.pos + 1 },
        });
        this.pos++;
        if (ch === "(") this.atCommandStart = true;
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
      else if (ch === ";" && next === ";") { value = ";;"; this.pos++; }
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

    // Assignment: NAME=... or NAME+=... (only when at command start position)
    if (hasEquals && equalsPos > 0 && this.atCommandStart) {
      const name = value.slice(0, equalsPos);
      if (/^[a-zA-Z_][a-zA-Z0-9_]*\+?$/.test(name)) {
        this.tokens.push({
          type: TokenType.Assignment,
          value,
          range: { start, end: this.pos },
        });
        return;
      }
    }

    this.tokens.push({
      type: TokenType.Word,
      value,
      range: { start, end: this.pos },
    });
    this.atCommandStart = false;
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
   */
  private readBalanced(open: string, close: string, depth: number = 1): { text: string; closed: boolean } {
    const extraClosers = depth - 1;
    const start = this.pos;
    let closed = false;

    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;

      if (ch === "\\") { this.pos += 2; continue; }
      if (ch === "'" || ch === '"') { this.skipQuoted(ch); continue; }

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
        // $( command substitution )
        const { text, closed } = this.readBalanced("(", ")");
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
  private readParenGroup(): string {
    this.pos++; // skip (
    const { text, closed } = this.readBalanced("(", ")");
    return "(" + text + (closed ? ")" : "");
  }
}

export function tokenize(src: string): Token[] {
  return new Tokenizer(src).tokenize();
}
