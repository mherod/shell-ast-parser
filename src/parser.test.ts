import { test, expect, describe } from "bun:test";
import { parseShell, parse, ParseError, tokenize, TokenType } from "../index.ts";

function parseCmd(src: string) {
  const script = parseShell(src);
  return script.commands;
}

describe("parser", () => {
  test("simple command", () => {
    const cmds = parseCmd("echo hello");
    expect(cmds.length).toBe(1);
    const pipeline = cmds[0]!;
    expect(pipeline.type).toBe("Pipeline");
    if (pipeline.type === "Pipeline") {
      expect(pipeline.commands[0]!.type).toBe("SimpleCommand");
      const cmd = pipeline.commands[0] as any;
      expect(cmd.name.parts[0].value).toBe("echo");
      expect(cmd.args.length).toBe(1);
    }
  });

  test("assignment only", () => {
    const cmds = parseCmd('NAME="world"');
    expect(cmds.length).toBe(1);
    const pipeline = cmds[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.type).toBe("SimpleCommand");
    expect(cmd.assignments.length).toBe(1);
    expect(cmd.assignments[0].name).toBe("NAME");
  });

  test("pipeline", () => {
    const cmds = parseCmd("cat file | grep pattern | head -5");
    expect(cmds.length).toBe(1);
    const pipeline = cmds[0]! as any;
    expect(pipeline.type).toBe("Pipeline");
    expect(pipeline.commands.length).toBe(3);
  });

  test("and-or list", () => {
    const cmds = parseCmd("mkdir /tmp/test && echo success");
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.type).toBe("List");
    const list = cmds[0]! as any;
    expect(list.op).toBe("&&");
  });

  test("redirections", () => {
    const cmds = parseCmd("echo hello > out.txt");
    const pipeline = cmds[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.redirects.length).toBe(1);
    expect(cmd.redirects[0].op).toBe(">");
  });

  test("if/elif/else/fi", () => {
    const script = parseShell(`
if [ -f /tmp/x ]; then
    echo exists
elif [ -d /tmp ]; then
    echo dir
else
    echo nope
fi
`);
    const pipeline = script.commands[0]! as any;
    const ifCmd = pipeline.commands[0];
    expect(ifCmd.type).toBe("IfClause");
    expect(ifCmd.elifs.length).toBe(1);
    expect(ifCmd.else).not.toBeNull();
  });

  test("for loop", () => {
    const script = parseShell("for i in 1 2 3; do echo $i; done");
    const pipeline = script.commands[0]! as any;
    const forCmd = pipeline.commands[0];
    expect(forCmd.type).toBe("ForClause");
    expect(forCmd.variable).toBe("i");
    expect(forCmd.words!.length).toBe(3);
  });

  test("while loop", () => {
    const script = parseShell("while true; do echo loop; done");
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.type).toBe("WhileClause");
  });

  test("until loop", () => {
    const script = parseShell('until [ "$x" -eq 0 ]; do x=$((x-1)); done');
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.type).toBe("UntilClause");
  });

  test("case statement", () => {
    const script = parseShell(`case "$x" in
  hello) echo hi;;
  world|earth) echo planet;;
  *) echo default;;
esac`);
    const pipeline = script.commands[0]! as any;
    const caseCmd = pipeline.commands[0];
    expect(caseCmd.type).toBe("CaseClause");
    expect(caseCmd.items.length).toBe(3);
    expect(caseCmd.items[1].patterns.length).toBe(2);
  });

  test("function def with parens", () => {
    const script = parseShell("greet() { echo hi; }");
    const pipeline = script.commands[0]! as any;
    const fn = pipeline.commands[0];
    expect(fn.type).toBe("FunctionDef");
    expect(fn.name).toBe("greet");
  });

  test("function keyword", () => {
    const script = parseShell("function cleanup { echo done; }");
    const pipeline = script.commands[0]! as any;
    const fn = pipeline.commands[0];
    expect(fn.type).toBe("FunctionDef");
    expect(fn.name).toBe("cleanup");
  });

  test("subshell", () => {
    const script = parseShell("(cd /tmp && ls)");
    const pipeline = script.commands[0]! as any;
    const sub = pipeline.commands[0];
    expect(sub.type).toBe("Subshell");
  });

  test("brace group", () => {
    const script = parseShell("{ echo grouped; echo commands; }");
    const pipeline = script.commands[0]! as any;
    const bg = pipeline.commands[0];
    expect(bg.type).toBe("BraceGroup");
  });

  test("comments are collected", () => {
    const script = parseShell("# comment\necho hello");
    expect(script.comments.length).toBeGreaterThan(0);
  });

  test("negated pipeline", () => {
    const script = parseShell("! grep -q pattern file");
    const pipeline = script.commands[0]! as any;
    expect(pipeline.type).toBe("Pipeline");
    expect(pipeline.negated).toBe(true);
  });

  test("heredoc", () => {
    const script = parseShell("cat <<EOF\nhello world\nEOF\n");
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.redirects.length).toBe(1);
    expect(cmd.redirects[0].op).toBe("<<");
  });

  test("double brackets parsed as a test command", () => {
    const script = parseShell('[[ "$x" == y ]]');
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.type).toBe("TestCommand");
    expect(cmd.expression.type).toBe("TestBinary");
    expect(cmd.expression.op).toBe("==");
  });

  test("variable expansion in compound word", () => {
    const script = parseShell('echo "Hello, $NAME!"');
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    const arg = cmd.args[0];
    expect(arg.parts.some((p: any) => p.type === "VariableExpansion")).toBe(true);
  });

  test("braced variable expansion", () => {
    const script = parseShell('echo "${NAME:-default}"');
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    const arg = cmd.args[0];
    expect(arg.parts.some((p: any) =>
      p.type === "VariableExpansion" && p.braced === true && p.expression === "NAME:-default"
    )).toBe(true);
  });
});

