import type { Dialect } from "./ast.ts";

/** Characters that turn `(pattern-list)` into an extended glob */
export const EXTGLOB_LEADS = "?*+@!";

export function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

/**
 * `#` is absent from this list on purpose: it only opens a comment at the start
 * of a word, which `tokenize` has already handled before `readWord` runs. Mid
 * word it is an ordinary character, so `echo a#b` is one argument.
 */
export function isWordChar(ch: string): boolean {
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
export function startsWord(text: string, pos: number, regionStart: number): boolean {
  if (pos === regionStart) return true;
  const prev = text[pos - 1]!;
  return isWhitespace(prev) || prev === "\n" || prev === ";" || prev === "&" || prev === "|" || prev === "(";
}

/** Skip a quoted span in `text`, with `pos` on the opening quote */
export function skipQuoted(text: string, pos: number): number {
  const quote = text[pos]!;
  let i = pos + 1;

  while (i < text.length && text[i] !== quote) {
    if (quote === '"' && text[i] === "\\") i += i + 1 < text.length ? 2 : 1;
    else i++;
  }

  return i < text.length ? i + 1 : i;
}

/**
 * Index just past the delimiter matching the one at `open`, or -1 when it is
 * unbalanced. Quoted spans are skipped whole. `depth` above 1 is for openers
 * spelled with repeated delimiters, like `((`.
 *
 * `nestLoneBraces` decides whether a bare `{` deepens a `${…}` scan. Off, only
 * `${` nests and the first unmatched `}` closes — how bash reads an expansion
 * everywhere, and both shells read one in arithmetic.
 */
export function matchDelimiter(
  text: string,
  open: number,
  openCh: string,
  closeCh: string,
  depth: number = 1,
  nestLoneBraces: boolean = true,
): number {
  let i = open + 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipQuoted(text, i); continue; }

    if (ch === openCh && (openCh !== "{" || nestLoneBraces || text[i - 1] === "$")) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }

  return -1;
}

/**
 * The delimiter that ends a heredoc body, with `pos` on its first character.
 * `'EOF'`, `"EOF"` and `\EOF` all name EOF and all suppress expansion in the
 * body; only the spelling differs. Keeping a backslash in the delimiter would
 * leave one no line can match, and the body would run to the end of the file.
 */
export function readHereDocDelimiter(
  text: string,
  pos: number,
): { delimiter: string; quoted: boolean; next: number } {
  let i = pos;
  let delimiter = "";
  let quoted = false;

  if (text[i] === "'" || text[i] === '"') {
    const quote = text[i]!;
    quoted = true;
    i++;
    while (i < text.length && text[i] !== quote) { delimiter += text[i]; i++; }
    if (i < text.length) i++;
  } else {
    // The delimiter is a word, so a metacharacter ends it: in
    // `cat << EOF; then` the `;` belongs to the line, not to the name of the
    // delimiter, and taking it would leave one no line can match.
    while (i < text.length && isWordChar(text[i]!)) {
      if (text[i] === "\\" && i + 1 < text.length) {
        quoted = true;
        i++;
      }
      delimiter += text[i];
      i++;
    }
  }

  return { delimiter, quoted, next: i };
}

/**
 * Read a heredoc operator's delimiter, with `pos` on the first `<`. Returns
 * null when this is not a heredoc — `<<<` is a here-string, whose operand is an
 * ordinary word rather than a body.
 */
export function readHereDocHeader(
  text: string,
  pos: number,
): { delimiter: string; stripTabs: boolean; quoted: boolean; next: number } | null {
  if (text[pos] !== "<" || text[pos + 1] !== "<" || text[pos + 2] === "<") return null;

  let i = pos + 2;
  let stripTabs = false;
  if (text[i] === "-") { stripTabs = true; i++; }
  while (i < text.length && isWhitespace(text[i]!)) i++;

  const { delimiter, quoted, next } = readHereDocDelimiter(text, i);
  return delimiter === "" ? null : { delimiter, stripTabs, quoted, next };
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
 *
 * `nestLoneBraces` is zsh's unquoted `${…}`, where every `{` deepens the scan;
 * bash counts only `${`, so its expansions end at the first unmatched `}`.
 *
 * `closed` reports whether the region actually ended before the input ran out
 * — the tokenizer needs this to decide whether it read a complete expansion.
 */
export function readBalanced(
  text: string,
  open: number,
  openCh: string,
  closeCh: string,
  depth: number = 1,
  shellCode: boolean = false,
  nestLoneBraces: boolean = false,
): { body: string; next: number; closed: boolean } {
  const extraClosers = depth - 1;
  const start = open + 1;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let i = start;
  let closed = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\") { i += i + 1 < text.length ? 2 : 1; continue; }
    if (ch === "'" || ch === '"') { i = skipQuoted(text, i); continue; }

    if (shellCode && ch === "#" && startsWord(text, i, start)) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (shellCode && ch === "<" && text[i + 1] === "<") {
      const header = readHereDocHeader(text, i);
      if (header) {
        heredocs.push({ delimiter: header.delimiter, stripTabs: header.stripTabs });
        i = header.next;
        continue;
      }
    }

    if (ch === "\n" && heredocs.length > 0) {
      i = skipHereDocBodies(text, i + 1, heredocs);
      heredocs.length = 0;
      continue;
    }

    if (ch === openCh && (openCh !== "{" || nestLoneBraces || text[i - 1] === "$")) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) { closed = true; break; }
    }
    i++;
  }

  let body = text.slice(start, i);
  if (closed) i++;
  for (let n = 0; n < extraClosers && body.endsWith(closeCh); n++) {
    body = body.slice(0, -closeCh.length);
  }

  return { body, next: i, closed };
}

/**
 * Extent of the `$…` or backtick expansion starting at `pos`, or null when
 * there is none. Shared by the arithmetic parser's two callers so both agree on
 * where an operand ends.
 *
 * `nestLoneBraces` is zsh's word-context rule, where `${x:-{}}` runs to the
 * second brace. It stays off for arithmetic, where both shells end the
 * expansion at the first `}` — `$(( ${x:-{}} ))` is an error in each.
 */
export function readExpansionExtent(
  text: string,
  pos: number,
  dialect: Dialect = "bash",
  nestLoneBraces: boolean = false,
): number | null {
  if (text[pos] === "`") {
    const close = text.indexOf("`", pos + 1);
    return close === -1 ? text.length : close + 1;
  }

  if (text[pos] !== "$") return null;
  const next = text[pos + 1];

  if (next === "{") {
    const end = matchDelimiter(text, pos + 1, "{", "}", 1, nestLoneBraces);
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

  // zsh: `$#arg` is the length of `arg`, where bash reads `$#` and then a word
  if (dialect === "zsh" && next === "#" && /[a-zA-Z_]/.test(text[pos + 2] ?? "")) {
    let end = pos + 2;
    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end]!)) end++;
    return end;
  }

  if (next !== undefined && /[0-9!?#$@*\-]/.test(next)) return pos + 2;

  return null;
}
