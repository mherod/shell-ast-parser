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

  test("&> and &>> tokenize as one Redirect, not & followed by a redirect", () => {
    const redir = tokenize("make &> build.log").filter(t => t.type === TokenType.Redirect);
    expect(redir.map(t => t.value)).toEqual(["&>"]);

    const redirAppend = tokenize("make &>> build.log").filter(t => t.type === TokenType.Redirect);
    expect(redirAppend.map(t => t.value)).toEqual(["&>>"]);
  });

  test("a bare & (not followed by >) still tokenizes as the background operator", () => {
    const vals = values("make & echo next");
    expect(vals).toContain("&");
    expect(tokenize("make & echo next").some(t => t.type === TokenType.Redirect)).toBe(false);
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

  test("an unclosed quote or backtick flags its token unterminated", () => {
    expect(tokenize("echo 'unclosed")[1]!.unterminated).toBe(true);
    expect(tokenize('echo "unclosed')[1]!.unterminated).toBe(true);
    expect(tokenize("echo `unclosed")[1]!.unterminated).toBe(true);
    expect(tokenize('NAME="unclosed')[0]!.unterminated).toBe(true);
  });

  test("a closed quote or backtick leaves the token unflagged", () => {
    expect(tokenize("echo 'closed'")[1]!.unterminated).toBeUndefined();
    expect(tokenize('echo "closed"')[1]!.unterminated).toBeUndefined();
    expect(tokenize("echo `closed`")[1]!.unterminated).toBeUndefined();
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
  test("quoted and unquoted delimiter fragments form one word", () => {
    const source = "cat <<'E'OF\nbody\nEOF\n";
    const tokens = tokenize(source);
    const body = tokens.find(token => token.type === TokenType.HereDocBody);

    expect(tokens[2]!.type).toBe(TokenType.Word);
    expect(tokens[2]!.value).toBe("'E'OF");
    expect(body?.value).toBe("body\n");
  });

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

describe("complex quoting & word concatenation tokenization", () => {
  test("adjacent mixed quote styles tokenize as a single word", () => {
    const tokens = tokenize("prefix'single'\"double\"$'ansi'$ \"loc\"suffix").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(2);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("prefix'single'\"double\"$'ansi'$");
    expect(tokens[1]!.value).toBe("\"loc\"suffix");
  });

  test("empty quote strings tokenize into a single word token", () => {
    const tokens = tokenize('""\'\'$\'\'$""').filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe('""\'\'$\'\'$""');
  });

  test("escaped shell metacharacters stay inside unquoted word", () => {
    const tokens = tokenize("cmd \\  \\( \\) \\{ \\} \\; \\& \\| \\< \\>").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(11);
    expect(tokens.every(t => t.type === TokenType.Word)).toBe(true);
  });
});

describe("advanced redirection and descriptor tokenization", () => {
  test("multi-digit file descriptors tokenize as Redirect tokens with fd included", () => {
    const tokens = tokenize("cmd 10>&1 3<&- 4<in 5>>out 6<>rw >|clobber").filter(t => t.type !== TokenType.EOF);
    const redirects = tokens.filter(t => t.type === TokenType.Redirect);
    expect(redirects.map(t => t.value)).toEqual(["10>&", "3<&", "4<", "5>>", "6<>", ">|"]);
  });

  test("file descriptor movement and closing 3<&0-", () => {
    const tokens = tokenize("cmd 3<&0- 4>&1-").filter(t => t.type !== TokenType.EOF);
    const redirects = tokens.filter(t => t.type === TokenType.Redirect);
    expect(redirects.map(t => t.value)).toEqual(["3<&", "4>&"]);
  });

  test("bash variable fd allocation {fd}>file", () => {
    const tokens = tokenize("exec {my_fd}>log.txt").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.value).toBe("exec");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("{my_fd}");
    expect(tokens[2]!.type).toBe(TokenType.Redirect);
    expect(tokens[2]!.value).toBe(">");
    expect(tokens[3]!.value).toBe("log.txt");
  });
});

describe("advanced zsh tokenization constructs", () => {
  test("exhaustive zsh glob qualifiers stay in word", () => {
    const source = "print *(.) *(/) *(@) *(=) *(p) *(x) *(X) *(U) *(G) *(m-7) *(a+30) *(Lk+100) *(om[1,5]) *(On) *(-/FN) *(.^w)";
    const tokens = tokenize(source, { dialect: "zsh" }).filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(17);
    expect(tokens[0]!.value).toBe("print");
    expect(tokens.slice(1).every(t => t.type === TokenType.Word)).toBe(true);
  });

  test("zsh numeric ranges in various position patterns", () => {
    const tokens = tokenize("ls *.<1-100> data.<-50>.tar log.<10->.bak any.<->", { dialect: "zsh" }).filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(5);
    expect(tokens.every(t => t.type === TokenType.Word)).toBe(true);
  });

  test("zsh parameter flags and nested expansions", () => {
    const tokens = tokenize("echo ${(U)var} ${(j:,:)${(f)lines}}", { dialect: "zsh" }).filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(3);
    expect(tokens[1]!.value).toBe("${(U)var}");
    expect(tokens[2]!.value).toBe("${(j:,:)${(f)lines}}");
  });
});

describe("time keyword tokenization", () => {
  test("time at command position tokenizes as Keyword", () => {
    const tokens = tokenize("time ls -la").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("time");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("ls");
  });

  test("time -p keeps subsequent command keyword at command start", () => {
    const tokens = tokenize("time -p for i in 1; do :; done").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("time");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("-p");
    expect(tokens[2]!.type).toBe(TokenType.Keyword);
    expect(tokens[2]!.value).toBe("for");
  });

  test("time in argument position remains a Word", () => {
    const tokens = tokenize("echo time").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("echo");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("time");
  });

  test("! time tokenizes both as Keywords", () => {
    const tokens = tokenize("! time ls").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("!");
    expect(tokens[1]!.type).toBe(TokenType.Keyword);
    expect(tokens[1]!.value).toBe("time");
    expect(tokens[2]!.type).toBe(TokenType.Word);
    expect(tokens[2]!.value).toBe("ls");
  });
});

describe("function names with dots, dashes, and colons tokenization", () => {
  test("tokenizes function names with special characters as single Word tokens", () => {
    const tokens = tokenize("foo.bar() { echo 1; }\nmy-func() { :; }\nmodule:init() { :; }").filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Newline);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("foo.bar");
    expect(tokens[1]!.type).toBe(TokenType.Operator);
    expect(tokens[1]!.value).toBe("(");
    expect(tokens[2]!.type).toBe(TokenType.Operator);
    expect(tokens[2]!.value).toBe(")");
  });
});

describe("declaration builtins and assignment arguments", () => {
  test.each([
    ["output", ">out export X=1"],
    ["combined-stream", "&>out export X=1"],
    ["heredoc", "<<EOF export X=1\nbody\nEOF\n"],
  ] as const)("a leading %s redirect preserves declaration command position", (_kind, source) => {
    const assignment = tokenize(source).find(token => token.value === "X=1");

    expect(assignment?.type).toBe(TokenType.Assignment);
  });

  test("an assignment-like redirect target stays data inside a declaration command", () => {
    const tokens = tokenize("export >X=1 Y=2");
    const redirectTarget = tokens.find(token => token.value === "X=1");
    const declarationArgument = tokens.find(token => token.value === "Y=2");

    expect(redirectTarget?.type).toBe(TokenType.Word);
    expect(declarationArgument?.type).toBe(TokenType.Assignment);
  });

  test("export allows multiple assignment arguments", () => {
    const tokens = tokenize("export FOO=1 BAR=2 BAZ=3").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("export");
    expect(tokens[1]!.type).toBe(TokenType.Assignment);
    expect(tokens[1]!.value).toBe("FOO=1");
    expect(tokens[2]!.type).toBe(TokenType.Assignment);
    expect(tokens[2]!.value).toBe("BAR=2");
    expect(tokens[3]!.type).toBe(TokenType.Assignment);
    expect(tokens[3]!.value).toBe("BAZ=3");
  });

  test("declare, typeset, local, readonly allow options before assignments", () => {
    for (const cmd of ["declare", "typeset", "local", "readonly"] as const) {
      const tokens = tokenize(`${cmd} -r -x MY_VAR="test"`).filter(t => t.type !== TokenType.EOF);
      expect(tokens[0]!.type).toBe(TokenType.Word);
      expect(tokens[0]!.value).toBe(cmd);
      expect(tokens[1]!.type).toBe(TokenType.Word);
      expect(tokens[1]!.value).toBe("-r");
      expect(tokens[2]!.type).toBe(TokenType.Word);
      expect(tokens[2]!.value).toBe("-x");
      expect(tokens[3]!.type).toBe(TokenType.Assignment);
      expect(tokens[3]!.value).toBe('MY_VAR="test"');
    }
  });

  test("declare with array literal assignment preserves declaration context", () => {
    const tokens = tokenize("declare -a ARR=(1 2 3) Y=4").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.value).toBe("declare");
    expect(tokens[1]!.value).toBe("-a");
    expect(tokens[2]!.type).toBe(TokenType.Assignment);
    expect(tokens[2]!.value).toBe("ARR=");
    expect(tokens[3]!.type).toBe(TokenType.Operator);
    expect(tokens[3]!.value).toBe("(");
    expect(tokens[4]!.value).toBe("1");
    expect(tokens[5]!.value).toBe("2");
    expect(tokens[6]!.value).toBe("3");
    expect(tokens[7]!.type).toBe(TokenType.Operator);
    expect(tokens[7]!.value).toBe(")");
    expect(tokens[8]!.type).toBe(TokenType.Assignment);
    expect(tokens[8]!.value).toBe("Y=4");
  });

  test("non-declaration command arguments with = stay Word tokens", () => {
    const tokens = tokenize("echo FOO=1 BAR=2").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.value).toBe("echo");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("FOO=1");
    expect(tokens[2]!.type).toBe(TokenType.Word);
    expect(tokens[2]!.value).toBe("BAR=2");
  });

  test("declaration context resets at command boundaries (; \\n && || |)", () => {
    const semiTokens = tokenize("export FOO=1; echo BAR=2").filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Operator);
    expect(semiTokens[0]!.type).toBe(TokenType.Word);
    expect(semiTokens[1]!.type).toBe(TokenType.Assignment);
    expect(semiTokens[2]!.type).toBe(TokenType.Word);
    expect(semiTokens[3]!.type).toBe(TokenType.Word);

    const newlineTokens = tokenize("local X=1\necho Y=2").filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Newline);
    expect(newlineTokens[1]!.type).toBe(TokenType.Assignment);
    expect(newlineTokens[3]!.type).toBe(TokenType.Word);

    const andTokens = tokenize("typeset A=1 && echo B=2").filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Operator);
    expect(andTokens[1]!.type).toBe(TokenType.Assignment);
    expect(andTokens[3]!.type).toBe(TokenType.Word);

    const pipeTokens = tokenize("readonly C=1 | cat D=2").filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Operator);
    expect(pipeTokens[1]!.type).toBe(TokenType.Assignment);
    expect(pipeTokens[3]!.type).toBe(TokenType.Word);
  });
});