describe("heredoc bodies", () => {
  test("body is attached to the heredoc target", () => {
    const script = parseShell("cat <<EOF\nhello world\nEOF\n");
    const cmd = (script.commands[0]! as any).commands[0];
    expect(cmd.redirects[0].target.content).toBe("hello world\n");
  });

  test("each of two heredocs gets its own body", () => {
    const script = parseShell("cat <<A <<B\nfirst\nA\nsecond\nB\n");
    const cmd = (script.commands[0]! as any).commands[0];
    expect(cmd.redirects.map((r: any) => r.target.content)).toEqual(["first\n", "second\n"]);
  });

  test("quoted delimiter is recorded and stripped", () => {
    const script = parseShell("cat <<'EOF'\nraw $X\nEOF\n");
    const target = (script.commands[0]! as any).commands[0].redirects[0].target;
    expect(target.quoted).toBe(true);
    expect(target.delimiter).toBe("EOF");
  });

  test("unquoted delimiter is not marked quoted", () => {
    const script = parseShell("cat <<EOF\nx\nEOF\n");
    const target = (script.commands[0]! as any).commands[0].redirects[0].target;
    expect(target.quoted).toBe(false);
  });

  test("<<- records stripTabs", () => {
    const script = parseShell("cat <<-EOF\n\tindented\nEOF\n");
    const target = (script.commands[0]! as any).commands[0].redirects[0].target;
    expect(target.stripTabs).toBe(true);
  });
});

describe("brace bodies after a name", () => {
  test("function keyword with brace body", () => {
    const script = parseShell("function cleanup { rm -f /tmp/x; }");
    const fn = (script.commands[0]! as any).commands[0];
    expect(fn.type).toBe("FunctionDef");
    expect(fn.name).toBe("cleanup");
    expect(fn.body.type).toBe("BraceGroup");
  });

  test("named coproc with brace body", () => {
    const script = parseShell("coproc WORKER { read -r line; }");
    const co = (script.commands[0]! as any).commands[0];
    expect(co.type).toBe("Coproc");
    expect(co.name).toBe("WORKER");
    expect(co.body.type).toBe("BraceGroup");
  });
});

describe("double brackets", () => {
  test("captures trailing redirects", () => {
    const script = parseShell("[[ -f x ]] > out.txt");
    const cmd = (script.commands[0]! as any).commands[0];
    expect(cmd.redirects.length).toBe(1);
    expect(cmd.redirects[0].op).toBe(">");
  });
});

describe("termination", () => {
  // Each of these used to spin forever in parseCompoundList
  const inputs = [
    "function cleanup { rm -f /tmp/x; }",
    "cat <<EOF\nhello\nEOF\n",
    "coproc WORKER { read -r line; }",
    "echo }",
    "cmd |",
    "&& x",
    "}",
    ";;",
  ];

  for (const src of inputs) {
    test(`terminates on ${JSON.stringify(src)}`, () => {
      // Either parses or throws — the only failure mode is not returning
      try {
        parseShell(src);
      } catch (e) {
        expect(e).toBeInstanceOf(ParseError);
      }
    });
  }

  test("a body with no heredoc to claim it is dropped, not spun on", () => {
    const tokens = tokenize("echo hi");
    tokens.splice(0, 0, { type: TokenType.HereDocBody, value: "orphan\n", range: { start: 0, end: 0 } });
    const script = parse(tokens);
    expect(script.commands.length).toBe(1);
  });

  test("a token no rule can consume raises ParseError rather than looping", () => {
    // Leading `&` reaches parseCommand, which consumes nothing — the guard fires
    expect(() => parseShell("& echo hi")).toThrow(ParseError);
  });
});

describe("array assignments", () => {
  const assignment = (src: string) => (parseShell(src).commands[0] as any).commands[0].assignments[0];

  test("elements become an ArrayLiteral", () => {
    const value = assignment("ITEMS=(one two three)").value;
    expect(value.type).toBe("ArrayLiteral");
    expect(value.elements.map((e: any) => e.parts[0].value)).toEqual(["one", "two", "three"]);
  });

  test("empty array", () => {
    expect(assignment("EMPTY=()").value.elements).toEqual([]);
  });

  test("elements may span lines", () => {
    expect(assignment("A=(\n  x\n  y\n)").value.elements.length).toBe(2);
  });

  test("elements may contain expansions", () => {
    const value = assignment("A=( $(echo x) )").value;
    expect(value.elements.length).toBe(1);
    expect(value.elements[0].parts[0].type).toBe("CommandSubstitution");
  });

  test("a detached paren is still a subshell, not an array", () => {
    const script = parseShell("X= (echo hi)");
    expect((script.commands[0] as any).commands[0].assignments[0].value).toBeNull();
    expect((script.commands[1] as any).commands[0].type).toBe("Subshell");
  });

  test("unterminated array raises ParseError", () => {
    expect(() => parseShell("A=(1 2")).toThrow(ParseError);
  });
});

describe("background commands", () => {
  const first = (src: string) => parseShell(src).commands[0] as any;

  test("& marks a pipeline as background", () => {
    expect(first("sleep 10 &").background).toBe(true);
  });

  test("& marks a list as background", () => {
    const list = first("a && b &");
    expect(list.type).toBe("List");
    expect(list.background).toBe(true);
  });

  test("a plain command is not background", () => {
    expect(first("sleep 10").background).toBe(false);
  });

  test("; does not mark background", () => {
    expect(first("a; b &").background).toBe(false);
  });

  test("& separates two commands", () => {
    const script = parseShell("a & b");
    expect(script.commands.length).toBe(2);
    expect((script.commands[0] as any).background).toBe(true);
    expect((script.commands[1] as any).background).toBe(false);
  });

  test("background inside a loop body", () => {
    const loop = (parseShell("for i in 1 2; do sleep $i & done").commands[0] as any).commands[0];
    expect(loop.body.commands[0].background).toBe(true);
  });
});

