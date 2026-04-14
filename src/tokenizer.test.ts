import { test, expect, describe } from "bun:test";
import { tokenize, TokenType } from "./tokenizer.ts";

function types(src: string) {
  return tokenize(src).map(t => t.type);
}

function values(src: string) {
  return tokenize(src).map(t => t.value);
}

describe("tokenizer", () => {
  test("simple command", () => {
    const tokens = tokenize("echo hello");
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("echo");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("hello");
  });

  test("assignment", () => {
    const tokens = tokenize('NAME="world"');
    expect(tokens[0]!.type).toBe(TokenType.Assignment);
    expect(tokens[0]!.value).toBe('NAME="world"');
  });

  test("empty assignment", () => {
    const tokens = tokenize("EMPTY=");
    expect(tokens[0]!.type).toBe(TokenType.Assignment);
    expect(tokens[0]!.value).toBe("EMPTY=");
  });

  test("pipeline", () => {
    const vals = values("cat file | grep pattern | head -5");
    expect(vals).toContain("|");
  });

  test("operators && || ;", () => {
    const vals = values("a && b || c; d");
    expect(vals).toContain("&&");
    expect(vals).toContain("||");
    expect(vals).toContain(";");
  });

  test("redirections", () => {
    const tokens = tokenize("echo hello > out.txt 2>&1");
    const redirs = tokens.filter(t => t.type === TokenType.Redirect);
    expect(redirs.length).toBe(2);
    expect(redirs[0]!.value).toBe(">");
    expect(redirs[1]!.value).toBe("2>&");
  });

  test("heredoc", () => {
    const tokens = tokenize("cat <<EOF\nhello world\nEOF\n");
    expect(tokens.some(t => t.type === TokenType.Redirect && t.value === "<<")).toBe(true);
    expect(tokens.some(t => t.type === TokenType.HereDocBody)).toBe(true);
  });

  test("single quoted string", () => {
    const tokens = tokenize("echo 'hello world'");
    expect(tokens[1]!.value).toBe("'hello world'");
  });

  test("double quoted string with escapes", () => {
    const tokens = tokenize('echo "hello \\"world\\""');
    expect(tokens[1]!.type).toBe(TokenType.Word);
  });

  test("variable expansion $NAME", () => {
    const tokens = tokenize('echo "$NAME"');
    expect(tokens[1]!.value).toContain("$NAME");
  });

  test("braced expansion ${NAME:-default}", () => {
    const tokens = tokenize('echo "${NAME:-default}"');
    expect(tokens[1]!.value).toContain("${NAME:-default}");
  });

  test("command substitution $()", () => {
    const tokens = tokenize("echo $(date)");
    expect(tokens[1]!.value).toBe("$(date)");
  });

  test("backtick command substitution", () => {
    const tokens = tokenize("echo `date`");
    expect(tokens[1]!.value).toBe("`date`");
  });

  test("arithmetic expansion", () => {
    const tokens = tokenize("echo $((1 + 2))");
    expect(tokens[1]!.value).toBe("$((1 + 2))");
  });

  test("keywords recognized at command position", () => {
    const tokens = tokenize("if true; then echo hi; fi");
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("if");
  });

  test("keyword not recognized as argument", () => {
    const tokens = tokenize("echo if");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("if");
  });

  test("comments", () => {
    const tokens = tokenize("echo hello # this is a comment\necho bye");
    expect(tokens.some(t => t.type === TokenType.Comment)).toBe(true);
  });

  test("newlines are tokens", () => {
    const tokens = tokenize("echo a\necho b");
    expect(tokens.some(t => t.type === TokenType.Newline)).toBe(true);
  });

  test("subshell parens", () => {
    const vals = values("(echo hello)");
    expect(vals[0]).toBe("(");
    expect(vals[vals.length - 2]).toBe(")");
  });

  test("brace group", () => {
    const tokens = tokenize("{ echo hello; }");
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("{");
  });

  test("for loop tokens", () => {
    const tokens = tokenize("for i in 1 2 3; do echo $i; done");
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("for");
    expect(tokens.some(t => t.value === "do")).toBe(true);
    expect(tokens.some(t => t.value === "done")).toBe(true);
  });

  test("case tokens", () => {
    const tokens = tokenize('case "$x" in\na) echo a;;\nesac');
    expect(tokens[0]!.value).toBe("case");
    expect(tokens.some(t => t.value === "in")).toBe(true);
    expect(tokens.some(t => t.value === "esac")).toBe(true);
    expect(tokens.some(t => t.value === ";;")).toBe(true);
  });

  test("function definition with parens", () => {
    const tokens = tokenize("greet() { echo hi; }");
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("greet");
    expect(tokens[1]!.value).toBe("(");
    expect(tokens[2]!.value).toBe(")");
  });

  test("function keyword", () => {
    const tokens = tokenize("function cleanup { echo done; }");
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("function");
  });

  test("background &", () => {
    const vals = values("sleep 10 &");
    expect(vals).toContain("&");
  });

  test("process substitution <()", () => {
    const tokens = tokenize("diff <(ls /tmp) <(ls /var)");
    expect(tokens[0]!.value).toBe("diff");
    // Process sub should be read as word tokens
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toContain("<(");
  });

  test("double bracket [[", () => {
    const tokens = tokenize('[[ "$x" == y ]]');
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("[[");
  });

  test("ranges are correct", () => {
    const src = "echo hello";
    const tokens = tokenize(src);
    expect(src.slice(tokens[0]!.range.start, tokens[0]!.range.end)).toBe("echo");
    expect(src.slice(tokens[1]!.range.start, tokens[1]!.range.end)).toBe("hello");
  });

  test("EOF at end", () => {
    const tokens = tokenize("echo hi");
    expect(tokens[tokens.length - 1]!.type).toBe(TokenType.EOF);
  });
});