describe("declaration builtin shadowing by user functions", () => {
  test("array elements cannot shadow declaration builtins", () => {
    const tokens = tokenize("arr=(function export); export X=1");
    const assignment = tokens.find(token => token.value === "X=1");

    expect(assignment?.type).toBe(TokenType.Assignment);
  });

  test("declaration builtin names stay data inside array literals", () => {
    const tokens = tokenize("arr=(export X=1)");
    const element = tokens.find(token => token.value === "X=1");

    expect(element?.type).toBe(TokenType.Word);
  });

  test("defining a function shadows declaration builtins from that point forward", () => {
    const src = "export() { echo custom; }; export x=1";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Operator && t.type !== TokenType.Keyword);
    expect(tokens[0]!.value).toBe("export");
    expect(tokens[1]!.value).toBe("echo");
    expect(tokens[2]!.value).toBe("custom");
    expect(tokens[3]!.value).toBe("export");
    expect(tokens[4]!.type).toBe(TokenType.Word);
    expect(tokens[4]!.value).toBe("x=1");
  });

  test("function keyword definition also shadows declaration builtins", () => {
    const src = "function local { echo custom; }; local a=10";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Operator && t.type !== TokenType.Keyword);
    expect(tokens[0]!.value).toBe("local");
    expect(tokens[1]!.value).toBe("echo");
    expect(tokens[2]!.value).toBe("custom");
    expect(tokens[3]!.value).toBe("local");
    expect(tokens[4]!.type).toBe(TokenType.Word);
    expect(tokens[4]!.value).toBe("a=10");
  });

  test("declaration builtin before its function definition is NOT shadowed", () => {
    const src = "export x=1\nexport() { :; }\nexport y=2";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Newline && t.type !== TokenType.Operator && t.type !== TokenType.Keyword);
    expect(tokens[0]!.value).toBe("export");
    expect(tokens[1]!.type).toBe(TokenType.Assignment);
    expect(tokens[1]!.value).toBe("x=1");
    expect(tokens[2]!.value).toBe("export");
    expect(tokens[3]!.value).toBe(":");
    expect(tokens[4]!.value).toBe("export");
    expect(tokens[5]!.type).toBe(TokenType.Word);
    expect(tokens[5]!.value).toBe("y=2");
  });
});