describe("command substitution bodies", () => {
  const parts = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts;

  test("$(...) body is parsed into a Script", () => {
    const sub = parts("echo $(date +%s)")[0];
    expect(sub.type).toBe("CommandSubstitution");
    expect(sub.backtick).toBe(false);
    const inner = sub.body.commands[0].commands[0];
    expect(inner.name.parts[0].value).toBe("date");
    expect(inner.args[0].parts[0].value).toBe("+%s");
  });

  test("backtick body is parsed into a Script", () => {
    const sub = parts("echo `ls -1 | wc -l`")[0];
    expect(sub.backtick).toBe(true);
    expect(sub.body.commands[0].commands.length).toBe(2);
  });

  test("inner ranges index the outer source", () => {
    const src = "echo $(date +%s)";
    const inner = parts(src)[0].body.commands[0].commands[0];
    expect(src.slice(inner.range.start, inner.range.end)).toBe("date +%s");
  });

  test("substitutions nest", () => {
    const outer = parts("echo $(echo $(echo deep))")[0];
    const middle = outer.body.commands[0].commands[0].args[0].parts[0];
    const inner = middle.body.commands[0].commands[0];
    expect(inner.args[0].parts[0].value).toBe("deep");
  });

  test("an empty substitution yields an empty Script", () => {
    expect(parts("echo $()")[0].body.commands).toEqual([]);
  });

  test("a compound command inside a substitution is parsed", () => {
    const sub = parts("echo $(if true; then echo y; fi)")[0];
    expect(sub.body.commands[0].commands[0].type).toBe("IfClause");
  });
});

describe("process substitution", () => {
  const args = (src: string) => (parseShell(src).commands[0] as any).commands[0].args;

  test("<(cmd) becomes a ProcessSubstitution", () => {
    const part = args("diff <(ls /tmp)")[0].parts[0];
    expect(part.type).toBe("ProcessSubstitution");
    expect(part.direction).toBe("<");
    expect(part.body.commands[0].commands[0].name.parts[0].value).toBe("ls");
  });

  test(">(cmd) records the other direction", () => {
    expect(args("tee >(cat)")[0].parts[0].direction).toBe(">");
  });

  test("inner ranges index the outer source", () => {
    const src = "diff <(ls /tmp)";
    const inner = args(src)[0].parts[0].body.commands[0].commands[0];
    expect(src.slice(inner.range.start, inner.range.end)).toBe("ls /tmp");
  });

  test("both operands of a diff are parsed", () => {
    const parsed = args("diff <(ls /tmp) <(ls /var)");
    expect(parsed.map((a: any) => a.parts[0].type)).toEqual(["ProcessSubstitution", "ProcessSubstitution"]);
  });

  test("adjacent literals are kept", () => {
    const parts = args("cat pre<(ls)post")[0].parts;
    expect(parts.map((p: any) => p.type)).toEqual(["Word", "ProcessSubstitution", "Word"]);
  });

  test("nests inside a command substitution", () => {
    const outer = args("echo $(diff <(a) <(b))")[0].parts[0];
    const inner = outer.body.commands[0].commands[0];
    expect(inner.args[0].parts[0].type).toBe("ProcessSubstitution");
  });
});

describe("append assignments", () => {
  const assignment = (src: string) => (parseShell(src).commands[0] as any).commands[0].assignments[0];

  test("+= sets append and strips the + from the name", () => {
    const a = assignment("PATH+=:/opt/bin");
    expect(a.name).toBe("PATH");
    expect(a.append).toBe(true);
    expect(a.value.parts[0].value).toBe(":/opt/bin");
  });

  test("+= works with an array literal", () => {
    const a = assignment("ITEMS+=(four five)");
    expect(a.append).toBe(true);
    expect(a.value.type).toBe("ArrayLiteral");
    expect(a.value.elements.length).toBe(2);
  });

  test("a plain assignment is not an append", () => {
    expect(assignment("NAME=world").append).toBe(false);
  });

  test("bare += has a null value", () => {
    const a = assignment("EMPTY+=");
    expect(a.append).toBe(true);
    expect(a.value).toBeNull();
  });

  test("a + elsewhere in the name is not an assignment", () => {
    expect(tokenize("a+b=c")[0]!.type).toBe(TokenType.Word);
  });

  test("+= with no name is not an assignment", () => {
    expect(tokenize("+=x")[0]!.type).toBe(TokenType.Word);
  });
});

describe("quoting", () => {
  const parts = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts;
  const one = (src: string) => {
    const p = parts(src);
    expect(p.length).toBe(1);
    return p[0];
  };

  describe("single quotes suppress every expansion", () => {
    test("command substitution is inert text", () => {
      const part = one("echo '$(rm -rf /)'");
      expect(part.type).toBe("Word");
      expect(part.value).toBe("$(rm -rf /)");
      expect(part.quoted).toBe("single");
    });

    test("variable expansion is inert text", () => {
      expect(one("echo '$NAME'").value).toBe("$NAME");
    });

    test("backticks are inert text", () => {
      expect(one("echo '`date`'").value).toBe("`date`");
    });

    test("a backslash is an ordinary character", () => {
      expect(one("echo '\\n'").value).toBe("\\n");
    });
  });

  describe("double quotes expand some things", () => {
    test("variable expansion still applies", () => {
      const part = one('echo "$NAME"');
      expect(part.type).toBe("VariableExpansion");
      expect(part.quoted).toBe("double");
    });

    test("command substitution still applies", () => {
      expect(one('echo "$(date)"').type).toBe("CommandSubstitution");
    });

    test("process substitution does not", () => {
      const part = one('echo "a<(b)c"');
      expect(part.type).toBe("Word");
      expect(part.value).toBe("a<(b)c");
    });
  });

  test("quote characters are stripped from the value", () => {
    expect(one("echo 'hello'").value).toBe("hello");
    expect(one('echo "hello"').value).toBe("hello");
  });

  test("each quoted segment of a word is reported separately", () => {
    expect(parts("echo a\"b\"'c'd").map((p: any) => [p.value, p.quoted])).toEqual([
      ["a", null],
      ["b", "double"],
      ["c", "single"],
      ["d", null],
    ]);
  });

  test("empty quotes are an empty word, not nothing", () => {
    expect(one("echo ''").value).toBe("");
    expect(one("echo ''").quoted).toBe("single");
  });

  test("a quoted expansion does not also emit an empty word", () => {
    expect(parts('echo "$NAME"').length).toBe(1);
  });

  describe("escapes", () => {
    test("unquoted backslash makes the next character literal", () => {
      expect(one("echo \\$NOT").value).toBe("$NOT");
    });

    test("double quotes escape the five special characters", () => {
      expect(one('echo "\\$NOT"').value).toBe("$NOT");
      expect(one('echo "a\\"b"').value).toBe('a"b');
    });

    test("other backslashes survive inside double quotes", () => {
      expect(one('echo "a\\nb"').value).toBe("a\\nb");
    });
  });

  describe("$'…' resolves escapes", () => {
    test("named escapes", () => {
      expect(one("echo $'a\\tb\\nc'").value).toBe("a\tb\nc");
    });

    test("hex, octal and unicode", () => {
      expect(one("echo $'\\x41\\102\\u00e9'").value).toBe("ABé");
    });

    test("an unknown escape keeps its backslash", () => {
      expect(one("echo $'\\q'").value).toBe("\\q");
    });

    test("reported as single-quoted — it expands nothing", () => {
      expect(one("echo $'x'").quoted).toBe("single");
    });
  });

  test("$\"…\" behaves like double quotes", () => {
    expect(one('echo $"$NAME"').type).toBe("VariableExpansion");
  });

  describe("ranges", () => {
    test("each part indexes the source it came from", () => {
      const src = 'echo pre$NAME"post $X"';
      expect(parts(src).map((p: any) => src.slice(p.range.start, p.range.end)))
        .toEqual(["pre", "$NAME", "post ", "$X"]);
    });

    test("an assignment value is offset past the =", () => {
      const src = "TODAY=$(date +%F)";
      const sub = (parseShell(src).commands[0] as any).commands[0].assignments[0].value.parts[0];
      expect(src.slice(sub.range.start, sub.range.end)).toBe("$(date +%F)");
      const inner = sub.body.commands[0].commands[0];
      expect(src.slice(inner.range.start, inner.range.end)).toBe("date +%F");
    });
  });

  test("unterminated quotes do not hang", () => {
    for (const src of ["echo 'x", 'echo "x', "echo $'x"]) {
      expect(() => parseShell(src)).not.toThrow();
    }
  });
});

