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

describe("assignment-like words that are not assignments", () => {
  test("a + elsewhere in the name is not an assignment", () => {
    expect(tokenize("a+b=c")[0]!.type).toBe(TokenType.Word);
  });

  test("+= with no name is not an assignment", () => {
    expect(tokenize("+=x")[0]!.type).toBe(TokenType.Word);
  });

  test("a name that is not an identifier stays a word", () => {
    expect(tokenize("[0]=x")[0]!.type).toBe(TokenType.Word);
    expect(tokenize("file[0].txt=x")[0]!.type).toBe(TokenType.Word);
  });
});

describe("delimiters inside quotes", () => {
  test("a quoted ) does not end a command substitution", () => {
    expect(values('echo $(grep ")" f)')).toEqual(["echo", '$(grep ")" f)', ""]);
  });

  test("a single-quoted ) does not end a command substitution", () => {
    expect(values("echo $(grep ')' f)")).toEqual(["echo", "$(grep ')' f)", ""]);
  });

  test("a substitution inside double quotes keeps its own quotes", () => {
    expect(values('echo "$(grep ")" f)"')).toEqual(["echo", '"$(grep ")" f)"', ""]);
  });

  test("arithmetic keeps nested parens and consumes both closers", () => {
    expect(values("echo $((a+(b*c)))")).toEqual(["echo", "$((a+(b*c)))", ""]);
  });

  test("a backtick substitution inside double quotes", () => {
    expect(values('echo "`grep ")" f`"')).toEqual(["echo", '"`grep ")" f`"', ""]);
  });

  test("an escaped ) does not end a command substitution", () => {
    expect(values("echo $(echo \\) done)")).toEqual(["echo", "$(echo \\) done)", ""]);
  });

  test("a quoted ) does not end a process substitution", () => {
    expect(values('diff <(grep ")" a) b')).toEqual(["diff", '<(grep ")" a)', "b", ""]);
  });
});

describe("comments", () => {
  test("# mid-word is an ordinary character", () => {
    expect(values("echo a#b")).toEqual(["echo", "a#b", ""]);
  });

  test("# at word start still opens a comment", () => {
    expect(tokenize("echo a #b").filter(t => t.type === TokenType.Comment).map(t => t.value)).toEqual(["#b"]);
  });

  test("a fragment URL survives as one assignment", () => {
    const toks = tokenize("url=http://x#frag");
    expect(toks[0]!.type).toBe(TokenType.Assignment);
    expect(toks[0]!.value).toBe("url=http://x#frag");
  });

  test("a comment inside $( ) does not end the substitution", () => {
    expect(values("echo $(echo hi # )")).toEqual(["echo", "$(echo hi # )", ""]);
  });

  test("a comment inside <( ) does not end it either", () => {
    expect(values("diff <(ls # )")).toEqual(["diff", "<(ls # )", ""]);
  });

  test("a quoted # inside a substitution is not a comment", () => {
    expect(values("echo $(echo '#')")).toEqual(["echo", "$(echo '#')", ""]);
  });
});

describe("redirects after a compound command", () => {
  test("redirection still works after the test ends", () => {
    const redirects = tokenize("[[ a < b ]]; cat <f").filter(t => t.type === TokenType.Redirect);
    expect(redirects.map(t => t.value)).toEqual(["<"]);
  });
});