describe("line continuations and joins tracking", () => {
  test("line continuation within bare word tracks join offset", () => {
    const src = "ec\\\nho hello";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("echo");
    expect(tokens[0]!.joins).toEqual([2]);
    expect(tokens[0]!.range).toEqual({ start: 0, end: 6 });
    expect(tokens[1]!.value).toBe("hello");
  });

  test("multiple line continuations in one word", () => {
    const src = "a\\\nb\\\nc\\\nd";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Word);
    expect(tokens[0]!.value).toBe("abcd");
    expect(tokens[0]!.joins).toEqual([1, 2, 3]);
    expect(tokens[0]!.range).toEqual({ start: 0, end: 10 });
  });

  test("line continuation in assignment", () => {
    const src = "FOO=bar\\\nbaz";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Assignment);
    expect(tokens[0]!.value).toBe("FOO=barbaz");
    expect(tokens[0]!.joins).toEqual([7]);
  });

  test("line continuation in whitespace is cleanly skipped", () => {
    const src = "echo \\\n hello";
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(2);
    expect(tokens[0]!.value).toBe("echo");
    expect(tokens[1]!.value).toBe("hello");
  });
});

describe("arithmetic command and C-style for disambiguation", () => {
  test("standalone arithmetic command (( ... ))", () => {
    const tokens = tokenize("(( 1 + 2 ))").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.type).toBe(TokenType.Arithmetic);
    expect(tokens[0]!.value).toBe(" 1 + 2 ");
  });

  test("arithmetic comparison (( x > 5 ))", () => {
    const tokens = tokenize("(( x > 5 ))").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.type).toBe(TokenType.Arithmetic);
    expect(tokens[0]!.value).toBe(" x > 5 ");
  });

  test("arithmetic command with output redirection", () => {
    const tokens = tokenize("(( a = 1 )) > out.log").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Arithmetic);
    expect(tokens[0]!.value).toBe(" a = 1 ");
    expect(tokens[1]!.type).toBe(TokenType.Redirect);
    expect(tokens[1]!.value).toBe(">");
    expect(tokens[2]!.type).toBe(TokenType.Word);
    expect(tokens[2]!.value).toBe("out.log");
  });

  test("nested subshells ((cd /tmp) && ls) is not an arithmetic command", () => {
    const tokens = tokenize("((cd /tmp) && ls)").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Operator);
    expect(tokens[0]!.value).toBe("(");
    expect(tokens[1]!.type).toBe(TokenType.Operator);
    expect(tokens[1]!.value).toBe("(");
    expect(tokens[2]!.type).toBe(TokenType.Word);
    expect(tokens[2]!.value).toBe("cd");
    expect(tokens.some(t => t.type === TokenType.Arithmetic)).toBe(false);
  });

  test("C-style for loop ((;;)) and clauses", () => {
    const tokens = tokenize("for (( i=0; i<10; i++ )); do echo $i; done").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("for");
    expect(tokens[1]!.type).toBe(TokenType.Arithmetic);
    expect(tokens[1]!.value).toBe(" i=0; i<10; i++ ");

    const emptyFor = tokenize("for ((;;)); do :; done").filter(t => t.type !== TokenType.EOF);
    expect(emptyFor[1]!.type).toBe(TokenType.Arithmetic);
    expect(emptyFor[1]!.value).toBe(";;");
  });
});