describe("delimiters inside quotes", () => {
  const words = (src: string) => tokenize(src).filter(t => t.type !== TokenType.EOF).map(t => t.value);
  const parts = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts;

  test("a quoted ) does not end a command substitution", () => {
    expect(words('echo $(grep ")" f)')).toEqual(["echo", '$(grep ")" f)']);
    const inner = parts('echo $(grep ")" f)')[0].body.commands[0].commands[0];
    expect(inner.args.map((a: any) => a.parts[0].value)).toEqual([")", "f"]);
  });

  test("a single-quoted ) does not end a command substitution", () => {
    expect(words("echo $(grep ')' f)")).toEqual(["echo", "$(grep ')' f)"]);
  });

  test("a quoted } does not end a parameter expansion", () => {
    expect(parts('echo ${x:-"}"}')[0].expression).toBe('x:-"}"');
  });

  test("a substitution inside double quotes keeps its own quotes", () => {
    expect(words('echo "$(grep ")" f)"')).toEqual(["echo", '"$(grep ")" f)"']);
    expect(parts('echo "$(grep ")" f)"')[0].type).toBe("CommandSubstitution");
  });

  test("a backtick substitution inside double quotes", () => {
    expect(words('echo "`grep ")" f`"')).toEqual(["echo", '"`grep ")" f`"']);
  });

  test("an escaped ) does not end a command substitution", () => {
    expect(words("echo $(echo \\) done)")).toEqual(["echo", "$(echo \\) done)"]);
  });

  test("a quoted ) does not end a process substitution", () => {
    expect(words('diff <(grep ")" a) b')).toEqual(["diff", '<(grep ")" a)', "b"]);
  });

  test("arithmetic keeps nested parens and consumes both closers", () => {
    expect(words("echo $((a+(b*c)))")).toEqual(["echo", "$((a+(b*c)))"]);
    const part = parts("echo $((a+(b*c)))")[0];
    expect(part.type).toBe("ArithmeticExpansion");
    expect(part.expression).toBe("a+(b*c)");
  });

  test("a substitution nested in arithmetic", () => {
    expect(parts("echo $(($(echo 1)+2))")[0].expression).toBe("$(echo 1)+2");
  });

  test("unterminated regions do not hang", () => {
    for (const src of ["echo $(", "echo ${", "echo $((", 'echo "$(', "echo $(a\\"]) {
      expect(() => parseShell(src)).not.toThrow();
    }
  });
});

describe("comments", () => {
  const words = (src: string) => tokenize(src).filter(t => t.type !== TokenType.EOF).map(t => t.value);

  test("# mid-word is an ordinary character", () => {
    expect(words("echo a#b")).toEqual(["echo", "a#b"]);
  });

  test("# at word start still opens a comment", () => {
    expect(tokenize("echo a #b").filter(t => t.type === TokenType.Comment).map(t => t.value)).toEqual(["#b"]);
  });

  test("a fragment URL survives as one assignment", () => {
    const toks = tokenize("url=http://x#frag").filter(t => t.type !== TokenType.EOF);
    expect(toks[0]!.type).toBe(TokenType.Assignment);
    expect(toks[0]!.value).toBe("url=http://x#frag");
  });

  test("a comment inside $( ) does not end the substitution", () => {
    expect(words("echo $(echo hi # )")).toEqual(["echo", "$(echo hi # )"]);
  });

  test("a comment inside <( ) does not end it either", () => {
    expect(words("diff <(ls # )")).toEqual(["diff", "<(ls # )"]);
  });

  test("# stays an operator inside ${ }", () => {
    const part = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts[0];
    expect(part("echo ${#NAME}").expression).toBe("#NAME");
    expect(part("echo ${NAME#pre}").expression).toBe("NAME#pre");
    expect(part("echo ${NAME##pre}").expression).toBe("NAME##pre");
  });

  test("a quoted # inside a substitution is not a comment", () => {
    expect(words("echo $(echo '#')")).toEqual(["echo", "$(echo '#')"]);
  });
});

