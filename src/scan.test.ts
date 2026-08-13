import { test, expect, describe } from "bun:test";
import { matchDelimiter, readBalanced, readExpansionExtent, skipQuoted, startsWord } from "./scan.ts";

// These four cases were, before the extraction into scan.ts, each implemented
// twice — once in tokenizer.ts and once in parser.ts — and had drifted apart
// (fixed in 8bba9dc). They are pinned here directly against the shared
// scanner so a future edit to one caller cannot silently diverge from the
// other again.

describe("scan: quote-aware paren matching", () => {
  test("a quoted close-paren does not end the group", () => {
    // ("a)b"|c) — the quoted `)` belongs to the string, not the group
    const text = `("a)b"|c)`;
    const end = matchDelimiter(text, 0, "(", ")");
    expect(end).toBe(text.length);
  });

  test("an unquoted close-paren ends the group", () => {
    const text = "(a|b)";
    expect(matchDelimiter(text, 0, "(", ")")).toBe(text.length);
  });

  test("unbalanced input returns -1", () => {
    expect(matchDelimiter("(a", 0, "(", ")")).toBe(-1);
  });
});

describe("scan: dialect-threaded expansion extent", () => {
  test("zsh reads $#name as the length of name", () => {
    const text = "$#arr + 1";
    expect(readExpansionExtent(text, 0, "zsh")).toBe("$#arr".length);
  });

  test("bash reads $# and stops, leaving name as a separate word", () => {
    const text = "$#arr";
    expect(readExpansionExtent(text, 0, "bash")).toBe("$#".length);
  });

  test("dialect defaults to bash when omitted", () => {
    expect(readExpansionExtent("$#arr", 0)).toBe("$#".length);
  });
});

describe("scan: ${ nesting rule", () => {
  test("bash (nestLoneBraces off) ends at the first unmatched }", () => {
    // ${x:-a{b}c} — bash stops at the first `}`, leaving `c}` as literal text
    const text = "${x:-a{b}c}";
    const end = matchDelimiter(text, 1, "{", "}", 1, false);
    expect(text.slice(0, end)).toBe("${x:-a{b}");
  });

  test("zsh (nestLoneBraces on) nests every lone {", () => {
    const text = "${x:-a{b}c}";
    const end = matchDelimiter(text, 1, "{", "}", 1, true);
    expect(end).toBe(text.length);
  });
});

describe("scan: heredoc stepping inside a balanced region", () => {
  test("a ) inside a heredoc body does not close the surrounding $( )", () => {
    const src = "cat <<EOF\n)\nEOF\n)rest";
    // open at -1 so start = 0, matching the body right after "$("
    const result = readBalanced(src, -1, "(", ")", 1, true);
    expect(result.closed).toBe(true);
    expect(result.body).toBe("cat <<EOF\n)\nEOF\n");
    expect(result.next).toBe(src.indexOf("rest"));
  });

  test("shellCode off does not step over heredocs — the body's ) closes early", () => {
    const src = "cat <<EOF\n)\nEOF\n)rest";
    const result = readBalanced(src, -1, "(", ")", 1, false);
    expect(result.body).toBe("cat <<EOF\n");
  });
});

describe("scan: shared primitives", () => {
  test("skipQuoted respects double-quote escapes only", () => {
    expect(skipQuoted('"a\\"b"c', 0)).toBe('"a\\"b"'.length);
    expect(skipQuoted("'a\\'b'c", 0)).toBe("'a\\'".length);
  });

  test("startsWord is true at region start and after word-ending operators", () => {
    expect(startsWord("#c", 0, 0)).toBe(true);
    expect(startsWord("a;#c", 2, 0)).toBe(true);
    expect(startsWord("a#c", 1, 0)).toBe(false);
  });
});