describe("[[ ... ]] test command tokenization and regex matching", () => {
  test("a terminal regex escape keeps token ranges inside the source", () => {
    const source = "[[ value =~ trailing\\";
    const tokens = tokenize(source);
    const regex = tokens.find(token => token.value === "trailing\\");
    const eof = tokens.at(-1)!;

    expect(regex?.range.end).toBe(source.length);
    expect(eof.range).toEqual({ start: source.length, end: source.length });
  });

  test("regex operand =~ consumes pattern whole including parens and spaces", () => {
    const tokens = tokenize('[[ $str =~ (foo bar|baz qux)+ ]]').filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("[[");
    expect(tokens[1]!.value).toBe("$str");
    expect(tokens[2]!.value).toBe("=~");
    expect(tokens[3]!.type).toBe(TokenType.Word);
    expect(tokens[3]!.value).toBe("(foo bar|baz qux)+");
    expect(tokens[4]!.type).toBe(TokenType.Keyword);
    expect(tokens[4]!.value).toBe("]]");
  });

  test("regex operand with POSIX character class [[:digit:]]", () => {
    const tokens = tokenize('[[ $str =~ ^[[:digit:]]+$ ]]').filter(t => t.type !== TokenType.EOF);
    expect(tokens[2]!.value).toBe("=~");
    expect(tokens[3]!.value).toBe("^[[:digit:]]+$");
    expect(tokens[4]!.value).toBe("]]");
  });

  test("< and > inside [[ ]] are string comparison Operators, not Redirects", () => {
    const tokens = tokenize('[[ "alpha" < "beta" && "gamma" > "beta" ]]').filter(t => t.type !== TokenType.EOF);
    const ops = tokens.filter(t => t.type === TokenType.Operator);
    expect(ops.map(t => t.value)).toEqual(["<", "&&", ">"]);
    expect(tokens.some(t => t.type === TokenType.Redirect)).toBe(false);
  });

  test("newlines inside [[ ]] are treated as whitespace", () => {
    const tokens = tokenize('[[ $a == 1 \n && $b == 2 ]]\n').filter(t => t.type !== TokenType.EOF);
    expect(tokens.filter(t => t.type === TokenType.Newline).length).toBe(1);
    expect(tokens[0]!.value).toBe("[[");
    expect(tokens[tokens.length - 2]!.value).toBe("]]");
  });

  test("process substitution inside [[ ]] is tokenized as a Word", () => {
    const tokens = tokenize('[[ <(echo a) == <(echo b) ]]').filter(t => t.type !== TokenType.EOF);
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("<(echo a)");
    expect(tokens[3]!.type).toBe(TokenType.Word);
    expect(tokens[3]!.value).toBe("<(echo b)");
  });
});