describe("subscripted assignment", () => {
  const assignment = (src: string) => (parseShell(src).commands[0] as any).commands[0].assignments[0];

  test("subscript is captured and the name is bare", () => {
    const a = assignment("ITEMS[0]=x");
    expect(a.name).toBe("ITEMS");
    expect(a.subscript.parts[0].value).toBe("0");
  });

  test("a subscript may expand", () => {
    const src = "ITEMS[$i]=x";
    const a = assignment(src);
    expect(a.subscript.parts[0].type).toBe("VariableExpansion");
    expect(src.slice(a.subscript.range.start, a.subscript.range.end)).toBe("$i");
  });

  test("subscript combines with +=", () => {
    const a = assignment("ITEMS[0]+=x");
    expect(a.append).toBe(true);
    expect(a.subscript.parts[0].value).toBe("0");
  });

  test("an unsubscripted assignment has none", () => {
    expect(assignment("PLAIN=x").subscript).toBeNull();
  });

  test("a name that is not an identifier stays a word", () => {
    expect(tokenize("[0]=x")[0]!.type).toBe(TokenType.Word);
    expect(tokenize("file[0].txt=x")[0]!.type).toBe(TokenType.Word);
  });
});

describe("declaration builtins", () => {
  const cmd = (src: string) => (parseShell(src).commands[0] as any).commands[0];

  test("declare -a X=(1 2) is one command, not a command plus a subshell", () => {
    const script = parseShell("declare -a X=(1 2)");
    expect(script.commands.length).toBe(1);
    const args = cmd("declare -a X=(1 2)").args;
    expect(args[1].type).toBe("Assignment");
    expect(args[1].value.type).toBe("ArrayLiteral");
    expect(args[1].value.elements.length).toBe(2);
  });

  test("two array arguments in one declaration", () => {
    const script = parseShell("declare -a X=(1 2) Y=(3)");
    expect(script.commands.length).toBe(1);
    expect(cmd("declare -a X=(1 2) Y=(3)").args.filter((a: any) => a.type === "Assignment").length).toBe(2);
  });

  for (const builtin of ["export", "local", "readonly", "typeset"]) {
    test(`${builtin} takes assignment arguments`, () => {
      const args = cmd(`${builtin} FOO=bar`).args;
      expect(args[0].type).toBe("Assignment");
      expect(args[0].name).toBe("FOO");
    });
  }

  test("an ordinary command keeps assignment-shaped args as words", () => {
    const args = cmd("cmd FOO=bar").args;
    expect(args[0].type).toBe("CompoundWord");
  });

  test("a prefix assignment is still a prefix, not an argument", () => {
    const c = cmd("FOO=bar cmd");
    expect(c.assignments.length).toBe(1);
    expect(c.args.length).toBe(0);
  });

  test("declaration context ends with the command", () => {
    const script = parseShell("declare -a X=(1); echo after");
    expect(script.commands.length).toBe(2);
    expect((script.commands[1] as any).commands[0].name.parts[0].value).toBe("echo");
  });
});

describe("glob patterns", () => {
  const parts = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts;
  const shape = (src: string) => parts(src).map((p: any) => `${p.type}:${p.value}`);

  test("* and ? are globs when unquoted", () => {
    expect(shape("echo *.sh")).toEqual(["GlobPattern:*", "Word:.sh"]);
    expect(shape("echo file?.txt")).toEqual(["Word:file", "GlobPattern:?", "Word:.txt"]);
  });

  test("a glob in the middle of a path", () => {
    expect(shape("echo /home/*/Documents")).toEqual(["Word:/home/", "GlobPattern:*", "Word:/Documents"]);
  });

  test("bracket expressions, including negation and a literal ]", () => {
    expect(shape("echo [abc]x")).toEqual(["GlobPattern:[abc]", "Word:x"]);
    expect(shape("echo [!abc]")).toEqual(["GlobPattern:[!abc]"]);
    expect(shape("echo []a]")).toEqual(["GlobPattern:[]a]"]);
  });

  test("an unclosed [ is a literal", () => {
    expect(shape("echo [abc")).toEqual(["Word:[abc"]);
  });

  test("quoting defeats globbing", () => {
    expect(shape('echo "*.ts"')).toEqual(["Word:*.ts"]);
    expect(shape("echo '*'")).toEqual(["Word:*"]);
  });

  test("escaping defeats globbing", () => {
    expect(shape("echo \\*")).toEqual(["Word:*"]);
  });

  test("[[ is not a bracket expression", () => {
    // `[[` opens a test command rather than an unclosed bracket glob, and
    // quoted it is a plain literal
    expect((parseShell("[[ -f x ]]").commands[0] as any).commands[0].type).toBe("TestCommand");
    expect(shape('echo "[["')).toEqual(["Word:[["]);
  });
});

describe("heredocs inside substitutions", () => {
  const words = (src: string) => tokenize(src).filter(t => t.type !== TokenType.EOF).map(t => t.value);
  const substitution = (src: string) =>
    (parseShell(src).commands[0] as any).commands[0].assignments[0].value.parts[0];
  const inner = (src: string) => substitution(src).body.commands[0].commands[0];

  test("a ) in the body does not close the substitution", () => {
    const src = "x=$(cat <<EOF\na ) b\nEOF\n)";
    expect(words(src)).toEqual([src]);
    expect(inner(src).redirects[0].target.content).toBe("a ) b\n");
  });

  test("an unbalanced quote in the body is inert", () => {
    const src = 'x=$(cat <<EOF\nits " odd\nEOF\n)';
    expect(words(src)).toEqual([src]);
    expect(inner(src).redirects[0].target.content).toBe('its " odd\n');
  });

  test("<<- bodies are skipped and stripTabs is recorded", () => {
    const src = "x=$(cat <<-EOF\n\tindented )\n\tEOF\n)";
    expect(words(src)).toEqual([src]);
    expect(inner(src).redirects[0].target.stripTabs).toBe(true);
  });

  test("a quoted delimiter still suppresses expansion", () => {
    const src = "x=$(cat <<'EOF'\n$(nope)\nEOF\n)";
    expect(words(src)).toEqual([src]);
    const target = inner(src).redirects[0].target;
    expect(target.quoted).toBe(true);
    expect(target.content).toBe("$(nope)\n");
  });

  test("two heredocs in one substitution keep their own bodies", () => {
    const src = "x=$(cat <<A <<B\none )\nA\ntwo )\nB\n)";
    expect(words(src)).toEqual([src]);
    expect(inner(src).redirects.map((r: any) => r.target.content)).toEqual(["one )\n", "two )\n"]);
  });

  test("the substitution body range still maps to the source", () => {
    const src = "x=$(cat <<EOF\na ) b\nEOF\n)";
    const body = substitution(src).body;
    expect(src.slice(body.range.start, body.range.end)).toBe("cat <<EOF\na ) b\nEOF\n");
  });

  test("parsing resumes after the substitution", () => {
    const script = parseShell("x=$(cat <<EOF\na ) b\nEOF\n)\necho done");
    expect(script.commands.length).toBe(2);
    expect((script.commands[1] as any).commands[0].name.parts[0].value).toBe("echo");
  });

  test("a heredoc inside a process substitution", () => {
    const src = "diff <(cat <<EOF\n)\nEOF\n) b";
    expect(words(src)).toEqual(["diff", "<(cat <<EOF\n)\nEOF\n)", "b"]);
  });

  test("<<< is a here-string, not a heredoc", () => {
    expect(words("x=$(echo <<<here)")).toEqual(["x=$(echo <<<here)"]);
  });

  test("<< is left-shift in arithmetic, not a heredoc", () => {
    const part = (src: string) =>
      (parseShell(src).commands[0] as any).commands[0].assignments[0].value.parts[0];
    expect(part("x=$((1<<2))").expression).toBe("1<<2");
    expect(part("x=${a<<b}").expression).toBe("a<<b");
  });

  test("unterminated heredocs do not hang", () => {
    for (const src of ["x=$(cat <<EOF", "x=$(cat <<EOF\nnoterm", "x=$(cat <<", "x=$(cat <<-"]) {
      expect(() => parseShell(src)).not.toThrow();
    }
  });
});