describe("the zsh dialect", () => {
  test("repeat is a keyword only in zsh", () => {
    expect(tokenize("repeat 3 do :; done", { dialect: "zsh" })[0]!.type).toBe(TokenType.Keyword);
    expect(tokenize("repeat 3", { dialect: "bash" })[0]!.type).toBe(TokenType.Word);
  });

  test("a glob qualifier group stays inside its word", () => {
    const vals = tokenize("print *(.)", { dialect: "zsh" })
      .filter(t => t.type !== TokenType.EOF)
      .map(t => t.value);
    expect(vals).toEqual(["print", "*(.)"]);
  });

  test("a numeric range stays inside its word", () => {
    const tokens = tokenize("echo <1->", { dialect: "zsh" });
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("<1->");
  });

  test("$#name inside arithmetic is read as one length operand under zsh", () => {
    // zsh -c 'arr=(a b c); echo $(( $#arr + 1 ))' prints 4 — this only tokenizes
    // as one Arithmetic token when the trial parse reads $#arr as a single
    // operand, which needs the dialect threaded into the expansion-extent reader.
    const tokens = tokenize("(( $#arr + 1 ))", { dialect: "zsh" }).filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.type).toBe(TokenType.Arithmetic);
  });

  test("case terminator ;| is read as one operator", () => {
    const vals = tokenize("case $x in a) echo hi;| esac", { dialect: "zsh" }).map(t => t.value);
    expect(vals).toContain(";|");
  });

  test("a lone } mid-command is an operator in zsh but a word in bash", () => {
    const zshToks = tokenize("echo }", { dialect: "zsh" });
    expect(zshToks[1]!.type).toBe(TokenType.Operator);
    expect(zshToks[1]!.value).toBe("}");

    const bashToks = tokenize("echo }", { dialect: "bash" });
    expect(bashToks[1]!.type).toBe(TokenType.Word);
    expect(bashToks[1]!.value).toBe("}");
  });

  test("} at command start is a keyword in both dialects", () => {
    expect(tokenize("}", { dialect: "bash" })[0]!.type).toBe(TokenType.Keyword);
    expect(tokenize("}", { dialect: "zsh" })[0]!.type).toBe(TokenType.Keyword);
  });
});

describe("heredoc delimiter spelling", () => {
  test("EOF, 'EOF', \"EOF\", and \\EOF all keep their spelling in the delimiter token", () => {
    for (const [open, expectedValue] of [
      ["<<EOF", "EOF"],
      ["<<'EOF'", "'EOF'"],
      ['<<"EOF"', '"EOF"'],
      ["<<\\EOF", "\\EOF"],
    ] as const) {
      const tokens = tokenize(`cat ${open}\nbody\nEOF\n`);
      expect(tokens[1]!.type).toBe(TokenType.Redirect);
      expect(tokens[2]!.type).toBe(TokenType.Word);
      expect(tokens[2]!.value).toBe(expectedValue);
    }
  });

  test("<<- is a distinct redirect operator from <<", () => {
    const tokens = tokenize("cat <<-EOF\n\tbody\n\tEOF\n");
    expect(tokens[1]!.type).toBe(TokenType.Redirect);
    expect(tokens[1]!.value).toBe("<<-");
  });

  test("the heredoc token sequence: Word, Redirect, Word, Newline, HereDocBody", () => {
    const seq = types("cat <<EOF\nbody\nEOF\n");
    expect(seq.slice(0, 5)).toEqual([
      TokenType.Word,
      TokenType.Redirect,
      TokenType.Word,
      TokenType.Newline,
      TokenType.HereDocBody,
    ]);
  });
});

describe("heredocs and here-strings inside substitutions", () => {
  test("a ) in the body does not close the substitution", () => {
    const src = "x=$(cat <<EOF\na ) b\nEOF\n)";
    expect(values(src)).toEqual([src, ""]);
  });

  test("an unbalanced quote in the body is inert", () => {
    const src = 'x=$(cat <<EOF\nits " odd\nEOF\n)';
    expect(values(src)).toEqual([src, ""]);
  });

  test("<<- bodies are skipped inside a substitution", () => {
    const src = "x=$(cat <<-EOF\n\tindented )\n\tEOF\n)";
    expect(values(src)).toEqual([src, ""]);
  });

  test("a quoted delimiter's body is still skipped whole", () => {
    const src = "x=$(cat <<'EOF'\n$(nope)\nEOF\n)";
    expect(values(src)).toEqual([src, ""]);
  });

  test("two heredocs in one substitution keep their own bodies", () => {
    const src = "x=$(cat <<A <<B\none )\nA\ntwo )\nB\n)";
    expect(values(src)).toEqual([src, ""]);
  });

  test("a heredoc inside a process substitution", () => {
    const src = "diff <(cat <<EOF\n)\nEOF\n) b";
    expect(values(src)).toEqual(["diff", "<(cat <<EOF\n)\nEOF\n)", "b", ""]);
  });

  test("<<< is a here-string, not a heredoc", () => {
    expect(values("x=$(echo <<<here)")).toEqual(["x=$(echo <<<here)", ""]);
  });
});