describe("array subscript assignments", () => {
  test("subscript indices and keys in assignments", () => {
    const src = 'ARR[0]=first MAP["key"]=second VAR[$idx]+=append ARR[1+2]=eval';
    const tokens = tokenize(src).filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(4);
    expect(tokens.every(t => t.type === TokenType.Assignment)).toBe(true);
    expect(tokens[0]!.value).toBe("ARR[0]=first");
    expect(tokens[1]!.value).toBe('MAP["key"]=second');
    expect(tokens[2]!.value).toBe("VAR[$idx]+=append");
    expect(tokens[3]!.value).toBe("ARR[1+2]=eval");
  });
});

describe("extended globbing patterns", () => {
  test("extglobs ?(), *(), +(), @() in argument positions", () => {
    const tokens = tokenize("ls ?(a|b) *(c|d) +(e|f) @(g|h)").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(5);
    expect(tokens[0]!.value).toBe("ls");
    expect(tokens[1]!.value).toBe("?(a|b)");
    expect(tokens[2]!.value).toBe("*(c|d)");
    expect(tokens[3]!.value).toBe("+(e|f)");
    expect(tokens[4]!.value).toBe("@(g|h)");
    expect(tokens.every(t => t.type === TokenType.Word)).toBe(true);
  });

  test("negated extglob !(pattern) in argument position", () => {
    const tokens = tokenize("rm !(keep.txt)").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(2);
    expect(tokens[0]!.value).toBe("rm");
    expect(tokens[1]!.type).toBe(TokenType.Word);
    expect(tokens[1]!.value).toBe("!(keep.txt)");
  });

  test("pipeline negation ! at command start followed by subshell", () => {
    const tokens = tokenize("! (echo fail)").filter(t => t.type !== TokenType.EOF);
    expect(tokens[0]!.type).toBe(TokenType.Keyword);
    expect(tokens[0]!.value).toBe("!");
    expect(tokens[1]!.type).toBe(TokenType.Operator);
    expect(tokens[1]!.value).toBe("(");
  });
});