describe("extended globs", () => {
  const shape = (src: string) =>
    (parseShell(src).commands[0] as any).commands[0].args[0].parts.map((p: any) => `${p.type}:${p.value}`);

  for (const lead of ["?", "*", "+", "@", "!"]) {
    test(`${lead}( … ) is one glob, not a word plus a subshell`, () => {
      const src = `echo ${lead}(a|b)`;
      expect(parseShell(src).commands.length).toBe(1);
      expect(shape(src)).toEqual([`GlobPattern:${lead}(a|b)`]);
    });
  }

  test("adjacent literals are kept", () => {
    expect(shape("echo a?(b)c")).toEqual(["Word:a", "GlobPattern:?(b)", "Word:c"]);
    expect(shape("echo @(x|y).txt")).toEqual(["GlobPattern:@(x|y)", "Word:.txt"]);
  });

  test("groups nest", () => {
    expect(shape("echo @(a|@(b|c))")).toEqual(["GlobPattern:@(a|@(b|c))"]);
  });

  test("a group may contain other glob syntax", () => {
    expect(shape("ls !(*.o|*.a)")).toEqual(["GlobPattern:!(*.o|*.a)"]);
  });

  test("quoting and escaping defeat it", () => {
    expect(shape('echo "?(a|b)"')).toEqual(["Word:?(a|b)"]);
    expect(shape("echo '?(a)'")).toEqual(["Word:?(a)"]);
    expect(shape("echo \\?(a)")).toEqual(["Word:?"]);
  });

  test("a case pattern may be an extended glob", () => {
    const caseCmd = (parseShell("case x in @(a|b)) echo m ;; esac").commands[0] as any).commands[0];
    expect(caseCmd.items.length).toBe(1);
    expect(caseCmd.items[0].patterns[0].parts[0].value).toBe("@(a|b)");
  });

  describe("! stays the negation keyword at command start", () => {
    test("!(cmd) negates a subshell", () => {
      const pipeline = parseShell("!(cmd)").commands[0] as any;
      expect(pipeline.negated).toBe(true);
      expect(pipeline.commands[0].type).toBe("Subshell");
    });

    test("! cmd still negates", () => {
      expect((parseShell("! grep -q x f").commands[0] as any).negated).toBe(true);
    });
  });

  test("unterminated groups do not hang", () => {
    for (const src of ["echo ?(", "echo @(a", "echo !(", "echo *(("]) {
      expect(() => parseShell(src)).not.toThrow();
    }
  });
});

describe("arithmetic expressions", () => {
  const expansion = (src: string) =>
    (parseShell(`echo $((${src}))`).commands[0] as any).commands[0].args[0].parts[0];
  const tree = (src: string) => expansion(src).parsed;

  /** Fully-parenthesised rendering, so precedence and associativity are visible */
  const show = (n: any): string => {
    switch (n?.type) {
      case "ArithmeticNumber": return String(n.value);
      case "ArithmeticVariable": return n.name;
      case "ArithmeticSubstitution": return `<${n.part.type}>`;
      case "ArithmeticSubscript": return `${n.name}[${show(n.index)}]`;
      case "ArithmeticUnary": return `(${n.op}${show(n.operand)})`;
      case "ArithmeticUpdate": return n.prefix ? `(${n.op}${show(n.operand)})` : `(${show(n.operand)}${n.op})`;
      case "ArithmeticBinary": return `(${show(n.left)} ${n.op} ${show(n.right)})`;
      case "ArithmeticAssignment": return `(${show(n.target)} ${n.op} ${show(n.value)})`;
      case "ArithmeticConditional": return `(${show(n.condition)} ? ${show(n.then)} : ${show(n.else)})`;
      default: return "null";
    }
  };

  test("multiplication binds tighter than addition", () => {
    expect(show(tree("1+2*3"))).toBe("(1 + (2 * 3))");
    expect(show(tree("(1+2)*3"))).toBe("((1 + 2) * 3)");
  });

  test("** is right-associative, unlike the other binary operators", () => {
    expect(show(tree("2**3**2"))).toBe("(2 ** (3 ** 2))");
    expect(show(tree("1-2-3"))).toBe("((1 - 2) - 3)");
  });

  test("assignment is right-associative", () => {
    expect(show(tree("a=b=5"))).toBe("(a = (b = 5))");
    expect(show(tree("x+=2"))).toBe("(x += 2)");
  });

  test("comparison binds tighter than the logical operators", () => {
    expect(show(tree("1<2 && 3>2"))).toBe("((1 < 2) && (3 > 2))");
  });

  test("shift binds tighter than bitwise or", () => {
    expect(show(tree("1<<3|2"))).toBe("((1 << 3) | 2)");
  });

  test("ternaries nest to the right", () => {
    expect(show(tree("a?b?c:d:e"))).toBe("(a ? (b ? c : d) : e)");
  });

  test("unary and update operators", () => {
    expect(show(tree("-x + +y"))).toBe("((-x) + (+y))");
    expect(show(tree("!a"))).toBe("(!a)");
    expect(show(tree("~a"))).toBe("(~a)");
    expect(show(tree("i++ + ++j"))).toBe("((i++) + (++j))");
  });

  test("array subscripts are themselves expressions", () => {
    expect(show(tree("a[i+1]+2"))).toBe("(a[(i + 1)] + 2)");
  });

  test("the comma operator", () => {
    expect(show(tree("a,b,c"))).toBe("((a , b) , c)");
  });

  describe("number bases", () => {
    test("hex, octal and decimal", () => {
      expect(tree("0xff").value).toBe(255);
      expect(tree("010").value).toBe(8);
      expect(tree("42").value).toBe(42);
    });

    test("base#digits", () => {
      expect(tree("2#1010").value).toBe(10);
      expect(tree("16#ff").value).toBe(255);
    });

    test("the raw text is kept alongside the value", () => {
      expect(tree("0xff").raw).toBe("0xff");
    });
  });

  describe("embedded expansions", () => {
    test("a command substitution is a real node, not text", () => {
      const sub = tree("$(f) + 1").left;
      expect(sub.type).toBe("ArithmeticSubstitution");
      expect(sub.part.type).toBe("CommandSubstitution");
      expect(sub.part.body.commands[0].commands[0].name.parts[0].value).toBe("f");
    });

    test("a parameter expansion keeps its expression", () => {
      const sub = tree("${#a} * 2").left;
      expect(sub.part.type).toBe("VariableExpansion");
      expect(sub.part.expression).toBe("#a");
    });
  });

  test("operand ranges index the source", () => {
    const src = "echo $((a + 1))";
    const node = (parseShell(src).commands[0] as any).commands[0].args[0].parts[0].parsed;
    expect(src.slice(node.left.range.start, node.left.range.end)).toBe("a");
    expect(src.slice(node.right.range.start, node.right.range.end)).toBe("1");
  });

  describe("text that is not arithmetic", () => {
    for (const src of ["", "1+", "a b"]) {
      test(`${JSON.stringify(src)} yields null and keeps the raw text`, () => {
        const part = expansion(src);
        expect(part.parsed).toBeNull();
        expect(part.expression).toBe(src);
      });
    }
  });
});

describe("arithmetic commands", () => {
  const first = (src: string) => {
    const command = parseShell(src).commands[0] as any;
    return command.commands?.[0] ?? command;
  };

  test("(( … )) is an arithmetic command, not nested subshells", () => {
    const cmd = first("(( i++ ))");
    expect(cmd.type).toBe("ArithmeticCommand");
    expect(cmd.parsed.type).toBe("ArithmeticUpdate");
  });

  test("< inside (( … )) is a comparison, not a redirection", () => {
    const cmd = first("(( i < 10 ))");
    expect(cmd.parsed.op).toBe("<");
    expect(cmd.redirects).toEqual([]);
  });

  test("nested subshells are still subshells", () => {
    expect(first("((cd /tmp) && ls)").type).toBe("Subshell");
    expect(first("( (echo a) )").type).toBe("Subshell");
  });

  test("trailing redirects are captured", () => {
    expect(first("(( i++ )) > out").redirects.length).toBe(1);
  });
});

describe("C-style for loops", () => {
  const first = (src: string) => {
    const command = parseShell(src).commands[0] as any;
    return command.commands?.[0] ?? command;
  };

  test("all three clauses are parsed", () => {
    const loop = first("for ((i=0;i<3;i++)); do echo $i; done");
    expect(loop.type).toBe("ArithmeticForClause");
    expect(loop.init.type).toBe("ArithmeticAssignment");
    expect(loop.condition.op).toBe("<");
    expect(loop.update.op).toBe("++");
    expect(loop.body.commands.length).toBe(1);
  });

  test("for ((;;)) leaves every clause null", () => {
    const loop = first("for ((;;)); do :; done");
    expect(loop.init).toBeNull();
    expect(loop.condition).toBeNull();
    expect(loop.update).toBeNull();
  });

  test("clause ranges index the source", () => {
    const src = "for ((i=0;i<3;i++)); do :; done";
    const loop = first(src);
    expect(src.slice(loop.init.range.start, loop.init.range.end)).toBe("i=0");
    expect(src.slice(loop.condition.range.start, loop.condition.range.end)).toBe("i<3");
    expect(src.slice(loop.update.range.start, loop.update.range.end)).toBe("i++");
  });

  test("redirects are captured", () => {
    expect(first("for ((i=0;i<3;i++)); do :; done > out").redirects.length).toBe(1);
  });

  test("a classic for loop is unaffected", () => {
    const loop = first("for i in 1 2; do :; done");
    expect(loop.type).toBe("ForClause");
    expect(loop.variable).toBe("i");
  });
});

describe("let", () => {
  const first = (src: string) => {
    const command = parseShell(src).commands[0] as any;
    return command.commands?.[0] ?? command;
  };

  test("a quoted argument is arithmetic", () => {
    const cmd = first('let "i = 1"');
    expect(cmd.type).toBe("LetCommand");
    expect(cmd.expressions.length).toBe(1);
    expect(cmd.expressions[0].text).toBe("i = 1");
    expect(cmd.expressions[0].parsed.type).toBe("ArithmeticAssignment");
  });

  test("single quotes are unwrapped too", () => {
    expect(first("let 'a=2'").expressions[0].parsed.type).toBe("ArithmeticAssignment");
  });

  test("each argument is its own expression", () => {
    const cmd = first("let i=1 j++");
    expect(cmd.expressions.map((e: any) => e.parsed.type)).toEqual(["ArithmeticAssignment", "ArithmeticUpdate"]);
  });

  test("an expansion inside stays a node", () => {
    const cmd = first('let "n = $x + 1"');
    expect(cmd.expressions[0].parsed.value.left.type).toBe("ArithmeticSubstitution");
  });

  test("prefix assignments and redirects are kept", () => {
    expect(first("FOO=1 let x=2").assignments.length).toBe(1);
    expect(first("let x=1 > out").redirects.length).toBe(1);
  });

  test("bare let has no expressions", () => {
    expect(first("let").expressions).toEqual([]);
  });

  test("a non-arithmetic argument yields null and keeps its text", () => {
    const expression = first('let "a b"').expressions[0];
    expect(expression.parsed).toBeNull();
    expect(expression.text).toBe("a b");
  });

  test("ranges survive the unwrapped quotes", () => {
    const src = 'let "i = 1"';
    const expression = first(src).expressions[0];
    expect(src.slice(expression.range.start, expression.range.end)).toBe('"i = 1"');
    expect(src.slice(expression.parsed.target.range.start, expression.parsed.target.range.end)).toBe("i");
  });

  describe("only as a command name", () => {
    test("let as an argument is an ordinary word", () => {
      const cmd = first("echo let");
      expect(cmd.type).toBe("SimpleCommand");
      expect(cmd.args[0].parts[0].value).toBe("let");
    });

    test("a function named let is still a definition", () => {
      expect(first("let() { :; }").type).toBe("FunctionDef");
      expect(first("function let { :; }").type).toBe("FunctionDef");
    });
  });
});