describe("boundary inputs and sad path tokenization", () => {
  test("empty string produces only EOF", () => {
    const tokens = tokenize("");
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.type).toBe(TokenType.EOF);
    expect(tokens[0]!.range).toEqual({ start: 0, end: 0 });
  });

  test("whitespace-only string produces only EOF", () => {
    const tokens = tokenize("   \t\t   ");
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.type).toBe(TokenType.EOF);
    expect(tokens[0]!.range).toEqual({ start: 8, end: 8 });
  });

  test("trailing backslash at EOF", () => {
    const tokens = tokenize("echo \\").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(2);
    expect(tokens[0]!.value).toBe("echo");
    expect(tokens[1]!.value).toBe("\\");
  });

  test.each([
    ["quoted regex operand", '[[ x =~ "a\\'],
    ["command substitution", 'echo $(printf \\'],
  ] as const)("a terminal escape in a %s keeps token ranges inside the source", (_kind, source) => {
    const tokens = tokenize(source);

    expect(tokens.every(token =>
      token.range.start >= 0 &&
      token.range.start <= token.range.end &&
      token.range.end <= source.length
    )).toBe(true);
    expect(tokens.at(-1)).toMatchObject({
      type: TokenType.EOF,
      range: { start: source.length, end: source.length },
    });
  });

  test("unterminated quotes and backticks flag unterminated: true", () => {
    expect(tokenize("'unterminated")[0]!.unterminated).toBe(true);
    expect(tokenize('"unterminated')[0]!.unterminated).toBe(true);
    expect(tokenize("`unterminated")[0]!.unterminated).toBe(true);
    expect(tokenize("$'unterminated")[0]!.unterminated).toBe(true);
    expect(tokenize('FOO="unterminated')[0]!.unterminated).toBe(true);
  });

  test("multiple heredocs on the same line", () => {
    const src = "cat <<EOF1 <<EOF2\nfirst body\nEOF1\nsecond body\nEOF2\n";
    const tokens = tokenize(src);
    const bodies = tokens.filter(t => t.type === TokenType.HereDocBody);
    expect(bodies.length).toBe(2);
    expect(bodies[0]!.value).toBe("first body\n");
    expect(bodies[1]!.value).toBe("second body\n");
  });

  test("strip-tabs heredoc <<- strips leading tabs from delimiter match", () => {
    const src = "cat <<-EOF\n\tline 1\n\t\tline 2\n\tEOF\n";
    const tokens = tokenize(src);
    const body = tokens.find(t => t.type === TokenType.HereDocBody);
    expect(body).toBeDefined();
    expect(body!.value).toBe("\tline 1\n\t\tline 2\n");
  });

  test("special and positional parameters", () => {
    const tokens = tokenize("echo $0 $1 $9 $? $$ $! $# $* $@ $-").filter(t => t.type !== TokenType.EOF);
    expect(tokens.length).toBe(11);
    expect(tokens.every(t => t.type === TokenType.Word)).toBe(true);
    expect(tokens.map(t => t.value)).toEqual([
      "echo", "$0", "$1", "$9", "$?", "$$", "$!", "$#", "$*", "$@", "$-"
    ]);
  });
});