describe("test expressions", () => {
  const command = (src: string) => (parseShell(src).commands[0] as any).commands[0];
  const text = (word: any) => word.parts.map((p: any) => p.value ?? p.expression ?? p.type).join("");

  /** Fully-parenthesised rendering, so grouping and precedence are visible */
  const show = (n: any): string => {
    switch (n?.type) {
      case "TestUnary": return `(${n.op} ${text(n.operand)})`;
      case "TestBinary": return `(${text(n.left)} ${n.op} ${text(n.right)})`;
      case "TestLogical": return `(${show(n.left)} ${n.op} ${show(n.right)})`;
      case "TestNegation": return `(! ${show(n.operand)})`;
      case "TestValue": return text(n.word);
      default: return "null";
    }
  };
  const expr = (src: string) => show(command(src).expression);

  test("[[ … ]] is a TestCommand, not a simple command", () => {
    expect(command("[[ -f x ]]").type).toBe("TestCommand");
  });

  test("unary operators take their operand", () => {
    expect(expr("[[ -f x ]]")).toBe("(-f x)");
    expect(expr("[[ -z $s ]]")).toBe("(-z s)");
  });

  test("binary operators", () => {
    expect(expr("[[ $x == y ]]")).toBe("(x == y)");
    expect(expr("[[ $n -lt 3 ]]")).toBe("(n -lt 3)");
    expect(expr("[[ $s =~ ^a.*b$ ]]")).toBe("(s =~ ^a.*b$)");
  });

  test("< and > compare strings rather than redirecting", () => {
    expect(expr("[[ a < b ]]")).toBe("(a < b)");
    expect(expr("[[ a > b ]]")).toBe("(a > b)");
    expect(command("[[ a < b ]]").redirects).toEqual([]);
  });

  test("&& binds tighter than ||", () => {
    expect(expr("[[ -f a || -f b && -x c ]]")).toBe("((-f a) || ((-f b) && (-x c)))");
  });

  test("parentheses group", () => {
    expect(expr("[[ ( -f a || -f b ) && -x c ]]")).toBe("(((-f a) || (-f b)) && (-x c))");
  });

  test("negation", () => {
    expect(expr("[[ ! -f x ]]")).toBe("(! (-f x))");
    expect(expr("[[ ! -f a && ! -d b ]]")).toBe("((! (-f a)) && (! (-d b)))");
  });

  test("a bare word is tested for being non-empty", () => {
    expect(expr("[[ $x ]]")).toBe("x");
  });

  test("an empty test has no expression", () => {
    expect(command("[[ ]]").expression).toBeNull();
  });

  test("trailing redirects still belong to the command", () => {
    const cmd = command("[[ -f x ]] > out.txt");
    expect(cmd.redirects.length).toBe(1);
    expect(cmd.redirects[0].op).toBe(">");
  });

  test("redirection still works after the test ends", () => {
    const words = tokenize("[[ a < b ]]; cat <f").filter(t => t.type !== TokenType.EOF);
    expect(words.filter(t => t.type === TokenType.Redirect).map(t => t.value)).toEqual(["<"]);
  });

  test("a glob in a pattern operand survives", () => {
    const right = command('[[ "$NAME" == w* ]]').expression.right;
    expect(right.parts.map((p: any) => p.type)).toEqual(["Word", "GlobPattern"]);
  });

  test("malformed tests do not hang", () => {
    for (const src of ["[[", "[[ -f ]]", "[[ && ]]", "[[ ( ]]", "[[ a ==", "[[ ! ]]"]) {
      expect(() => parseShell(src)).not.toThrow();
    }
  });
});

describe("case terminators", () => {
  const items = (src: string) => (parseShell(src).commands[0] as any).commands[0].items;

  test(";; ends the case", () => {
    expect(items("case x in a) :;; esac").map((i: any) => i.terminator)).toEqual([";;"]);
  });

  test(";& falls through to the next body", () => {
    const parsed = items("case x in a) :;& b) :;; esac");
    expect(parsed.length).toBe(2);
    expect(parsed.map((i: any) => i.terminator)).toEqual([";&", ";;"]);
  });

  test(";;& goes on testing later patterns", () => {
    const parsed = items("case x in a) :;;& b) :;; esac");
    expect(parsed.length).toBe(2);
    expect(parsed.map((i: any) => i.terminator)).toEqual([";;&", ";;"]);
  });

  test("a final item may omit its terminator", () => {
    expect(items("case x in a) :; esac").map((i: any) => i.terminator)).toEqual([null]);
  });
});

describe("fixture: sample.sh", () => {
  test("parses the full fixture without throwing", async () => {
    const src = await Bun.file("fixtures/sample.sh").text();
    expect(() => parseShell(src)).not.toThrow();
  });

  test("fixture produces correct top-level command count", async () => {
    const src = await Bun.file("fixtures/sample.sh").text();
    const script = parseShell(src);
    // Should have many top-level commands (assignments, commands, if, for, etc.)
    expect(script.commands.length).toBeGreaterThan(20);
  });

  test("fixture comments are collected", async () => {
    const src = await Bun.file("fixtures/sample.sh").text();
    const script = parseShell(src);
    expect(script.comments.length).toBeGreaterThan(5);
  });
});
