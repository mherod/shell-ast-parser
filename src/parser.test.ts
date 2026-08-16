import { test, expect, describe } from "bun:test";
import { parseShell, parse, ParseError, tokenize, TokenType, visit, firstOf } from "../index.ts";
import type { Dialect, IfClause, ProcessSubstitution } from "../src/ast.ts";

function parseCmd(src: string) {
  const script = parseShell(src);
  return script.commands;
}

/** Narrow the first command of a script down to an `IfClause`, unwrapping the `Pipeline` layer parseCmd leaves in place. */
function firstIfClause(src: string, dialect: Dialect = "bash"): IfClause {
  const [command] = parseShell(src, { dialect }).commands;
  if (command === undefined || command.type !== "Pipeline") throw new Error(`expected a Pipeline, got ${command?.type}`);
  const [inner] = command.commands;
  if (inner === undefined || inner.type !== "IfClause") throw new Error(`expected an IfClause, got ${inner?.type}`);
  return inner;
}

/** Narrow the first arg-part of the first command down to a `ProcessSubstitution`. */
function firstProcessSubstitution(src: string): ProcessSubstitution {
  const [command] = parseShell(src).commands;
  if (command === undefined || command.type !== "Pipeline") throw new Error(`expected a Pipeline, got ${command?.type}`);
  const [inner] = command.commands;
  if (inner === undefined || inner.type !== "SimpleCommand") throw new Error(`expected a SimpleCommand, got ${inner?.type}`);
  const [firstArg] = inner.args;
  if (firstArg === undefined || firstArg.type !== "CompoundWord") throw new Error(`expected a CompoundWord arg, got ${firstArg?.type}`);
  const [firstPart] = firstArg.parts;
  if (firstPart === undefined || firstPart.type !== "ProcessSubstitution") throw new Error(`expected a ProcessSubstitution part, got ${firstPart?.type}`);
  return firstPart;
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

  test("elif branches carry a type and a source-accurate range", () => {
    const src = "if a; then b; elif c; then d; else e; fi";
    const ifCmd = firstIfClause(src);
    const elif = ifCmd.elifs[0]!;
    const elifText = src.slice(elif.range.start, elif.range.end);

    expect(elif.type).toBe("ElifBranch");
    expect(elifText.startsWith("elif")).toBe(true);
    expect(elifText).not.toContain("else");
    expect(elif.condition.range.start).toBeGreaterThanOrEqual(elif.range.start);
    expect(elif.then.range.end).toBeLessThanOrEqual(elif.range.end);
  });

  test("for loop", () => {
    const script = parseShell("for i in 1 2 3; do echo $i; done");
    const pipeline = script.commands[0]! as any;
    const forCmd = pipeline.commands[0];
    expect(forCmd.type).toBe("ForClause");
    expect(forCmd.variables).toEqual(["i"]);
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

describe("redirects", () => {
  test("a redirect with no target word throws, pointing at the newline", () => {
    try {
      parseShell("echo hello >\n");
      throw new Error("expected parseShell to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).token.type).toBe(TokenType.Newline);
    }
  });

  test("a redirect with no target word throws, pointing at EOF", () => {
    try {
      parseShell("cmd 2>");
      throw new Error("expected parseShell to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).token.type).toBe(TokenType.EOF);
    }
  });

  test("a redirect followed by an operator throws rather than swallowing it", () => {
    expect(() => parseShell("cmd < ; echo after")).toThrow(ParseError);
  });

  test("valid redirections still parse cleanly", () => {
    expect(() => parseShell("cmd > file.txt")).not.toThrow();
    expect(() => parseShell("cmd 2>&1")).not.toThrow();
  });

  test("a redirect's range still spans from the operator through the target word", () => {
    const src = "cmd > file.txt";
    const redirect = firstOf(parseShell(src), "Redirect");
    if (redirect === null) throw new Error("expected a Redirect node");
    expect(src.slice(redirect.range.start, redirect.range.end)).toBe("> file.txt");
  });
});

describe("pipelines and lists require both operands", () => {
  test("a trailing pipe with no right-hand command throws", () => {
    expect(() => parseShell("echo hello |\n")).toThrow(ParseError);
  });

  test("a trailing && with no right-hand command throws", () => {
    expect(() => parseShell("echo hello &&\n")).toThrow(ParseError);
  });

  test("a trailing || with no right-hand command throws", () => {
    expect(() => parseShell("echo hello ||\n")).toThrow(ParseError);
  });

  test("a leading || with no left-hand command throws", () => {
    expect(() => parseShell("|| echo hello\n")).toThrow(ParseError);
  });

  test("a leading && with no left-hand command throws", () => {
    expect(() => parseShell("&& echo hello\n")).toThrow(ParseError);
  });

  test("a leading | with no left-hand command throws", () => {
    expect(() => parseShell("| echo hello\n")).toThrow(ParseError);
  });

  test("valid pipelines still parse correctly", () => {
    const pipeline = firstOf(parseShell("a | b | c"), "Pipeline");
    if (pipeline === null) throw new Error("expected a Pipeline node");
    expect(pipeline.commands.length).toBe(3);
  });

  test("valid lists still parse correctly", () => {
    const list = firstOf(parseShell("a && b || c"), "List");
    if (list === null) throw new Error("expected a List node");
    expect(list.op).toBe("||");
  });

  test("a true assignment-only command still parses", () => {
    expect(() => parseShell("FOO=bar")).not.toThrow();
  });

  test("a bare redirect with no command name still parses", () => {
    expect(() => parseShell("> out.txt")).not.toThrow();
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
  const parts = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts;

  test("a quoted ) does not end a command substitution", () => {
    const inner = parts('echo $(grep ")" f)')[0].body.commands[0].commands[0];
    expect(inner.args.map((a: any) => a.parts[0].value)).toEqual([")", "f"]);
  });

  test("a quoted } does not end a parameter expansion", () => {
    expect(parts('echo ${x:-"}"}')[0].expression).toBe('x:-"}"');
  });

  test("a substitution inside double quotes keeps its own quotes", () => {
    expect(parts('echo "$(grep ")" f)"')[0].type).toBe("CommandSubstitution");
  });

  test("arithmetic keeps nested parens and consumes both closers", () => {
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
  test("# stays an operator inside ${ }", () => {
    const part = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts[0];
    expect(part("echo ${#NAME}").expression).toBe("#NAME");
    expect(part("echo ${NAME#pre}").expression).toBe("NAME#pre");
    expect(part("echo ${NAME##pre}").expression).toBe("NAME##pre");
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
  const substitution = (src: string) =>
    (parseShell(src).commands[0] as any).commands[0].assignments[0].value.parts[0];
  const inner = (src: string) => substitution(src).body.commands[0].commands[0];

  test("a ) in the body does not close the substitution", () => {
    const src = "x=$(cat <<EOF\na ) b\nEOF\n)";
    expect(inner(src).redirects[0].target.content).toBe("a ) b\n");
  });

  test("an unbalanced quote in the body is inert", () => {
    const src = 'x=$(cat <<EOF\nits " odd\nEOF\n)';
    expect(inner(src).redirects[0].target.content).toBe('its " odd\n');
  });

  test("<<- bodies are skipped and stripTabs is recorded", () => {
    const src = "x=$(cat <<-EOF\n\tindented )\n\tEOF\n)";
    expect(inner(src).redirects[0].target.stripTabs).toBe(true);
  });

  test("a quoted delimiter still suppresses expansion", () => {
    const src = "x=$(cat <<'EOF'\n$(nope)\nEOF\n)";
    const target = inner(src).redirects[0].target;
    expect(target.quoted).toBe(true);
    expect(target.content).toBe("$(nope)\n");
  });

  test("two heredocs in one substitution keep their own bodies", () => {
    const src = "x=$(cat <<A <<B\none )\nA\ntwo )\nB\n)";
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
    const procSub = firstProcessSubstitution(src);
    expect(procSub.body.commands.length).toBe(1);
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
    expect(loop.variables).toEqual(["i"]);
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

  test("a glob in a pattern operand survives", () => {
    const right = command('[[ "$NAME" == w* ]]').expression.right;
    expect(right.parts.map((p: any) => p.type)).toEqual(["Word", "GlobPattern"]);
  });

  test("malformed tests do not hang", () => {
    for (const src of ["[[ -f ]]", "[[ && ]]"]) {
      expect(() => parseShell(src)).not.toThrow();
    }

    // A condition that never closes is a syntax error in the shell too, so the
    // parser says where it ran out rather than returning a tree missing the
    // operands it never reached
    for (const src of ["[[", "[[ ( ]]", "[[ a ==", "[[ ! ]]"]) {
      expect(() => parseShell(src)).toThrow(ParseError);
    }
  });

  test("a condition spans lines, breaking before its operator", () => {
    const multiline = command("[[ -n $A\n   || -n $B ]]");
    const oneline = command("[[ -n $A || -n $B ]]");

    expect(multiline.type).toBe("TestCommand");
    expect(multiline.expression.type).toBe("TestLogical");
    expect(multiline.expression.op).toBe(oneline.expression.op);
    expect(parseShell("[[ -n $A\n   || -n $B ]]").commands.length).toBe(1);
  });

  test("a condition spans lines inside an if", () => {
    const cmds = parseCmd("if [[ -n $A\n  && -z $B\n]]; then\n  echo yes\nfi");
    const clause = (cmds[0] as any).commands[0];

    expect(clause.type).toBe("IfClause");
    expect(clause.condition.commands[0].commands[0].expression.type).toBe("TestLogical");
  });

  test("a comment inside a condition is not part of it", () => {
    const cmd = command("[[ -n $A\n   # why\n   && -z $B\n]]");

    expect(cmd.expression.type).toBe("TestLogical");
    expect(cmd.expression.left.type).toBe("TestUnary");
    expect(cmd.expression.right.type).toBe("TestUnary");
  });

  test("a newline straight after [[ is whitespace", () => {
    const cmd = command("[[\n  -n $A\n]]");

    expect(cmd.expression.type).toBe("TestUnary");
    expect(cmd.expression.op).toBe("-n");
  });

  test("a newline still ends the [ builtin", () => {
    // `[` is an ordinary command, so the newline terminates it as usual
    const cmds = parseCmd("[ -n $A ]\necho after");
    expect(cmds.length).toBe(2);
  });
});

describe("=~ regex operands", () => {
  const command = (src: string) => (parseShell(src).commands[0] as any).commands[0];

  /** Compact rendering so structure is visible at a glance */
  const show = (n: any): string => {
    switch (n?.type) {
      case "RegexLiteral": return JSON.stringify(n.value);
      case "RegexAny": return ".";
      case "RegexAnchor": return n.kind === "start" ? "^" : "$";
      case "RegexGroup": return `(${show(n.body)})`;
      case "RegexClass":
        return `[${n.negated ? "!" : ""}${n.members.map((m: any) =>
          m.type === "GlobRange" ? `${m.from}-${m.to}` :
          m.type === "GlobClass" ? `${m.kind}:${m.name}` : m.value).join(",")}]`;
      case "RegexQuantifier": return `${show(n.operand)}{${n.min},${n.max ?? ""}}`;
      case "RegexAlternation": return `alt(${n.alternatives.map(show).join(" | ")})`;
      case "RegexSequence": return `seq(${n.items.map(show).join(" ")})`;
      case "RegexEscape": return `undefined(${n.char})`;
      case "RegexBackreference": return `backref(${n.group})`;
      case "RegexShorthand": return `short(${n.char})`;
      case "RegexBoundary": return `bound(${n.kind})`;
      case "RegexExpansion": return `<${n.part.type}>`;
      default: return "null";
    }
  };
  const regex = (pattern: string) => show(command(`[[ $s =~ ${pattern} ]]`).expression.regex);

  test("anchors, literals and any", () => {
    expect(regex("^a.b$")).toBe('seq(^ "a" . "b" $)');
  });

  test("quantifiers, including bounds", () => {
    expect(regex("a*")).toBe('"a"{0,}');
    expect(regex("a+")).toBe('"a"{1,}');
    expect(regex("a?")).toBe('"a"{0,1}');
    expect(regex("a{2}")).toBe('"a"{2,2}');
    expect(regex("a{2,}")).toBe('"a"{2,}');
    expect(regex("a{2,3}")).toBe('"a"{2,3}');
  });

  test("a quantifier binds only the character before it", () => {
    expect(regex("ab*")).toBe('seq("a" "b"{0,})');
  });

  test("groups and alternation", () => {
    expect(regex("(a|b)")).toBe('(alt("a" | "b"))');
    expect(regex("^(foo|bar)$")).toBe('seq(^ (alt("foo" | "bar")) $)');
    expect(regex("(ab)+c")).toBe('seq(("ab"){1,} "c")');
  });

  test("character classes reuse the bracket syntax", () => {
    expect(regex("[abc]+")).toBe("[a,b,c]{1,}");
    expect(regex("[a-z0-9_]")).toBe("[a-z,0-9,_]");
    expect(regex("[^a-z]")).toBe("[!a-z]");
    expect(regex("[[:digit:]]{3}")).toBe("[class:digit]{3,3}");
  });

  describe("escapes", () => {
    test("an escaped metacharacter is the literal character", () => {
      // the one escape POSIX ERE actually defines
      expect(regex("\\.")).toBe('"."');
      expect(regex("\\*")).toBe('"*"');
      expect(regex("\\\\")).toBe('"\\\\"');
      expect(regex("a\\.b")).toBe('seq("a" "." "b")');
    });

    test("\\w and \\s carry the class they stand for", () => {
      const shorthand = (pattern: string) =>
        command(`[[ $s =~ ${pattern} ]]`).expression.regex;
      expect(shorthand("\\w").type).toBe("RegexShorthand");
      expect(shorthand("\\w").equivalent).toBe("[[:alnum:]_]");
      expect(shorthand("\\W").negated).toBe(true);
      expect(shorthand("\\W").equivalent).toBe("[^[:alnum:]_]");
      expect(shorthand("\\s").equivalent).toBe("[[:space:]]");
    });

    test("boundaries are named", () => {
      const boundary = (pattern: string) =>
        command(`[[ $s =~ ${pattern} ]]`).expression.regex;
      expect(boundary("\\b").kind).toBe("word");
      expect(boundary("\\B").kind).toBe("notWord");
      expect(boundary("\\<").kind).toBe("wordStart");
      expect(boundary("\\>").kind).toBe("wordEnd");
    });

    test("backreferences carry their group number", () => {
      const node = command("[[ $s =~ (a)\\1 ]]").expression.regex.items[1];
      expect(node.type).toBe("RegexBackreference");
      expect(node.group).toBe(1);
    });

    test("shorthands quantify like anything else", () => {
      expect(regex("\\w+")).toBe("short(w){1,}");
    });

    test("POSIX leaves the rest undefined, including \\n and \\d", () => {
      // ERE has no C-style escapes: \n is not a newline, and \d is PCRE's
      for (const pattern of ["\\d", "\\n", "\\t", "\\q"]) {
        expect(command(`[[ $s =~ ${pattern} ]]`).expression.regex.type).toBe("RegexEscape");
      }
    });
  });

  test("a quoted run matches literally, as bash requires", () => {
    expect(regex('"a.b"')).toBe('"a.b"');
    expect(regex("'x*'")).toBe('"x*"');
  });

  test("an expansion supplies its pattern at runtime", () => {
    expect(regex("$re")).toBe("<VariableExpansion>");
    expect(regex("^$prefix.*")).toBe("seq(^ <VariableExpansion> .{0,})");
    expect(command("[[ $s =~ $(f) ]]").expression.regex.part.type).toBe("CommandSubstitution");
  });

  test("parens let a space or | into the operand", () => {
    expect(regex("(a b)+")).toBe('("a b"){1,}');
  });

  test("only =~ gets a regex", () => {
    expect(command("[[ $x == y ]]").expression.regex).toBeNull();
    expect(command("[ $x = y ]").expression.regex).toBeNull();
  });

  test("the operand word is still available", () => {
    const right = command("[[ $s =~ ^(a|b)$ ]]").expression.right;
    expect(right.parts.map((p: any) => p.value).join("")).toBe("^(a|b)$");
  });

  test("node ranges index the source", () => {
    const src = "[[ $s =~ ^ab$ ]]";
    const node = command(src).expression.regex.items[1];
    expect(src.slice(node.range.start, node.range.end)).toBe("ab");
  });

  test("a missing operand is not the closing ]]", () => {
    const binary = command("[[ $s =~ ]]").expression;
    expect(binary.type).toBe("TestBinary");
    expect(binary.right.parts.length).toBe(0);
    expect(binary.regex).toBeNull();
  });

  test("malformed patterns do not hang", () => {
    for (const src of ["[[ $s =~ ) ]]", "[[ $s =~ [ ]]", "[[ $s =~ * ]]", "[[ $s =~ a{ ]]"]) {
      expect(() => parseShell(src)).not.toThrow();
    }

    // The unclosed group takes the `]]` into the pattern, so the condition has
    // no terminator left — bash rejects this one too
    expect(() => parseShell("[[ $s =~ ( ]]")).toThrow(ParseError);
  });
});

describe("the [ ] and test builtin", () => {
  const command = (src: string) => (parseShell(src).commands[0] as any).commands[0];
  const text = (word: any) => word.parts.map((p: any) => p.value ?? p.expression ?? p.type).join("");

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

  test("[ … ] is a TestCommand, distinguished by style", () => {
    expect(command("[ -f x ]").type).toBe("TestCommand");
    expect(command("[ -f x ]").style).toBe("[");
    expect(command("[[ -f x ]]").style).toBe("[[");
    expect(command("test -f x").style).toBe("test");
  });

  test("unary and binary operators", () => {
    expect(expr("[ -f x ]")).toBe("(-f x)");
    expect(expr("[ $x = y ]")).toBe("(x = y)");
    expect(expr("[ $n -lt 3 ]")).toBe("(n -lt 3)");
  });

  test("-a and -o join, and -a binds tighter", () => {
    expect(expr("[ -f a -o -f b ]")).toBe("((-f a) -o (-f b))");
    expect(expr("[ -f a -a -x b -o -d c ]")).toBe("(((-f a) -a (-x b)) -o (-d c))");
  });

  test("negation", () => {
    expect(expr("[ ! -f x ]")).toBe("(! (-f x))");
  });

  test("grouping works escaped or quoted, as the shell requires", () => {
    expect(expr("[ \\( -f a -o -f b \\) -a -x c ]")).toBe("(((-f a) -o (-f b)) -a (-x c))");
    expect(expr("[ '(' -f a ')' ]")).toBe("(-f a)");
  });

  test("a bare word is tested for being non-empty", () => {
    expect(expr("[ $x ]")).toBe("x");
  });

  test("an empty test has no expression", () => {
    expect(command("[ ]").expression).toBeNull();
    expect(command("test").expression).toBeNull();
  });

  test("test takes the same operators without brackets", () => {
    expect(expr("test -f x")).toBe("(-f x)");
    expect(expr("test $a = $b")).toBe("(a = b)");
  });

  test("< really is a redirection here, unlike in [[ … ]]", () => {
    const cmd = command("[ a < b ]");
    expect(cmd.redirects.length).toBe(1);
    expect(expr("[ a < b ]")).toBe("a");
    // the keyword form compares instead
    expect(command("[[ a < b ]]").redirects).toEqual([]);
  });

  test("prefix assignments and redirects are kept", () => {
    expect(command("FOO=1 [ -f x ]").assignments.length).toBe(1);
    expect(command("[ -f x ] > out").redirects.length).toBe(1);
  });

  describe("only as a command name", () => {
    test("[ and test as arguments stay words", () => {
      expect(command("echo test").args[0].parts[0].value).toBe("test");
      expect(command("echo [").args[0].parts[0].value).toBe("[");
    });

    test("a function named test is still a definition", () => {
      expect(command("test() { :; }").type).toBe("FunctionDef");
    });
  });

  test("malformed tests do not hang", () => {
    for (const src of ["[", "[ -f ]", "[ -f a -o ]", "[ \\( ]", "[ ! ]", "[ -f a", "test -f"]) {
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

describe("glob decomposition", () => {
  const glob = (src: string) => (parseShell(src).commands[0] as any).commands[0].args[0].parts[0];
  const members = (src: string) =>
    glob(src).members.map((m: any) =>
      m.type === "GlobRange" ? `${m.from}-${m.to}` :
      m.type === "GlobClass" ? `${m.kind}(${m.name})` :
      m.value);
  const alternatives = (src: string) =>
    glob(src).alternatives.map((a: any) => a.parts.map((p: any) => p.value ?? p.expression ?? p.type).join(""));

  test("wildcards report their kind", () => {
    expect(glob("echo *.sh").kind).toBe("wildcard");
    expect(glob("echo file?.x").parts?.length).toBeUndefined();
  });

  describe("bracket expressions", () => {
    test("single characters", () => {
      expect(glob("echo [abc]").kind).toBe("bracket");
      expect(members("echo [abc]")).toEqual(["a", "b", "c"]);
    });

    test("ranges", () => {
      expect(members("echo [a-z0-9_]")).toEqual(["a-z", "0-9", "_"]);
    });

    test("negation, either spelling", () => {
      expect(glob("echo [!a-z]").negated).toBe(true);
      expect(glob("echo [^abc]").negated).toBe(true);
      expect(glob("echo [abc]").negated).toBe(false);
    });

    test("a dash with no neighbour is a literal", () => {
      expect(members("echo [-a]")).toEqual(["-", "a"]);
      expect(members("echo [a-]")).toEqual(["a", "-"]);
    });

    test("a leading ] is a member", () => {
      expect(members("echo []a]")).toEqual(["]", "a"]);
    });

    test("POSIX classes, equivalences and collating elements", () => {
      expect(members("echo [[:alpha:]]")).toEqual(["class(alpha)"]);
      expect(members("echo [[=a=]]")).toEqual(["equivalence(a)"]);
      expect(members("echo [[.a.]]")).toEqual(["collating(a)"]);
    });

    test("classes mix with ordinary members", () => {
      expect(members("echo [[:upper:][:digit:]x]")).toEqual(["class(upper)", "class(digit)", "x"]);
    });

    test("a class's ] does not end the expression", () => {
      expect(glob("echo [[:alpha:]]").value).toBe("[[:alpha:]]");
    });

    test("member ranges index the source", () => {
      const src = "echo [a-z]";
      const member = glob(src).members[0];
      expect(src.slice(member.range.start, member.range.end)).toBe("a-z");
    });
  });

  describe("extended globs", () => {
    test("alternatives are separated", () => {
      expect(glob("echo @(a|b)").kind).toBe("extended");
      expect(glob("echo @(a|b)").op).toBe("@");
      expect(alternatives("echo @(a|b)")).toEqual(["a", "b"]);
    });

    test("an expansion inside an alternative is a node", () => {
      const parts = glob("echo @($x|b)").alternatives[0].parts;
      expect(parts[0].type).toBe("VariableExpansion");
      expect(parts[0].expression).toBe("x");
    });

    test("a command substitution inside an alternative is parsed", () => {
      const sub = glob("echo @(a|$(f))").alternatives[1].parts[0];
      expect(sub.type).toBe("CommandSubstitution");
      expect(sub.body.commands[0].commands[0].name.parts[0].value).toBe("f");
    });

    test("alternatives may hold other globs", () => {
      const parts = glob("echo !(*.o|*.a)").alternatives[0].parts;
      expect(parts[0].kind).toBe("wildcard");
      expect(parts[1].value).toBe(".o");
    });

    test("groups nest", () => {
      const inner = glob("echo @(a|@(b|c))").alternatives[1].parts[0];
      expect(inner.kind).toBe("extended");
      expect(inner.alternatives.map((a: any) => a.parts[0].value)).toEqual(["b", "c"]);
    });

    test("a | inside a bracket does not split alternatives", () => {
      expect(alternatives("echo @(a|[b|c])")).toEqual(["a", "[b|c]"]);
    });

    test("alternative ranges index the source", () => {
      const src = "echo @(abc|def)";
      expect(glob(src).alternatives.map((a: any) => src.slice(a.range.start, a.range.end)))
        .toEqual(["abc", "def"]);
    });
  });

  test("malformed patterns do not hang", () => {
    for (const src of ["echo [", "echo []", "echo [!]", "echo [[:", "echo [[:alpha:", "echo @(", "echo @(a|b"]) {
      expect(() => parseShell(src)).not.toThrow();
    }
  });
});

describe("builtin shadowing", () => {
  const kinds = (src: string) =>
    parseShell(src).commands.map((c: any) => (c.commands?.[0] ?? c).type);

  test("a function defined first takes the name from let", () => {
    expect(kinds("let() { :; }\nlet x=1")).toEqual(["FunctionDef", "SimpleCommand"]);
  });

  test("a definition after the call does not reach back", () => {
    // the builtin is still in effect when the first line runs
    expect(kinds("let x=1\nlet() { :; }")).toEqual(["LetCommand", "FunctionDef"]);
  });

  test("the function keyword form shadows too", () => {
    expect(kinds("function let { :; }\nlet x=1")).toEqual(["FunctionDef", "SimpleCommand"]);
  });

  test("test and [ can be shadowed", () => {
    expect(kinds("test() { :; }\ntest -f x")).toEqual(["FunctionDef", "SimpleCommand"]);
    expect(kinds("[() { :; }\n[ -f x ]")).toEqual(["FunctionDef", "SimpleCommand"]);
  });

  test("a shadowed declaration builtin stops treating its args as assignments", () => {
    const command = (parseShell("export() { :; }\nexport A=1").commands[1] as any).commands[0];
    expect(command.type).toBe("SimpleCommand");
    expect(command.args[0].type).toBe("CompoundWord");
  });

  test("an unrelated function changes nothing", () => {
    expect(kinds("f() { :; }\nlet x=1")).toEqual(["FunctionDef", "LetCommand"]);
  });

  test("[[ … ]] is a keyword and cannot be shadowed", () => {
    expect(kinds("let() { :; }\n[[ -f x ]]")).toEqual(["FunctionDef", "TestCommand"]);
  });

  test("a definition inside a subshell is treated as shadowing, which over-reaches", () => {
    // bash would confine it to the subshell and keep the builtin outside;
    // tracking that needs scope analysis this parser does not do
    expect(kinds("(let() { :; })\nlet x=1")).toEqual(["Subshell", "SimpleCommand"]);
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

describe("the zsh dialect", () => {
  const zsh = (src: string) => parseShell(src, { dialect: "zsh" });
  const first = (src: string) => (zsh(src).commands[0] as any).commands[0];

  /** Every zsh-only construct must still be refused when reading bash */
  const ZSH_ONLY = [
    "function {\n  echo hi\n}",
    'for x ("$a[@]") echo $x',
    "for k v in a b; do :; done",
    "repeat 3 do echo hi; done",
    "[[ $x == (a|b) ]]",
    "[[ $v == <1-> ]]",
    "X=($HOME/bin(N) $X)",
  ];

  test("bash refuses what only zsh accepts", () => {
    for (const src of ZSH_ONLY) {
      expect(() => parseShell(src, { dialect: "bash" })).toThrow(ParseError);
      expect(() => parseShell(src, { dialect: "zsh" })).not.toThrow();
    }
  });

  test("the default dialect is bash", () => {
    expect(() => parseShell("[[ $v == <1-> ]]")).toThrow(ParseError);
  });

  test("an anonymous function has no name and may take arguments", () => {
    expect(first("function {\n  echo hi\n}").name).toBeNull();

    const withArgs = first("function {\n  echo $1\n} a b");
    expect(withArgs.name).toBeNull();
    expect(withArgs.args.length).toBe(2);
  });

  test("a named function is unaffected", () => {
    expect(first("function f {\n  echo hi\n}").name).toBe("f");
    expect(first("f() { echo hi; }").args).toEqual([]);
  });

  test("the short for-loop means what the long one means", () => {
    for (const src of ['for x (a b) echo $x', 'for x (a b) { echo $x }', 'for x (a b); do echo $x; done']) {
      const loop = first(src);
      expect(loop.type).toBe("ForClause");
      expect(loop.variables).toEqual(["x"]);
      expect(loop.words.length).toBe(2);
    }
  });

  test("a for-loop body may be a single command after `in`", () => {
    const loop = first("for key in a b\n  bindkey $key\n");
    expect(loop.type).toBe("ForClause");
    expect(loop.body.commands.length).toBe(1);
  });

  test("a for-loop deals its words out between several variables", () => {
    expect(first("for k v in a b c d; do :; done").variables).toEqual(["k", "v"]);
  });

  test("repeat counts with a word, since the shell expands it", () => {
    const loop = first("repeat $n do echo hi; done");
    expect(loop.type).toBe("RepeatClause");
    expect(loop.count.parts[0].type).toBe("VariableExpansion");
  });

  test("repeat is an ordinary command name in bash", () => {
    const cmd = (parseShell("repeat 3", { dialect: "bash" }).commands[0] as any).commands[0];
    expect(cmd.type).toBe("SimpleCommand");
  });

  test("a glob qualifier closes the pattern it selects from", () => {
    const parts = first("print *(.)").args[0].parts;
    expect(parts.map((p: any) => p.kind)).toEqual(["wildcard", "qualifier"]);
    expect(parts[1].qualifiers).toBe(".");
  });

  test("a qualifier is told from a group by what precedes it", () => {
    // nothing before it, so this is a pattern group rather than a qualifier
    expect(first("[[ $x == (a|b) ]]").expression.right.parts[0].op).toBeNull();
    // `bin` precedes it, so it selects among the matches
    const value = first("X=($HOME/bin(N))").assignments[0].value;
    expect(value.elements[0].parts[2].kind).toBe("qualifier");
  });

  test("a function definition's empty parens are not a qualifier", () => {
    expect(first("f() { echo hi; }").type).toBe("FunctionDef");
  });

  test("an array literal is not a qualifier", () => {
    const value = first("X=(a b)").assignments[0].value;
    expect(value.type).toBe("ArrayLiteral");
    expect(value.elements.length).toBe(2);
  });

  test("a numeric range keeps its open ends", () => {
    const range = first("[[ $v == <1-> ]]").expression.right.parts[0];
    expect(range.kind).toBe("numeric-range");
    expect(range.min).toBe(1);
    expect(range.max).toBeNull();
  });

  test("a pattern nests ranges inside its alternatives", () => {
    const group = first("[[ $ZSH_VERSION == (5.<1->*|<6->.*) ]]").expression.right.parts[0];
    expect(group.op).toBeNull();
    expect(group.alternatives.length).toBe(2);
    expect(group.alternatives[0].parts.map((p: any) => p.kind ?? p.type))
      .toEqual(["Word", "numeric-range", "wildcard"]);
  });

  test("a subscript without braces belongs to the expansion", () => {
    const parts = first("echo $arg[0,1]").args[0].parts;
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("VariableExpansion");
    expect(parts[0].expression).toBe("arg[0,1]");
  });

  test("$#arr is a length, not $# and a word", () => {
    const parts = first("echo $#arg").args[0].parts;
    expect(parts.length).toBe(1);
    expect(parts[0].expression).toBe("#arg");
  });

  test("$#arr is still a length inside arithmetic", () => {
    // zsh -c 'arr=(a b c); echo $(( $#arr + 1 ))' prints 4
    const expansion = first("echo $(( $#arr + 1 ))").args[0].parts[0];
    expect(expansion.parsed).not.toBeNull();
    expect(expansion.parsed.op).toBe("+");
    expect(expansion.parsed.left.type).toBe("ArithmeticSubstitution");
    expect(expansion.parsed.left.part.expression).toBe("#arr");
  });

  test("$#arr is still a length in a C-style for header", () => {
    const loop = first("for (( i = $#arr; i > 0; i-- )); do :; done");
    expect(loop.type).toBe("ArithmeticForClause");
    expect(loop.init).not.toBeNull();
    expect(loop.init.value.part.expression).toBe("#arr");
  });

  test("$#arr is still a length in a regex operand", () => {
    const regex = first("[[ $s =~ ^$#arr$ ]]").expression.regex;
    const expansion = regex.items.find((i: any) => i.type === "RegexExpansion");
    expect(expansion.part.expression).toBe("#arr");
  });
});

describe("brace expansion", () => {
  const parts = (src: string) => {
    const cmd = (parseShell(src).commands[0] as any).commands[0];
    return cmd.args[0].parts;
  };

  test("a list keeps its items as words", () => {
    const brace = parts("echo {a,b,c}")[0];
    expect(brace.type).toBe("BraceExpansion");
    expect(brace.kind).toBe("list");
    expect(brace.items.map((i: any) => i.parts[0]?.value)).toEqual(["a", "b", "c"]);
  });

  test("an item may be empty", () => {
    // `{,s}bin` gives bin and sbin, so the first alternative expands to nothing
    // while still marking where it sat
    const brace = parts("echo {,s}bin")[0];
    expect(brace.items.length).toBe(2);
    expect(brace.items[0].parts[0].value).toBe("");
    expect(brace.items[0].range.start).toBe(brace.items[0].range.end);
  });

  test("an item keeps its expansion", () => {
    const brace = parts("echo {a,$x}")[0];
    expect(brace.items[1].parts[0].type).toBe("VariableExpansion");
  });

  test("a sequence keeps its endpoints as written", () => {
    const brace = parts("echo {0..255}")[0];
    expect(brace.kind).toBe("sequence");
    expect(brace.from).toBe("0");
    expect(brace.to).toBe("255");
    expect(brace.step).toBeNull();
  });

  test("a sequence may carry a step, and may count letters", () => {
    expect(parts("echo {0..20..5}")[0].step).toBe("5");
    expect(parts("echo {a..z}")[0].from).toBe("a");
  });

  test("braces that cannot expand stay literal", () => {
    // No comma and no `..`, so the shell leaves these alone
    for (const src of ["echo {a}", "echo {}", "echo ${x}"]) {
      expect(parts(src).some((p: any) => p.type === "BraceExpansion")).toBe(false);
    }
  });

  test("a brace group is still a brace group", () => {
    const cmd = (parseShell("{ echo hi; }").commands[0] as any).commands[0];
    expect(cmd.type).toBe("BraceGroup");
  });

  test("expansion works where a word list is expected", () => {
    const loop = (parseShell("for c in {0..3}; do :; done").commands[0] as any).commands[0];
    expect(loop.words[0].parts[0].kind).toBe("sequence");
  });
});

describe("quoting and escapes the shell resolves", () => {
  const first = (src: string) => (parseShell(src).commands[0] as any).commands[0];

  test("$'…' may contain an escaped quote", () => {
    // A plain '…' cannot hold a quote at all, so `\'` only means something here
    expect(() => parseShell("BUFFER=$': $(( 0 * 1\\'\\'000 ))'")).not.toThrow();
  });

  test("an escaped brace does not close an expansion", () => {
    // `\}` is literal, so the expansion ends at the last brace, not the first
    const cmd = first('x="${a:/p/\\${b}}"\necho after');
    expect(cmd.type).toBe("SimpleCommand");
    expect(parseShell('x="${a:/p/\\${b}}"\necho after').commands.length).toBe(2);
  });
});

describe("heredoc delimiters", () => {
  const commands = (src: string) => parseShell(src).commands;

  /** The first HereDoc anywhere, since it may sit inside an if or a loop */
  const heredoc = (src: string) => firstOf(parseShell(src), "HereDoc")!;

  test("a backslash quotes the delimiter, as quotes do", () => {
    // All three name EOF and all three suppress expansion; only the spelling
    // differs. Keeping the backslash left a delimiter no line could match, and
    // the body swallowed the rest of the file.
    for (const open of ["<<\\EOF", "<<'EOF'", '<<"EOF"']) {
      const doc = heredoc(`cat ${open}\nbody\nEOF\necho after\n`);
      expect(doc.delimiter).toBe("EOF");
      expect(doc.quoted).toBe(true);
      expect(commands(`cat ${open}\nbody\nEOF\necho after\n`).length).toBe(2);
    }
  });

  test("an unquoted delimiter still expands", () => {
    expect(heredoc("cat <<EOF\nbody\nEOF\n").quoted).toBe(false);
  });

  test("a metacharacter ends the delimiter", () => {
    // `cat << EOF; then` names EOF — the `;` belongs to the line
    const doc = heredoc("if cat << EOF; then\nbody\nEOF\n  echo yes\nfi\n");
    expect(doc.delimiter).toBe("EOF");
  });

  test("the body still ends when the line carries on", () => {
    for (const src of [
      "if cat << EOF; then\nbody\nEOF\n  echo yes\nfi\necho after\n",
      "while cat << EOF; do\nbody\nEOF\n  break\ndone\necho after\n",
    ]) {
      expect(commands(src).length).toBe(2);
    }
  });
});

describe("ranges survive a substitution's escapes", () => {
  // A backtick body is unescaped before parsing — `\$` becomes `$` — so it is
  // shorter than the source it came from. Shifting every range by one constant
  // left them a character early, and drifting further with each escape.
  const drifted = (src: string) => {
    const found: string[] = [];
    visit(parseShell(src), (node) => {
      if (node.type === "Word" && node.quoted === null && typeof node.value === "string") {
        if (src.slice(node.range.start, node.range.end) !== node.value) found.push(node.value);
      }
    });
    return found;
  };

  test("a backtick body with escapes keeps its ranges", () => {
    expect(drifted("x=`echo \\$(CC) -e b`")).toEqual([]);
    expect(drifted("x=`echo \\` -e b`")).toEqual([]);
    expect(drifted("x=`sed -e 's/\\$(CC)//' \\\n  -e 's/x//'`")).toEqual([]);
  });

  test("a word inside backticks still slices back to itself", () => {
    const src = "x=`echo \\$(CC) -e b`";
    const sub = (parseShell(src).commands[0] as any).commands[0].assignments[0].value.parts[0];
    expect(sub.type).toBe("CommandSubstitution");
    const arg = sub.body.commands[0].commands[0].args[1];
    expect(src.slice(arg.range.start, arg.range.end)).toBe("-e");
  });
});

describe("negation is not lost", () => {
  // `if ! grep …` used to parse as a command named "!", dropping the negation
  // and inverting what the condition meant.
  const conditionOf = (src: string) =>
    ((parseShell(src).commands[0] as any).commands[0]).condition.commands[0];

  test("a pipeline negates after if", () => {
    expect(conditionOf("if ! true; then :; fi").negated).toBe(true);
  });

  test("a pipeline negates after while", () => {
    expect(conditionOf("while ! true; do :; done").negated).toBe(true);
  });

  test("the negated command is still the command", () => {
    const pipeline = conditionOf("if ! grep -q x f; then :; fi");
    expect(pipeline.commands[0].name.parts[0].value).toBe("grep");
  });

  test("a plain pipeline is unaffected", () => {
    const pipeline = (parseShell("! true").commands[0] as any);
    expect(pipeline.negated).toBe(true);
  });
});

describe("case items", () => {
  const items = (src: string) => ((parseShell(src, { dialect: "zsh" }).commands[0] as any).commands[0]).items;

  test("a body may start on the pattern line with a keyword", () => {
    const body = items("case $x in\n  (none) if true; then\n    echo hi\n  fi\n  ;;\nesac")[0].body;
    expect(body.commands[0].commands[0].type).toBe("IfClause");
  });

  test("a pattern may hold a group", () => {
    const item = items("case $x in\n  (scalar|integer)*) echo hi;;\nesac")[0];
    expect(item.patterns.length).toBe(1);
    expect(item.patterns[0].parts.map((p: any) => p.kind)).toEqual(["extended", "wildcard"]);
  });

  test("a pattern may hold an unquoted space", () => {
    const item = items("case $x in\n  (*# SKIP*) echo hi;;\nesac")[0];
    expect(item.patterns.length).toBe(1);
  });

  test("alternatives still split on |", () => {
    expect(items("case $x in\n  a|b) echo hi;;\nesac")[0].patterns.length).toBe(2);
  });

  test("zsh spells ;;& as ;|", () => {
    expect(items("case $x in\n  a) echo hi;|\n  b) echo ho;;\nesac")[0].terminator).toBe(";|");
  });
});

describe("more of the zsh dialect", () => {
  const zsh = (src: string) => parseShell(src, { dialect: "zsh" });
  const first = (src: string) => (zsh(src).commands[0] as any).commands[0];

  test("a brace group may carry an always block", () => {
    const group = first("{ echo a } always { echo b }");
    expect(group.type).toBe("BraceGroup");
    expect(group.always.commands.length).toBe(1);
  });

  test("always survives inside a condition", () => {
    expect(() => zsh('if ! { read -q "?y " } always { echo "" }; then\n  :\nfi')).not.toThrow();
  });

  test("a plain brace group has no always", () => {
    expect(first("{ echo a; }").always).toBeNull();
  });

  test("if may take a brace body instead of then/fi", () => {
    const clause = first("if (( EUID == 0 )) { echo root }");
    expect(clause.type).toBe("IfClause");
    expect(clause.then.commands[0].type).toBe("BraceGroup");
  });

  test("a brace-form elif also carries a type and a source-accurate range", () => {
    const src = "if a { b } elif c { d } else { e }";
    const ifCmd = firstIfClause(src, "zsh");
    const elif = ifCmd.elifs[0]!;
    const elifText = src.slice(elif.range.start, elif.range.end);

    expect(elif.type).toBe("ElifBranch");
    expect(elifText.startsWith("elif")).toBe(true);
    expect(elifText).not.toContain("else");
  });

  test("a brace group can still be the condition itself", () => {
    expect(() => zsh("if { true }; then\n  :\nfi")).not.toThrow();
  });

  test("bash still needs then and fi", () => {
    expect(() => parseShell("if (( 1 )) { echo hi }", { dialect: "bash" })).toThrow(ParseError);
  });

  test("a numeric range works outside a condition", () => {
    const parts = first("print -l <->").args[1].parts;
    expect(parts[0].kind).toBe("numeric-range");
  });

  test("a numeric range may sit inside a larger pattern", () => {
    const value = first("x=($dir/<->-<->.data(.N))").assignments[0].value;
    const kinds = value.elements[0].parts.map((p: any) => p.kind ?? p.type);
    expect(kinds).toContain("numeric-range");
    expect(kinds).toContain("qualifier");
  });

  test("a redirect is still a redirect", () => {
    expect(first("cat < f").redirects[0].op).toBe("<");
  });
});

describe("line continuations", () => {
  // A backslash-newline is removed before parsing, so it contributes no token.
  // It used to arrive as a Word, which quietly added an argument to a command
  // and broke every condition or loop header split across lines.
  test("a continuation joins lines without leaving a word behind", () => {
    const cmd = (parseShell("echo one \\\n  two").commands[0] as any).commands[0];
    expect(cmd.args.length).toBe(2);
  });

  test("a condition may be split with a backslash", () => {
    const cmd = (parseShell("[[ -n $A \\\n  && -n $B ]]").commands[0] as any).commands[0];
    expect(cmd.expression.type).toBe("TestLogical");
  });

  test("a loop header may be split with a backslash", () => {
    const loop = (parseShell("for x \\\n  in a b; do :; done").commands[0] as any).commands[0];
    expect(loop.variables).toEqual(["x"]);
    expect(loop.words.length).toBe(2);
  });

  test("a continuation inside a word joins it", () => {
    const cmd = (parseShell("echo /a\\\n/b").commands[0] as any).commands[0];
    expect(cmd.args[0].parts[0].value).toBe("/a/b");
  });

  // The tokenizer drops the two continuation characters from a token's value
  // while the range still spans them, so any part offset computed as
  // range.start + index drifted two right per continuation — the same defect
  // the backtick position map fixed. The README's promise is the oracle here:
  // src.slice(part.range.start, part.range.end) is that part's text.
  test("a part after an in-word continuation still indexes the source", () => {
    const src = "echo ab\\\ncd$HOME";
    const parts = (parseShell(src).commands[0] as any).commands[0].args[0].parts;
    expect(parts[0].value).toBe("abcd");
    expect(src.slice(parts[1].range.start, parts[1].range.end)).toBe("$HOME");
  });

  test("an assignment value's parts survive a continuation", () => {
    const src = "X=/a\\\n/b$HOME";
    const assignment = (parseShell(src).commands[0] as any).commands[0].assignments[0];
    const expansion = assignment.value.parts[1];
    expect(src.slice(expansion.range.start, expansion.range.end)).toBe("$HOME");
  });

  test("a substitution body after a continuation still indexes the source", () => {
    const src = "echo ab\\\ncd$(date)";
    const sub = (parseShell(src).commands[0] as any).commands[0].args[0].parts[1];
    expect(sub.type).toBe("CommandSubstitution");
    expect(src.slice(sub.body.range.start, sub.body.range.end)).toBe("date");
  });

  test("a continuation joins inside double quotes too", () => {
    // bash -c 'echo "a\<newline>b"' prints ab, not a<newline>b
    const cmd = (parseShell('echo "a\\\nb"').commands[0] as any).commands[0];
    expect(cmd.args[0].parts[0].value).toBe("ab");
  });

  test("arithmetic joins a continuation like the shell does", () => {
    // bash -c 'echo $((1\<newline>+2))' prints 3
    const expansion = (parseShell("echo $((1\\\n+2))").commands[0] as any).commands[0].args[0].parts[0];
    expect(expansion.parsed).not.toBeNull();
    expect(expansion.parsed.op).toBe("+");
  });

  test("(( )) split by a continuation is arithmetic, not subshells", () => {
    // bash -c '((x=1\<newline>+2)); echo $x' prints 3
    const cmd = (parseShell("((x=1\\\n+2))").commands[0] as any).commands[0];
    expect(cmd.type).toBe("ArithmeticCommand");
    expect(cmd.parsed).not.toBeNull();
  });

  test("a let operand's ranges survive a continuation", () => {
    const src = "let x=1\\\n+2";
    const expr = (parseShell(src).commands[0] as any).commands[0].expressions[0];
    const two = expr.parsed.value.right;
    expect(src.slice(two.range.start, two.range.end)).toBe("2");
  });

  test("a regex operand joins a continuation", () => {
    // bash -c 's=ab; [[ $s =~ a\<newline>b ]] && echo yes' prints yes
    const regex = (parseShell("[[ $s =~ a\\\nb$v ]]").commands[0] as any).commands[0].expression.regex;
    expect(JSON.stringify(regex)).not.toContain("RegexEscape");
    expect(regex.items[0].value).toBe("a");
    expect(regex.items[1].value).toBe("b");
  });
});

describe("the closing brace of an expansion", () => {
  const zsh = (src: string) => parseShell(src, { dialect: "zsh" });
  const first = (src: string) => (zsh(src).commands[0] as any).commands[0];

  test("bash closes at the first unquoted }", () => {
    // bash -c 'y=Q; [[ "Qc}" =~ ^${y:-a{b}c}$ ]]' matches: the default value is
    // a{b, and c} is literal text outside the expansion
    const parts = (parseShell("echo ${x:-a{b}c}").commands[0] as any).commands[0].args[0].parts;
    expect(parts[0].expression).toBe("x:-a{b");
    expect(parts[1].value).toBe("c}");
  });

  test("zsh nests braces in an unquoted expansion", () => {
    // zsh -c 'y=Q; [[ "Q" =~ ^${y:-a{ }b}$ ]]' matches: the whole braced run
    // is the default value
    const parts = first("echo ${x:-a{b}c}").args[0].parts;
    expect(parts.length).toBe(1);
    expect(parts[0].expression).toBe("x:-a{b}c");
  });

  test("zsh inside double quotes closes like bash", () => {
    // zsh -c 'x=v; printf "[%s]\n" "${x:-{}}"' prints [v}]
    const parts = first('echo "${x:-a{b}c}"').args[0].parts;
    expect(parts[0].expression).toBe("x:-a{b");
  });

  test("a zsh word swallows a space inside nested braces", () => {
    // zsh -c 'x=v; printf "[%s]\n" ${x:-{ } q}' prints [v] — one argument —
    // where bash prints [v] and [q}], two
    const cmd = first("printf %s ${x:-{ } q}");
    expect(cmd.args.length).toBe(2);
    expect(cmd.args[1].parts[0].expression).toBe("x:-{ } q");

    const bashCmd = (parseShell("printf %s ${x:-{ } q}").commands[0] as any).commands[0];
    expect(bashCmd.args.length).toBe(3);
    expect(bashCmd.args[1].parts[0].expression).toBe("x:-{ ");
    expect(bashCmd.args[2].parts[0].value).toBe("q}");
  });

  test("arithmetic closes at the first } in both dialects", () => {
    // bash and zsh both reject $(( ${x:-{}} + 1 )): the expansion ends at the
    // first }, and the one left over is no arithmetic operator
    for (const dialect of ["bash", "zsh"] as const) {
      const expansion = (parseShell("echo $(( ${x:-{}} + 1 ))", { dialect }).commands[0] as any)
        .commands[0].args[0].parts[0];
      expect(expansion.parsed).toBeNull();
    }
  });

  test("a regex operand follows its dialect", () => {
    const src = "[[ $s =~ ^${y:-a{b}c}$ ]]";
    const expansionIn = (regex: any) => regex.items.find((i: any) => i.type === "RegexExpansion");

    const bashRegex = (parseShell(src).commands[0] as any).commands[0].expression.regex;
    expect(expansionIn(bashRegex).part.expression).toBe("y:-a{b");

    const zshRegex = first(src).expression.regex;
    expect(expansionIn(zshRegex).part.expression).toBe("y:-a{b}c");
  });

  test("a quoted ) does not close a zsh pattern group", () => {
    // zsh -c 'x="a)b"; [[ $x == ("a)b"|c) ]] && echo yes' prints yes
    const group = first('[[ $x == ("a)b"|c) ]]').expression.right.parts[0];
    expect(group.alternatives.length).toBe(2);
    expect(group.alternatives[0].parts[0].value).toBe("a)b");
  });
});

describe("a parse covers the whole source", () => {
  // A terminator that closes nothing used to end the top-level list quietly,
  // so everything past it vanished from a Script that looked complete. For a
  // caller auditing what a script runs, that is the one failure it cannot see.
  test("a stray closer is an error, not a shorter script", () => {
    for (const src of ["echo one\n)\necho after", "echo one\n}\necho after", "X=(a b))\necho after"]) {
      expect(() => parseShell(src)).toThrow(ParseError);
    }
  });

  test("the error points at the token that closes nothing", () => {
    try {
      parseShell("echo one\n)\necho after");
      throw new Error("expected a ParseError");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).token.value).toBe(")");
    }
  });

  test("commands after a balanced array still arrive", () => {
    const cmds = parseCmd("X=(a b)\necho after");
    expect(cmds.length).toBe(2);
  });

  test("comments after every top-level form are kept", () => {
    const src = "X=(\n  a\n)\n# one\nif true; then\n  echo hi\nfi\n# two\n";
    expect(parseShell(src).comments.length).toBe(2);
  });
});

describe("lone closing brace handling", () => {
  test("bash accepts a lone } mid-command as an argument", () => {
    const cmd = (parseShell("echo }").commands[0] as any).commands[0];
    expect(cmd.type).toBe("SimpleCommand");
    expect(cmd.args[0].parts[0].value).toBe("}");
  });

  test("bash distinguishes argument } from group-closing } in { echo }; }", () => {
    const group = (parseShell("{ echo }; }").commands[0] as any).commands[0];
    expect(group.type).toBe("BraceGroup");
    const innerCmd = group.body.commands[0].commands[0];
    expect(innerCmd.type).toBe("SimpleCommand");
    expect(innerCmd.args[0].parts[0].value).toBe("}");
  });

  test("zsh rejects a lone } mid-command", () => {
    expect(() => parseShell("echo }", { dialect: "zsh" })).toThrow(ParseError);
    expect(() => parseShell("{ echo }; }", { dialect: "zsh" })).toThrow(ParseError);
  });

  test("zsh accepts } attached to non-whitespace in argument position", () => {
    const cmd = (parseShell("echo }a", { dialect: "zsh" }).commands[0] as any).commands[0];
    expect(cmd.args[0].parts[0].value).toBe("}a");
  });
});

describe("tricky parser test bed cases", () => {
  test("deeply nested parameter expansions parse into a valid VariableExpansion node", () => {
    const script = parseShell('VAL="${A:-${B:-${C:-"fallback"}}}"');
    const [pipeline] = script.commands as any[];
    const cmd = pipeline.commands[0];
    const assign = cmd.assignments[0];
    expect(assign.name).toBe("VAL");
    expect(assign.value.parts[0].type).toBe("VariableExpansion");
    expect(assign.value.parts[0].expression).toBe('A:-${B:-${C:-"fallback"}}');
  });

  test("multiple chained heredocs across pipeline attach to their respective commands", () => {
    const src = "cmd1 <<EOF1 | cmd2 <<EOF2\nfirst body\nEOF1\nsecond body\nEOF2\n";
    const script = parseShell(src);
    const [pipeline] = script.commands as any[];
    expect(pipeline.commands.length).toBe(2);
    expect(pipeline.commands[0].redirects[0].target.content).toBe("first body\n");
    expect(pipeline.commands[1].redirects[0].target.content).toBe("second body\n");
  });

  test("nested ternary arithmetic conditional creates correct left/condition/then/else nodes", () => {
    const script = parseShell("(( res = a ? b : c ? d : e ))");
    const [pipeline] = script.commands as any[];
    const arithCmd = pipeline.commands[0];
    expect(arithCmd.type).toBe("ArithmeticCommand");
    expect(arithCmd.parsed).not.toBeNull();
    expect(arithCmd.parsed.type).toBe("ArithmeticAssignment");
    expect(arithCmd.parsed.value.type).toBe("ArithmeticConditional");
  });

  test("complex regex with IPv4 pattern parses into structured RegexNode", () => {
    const src = '[[ $ip =~ ^([0-9]{1,3}\\.){3}[0-9]{1,3}$ ]]';
    const script = parseShell(src);
    const [pipeline] = script.commands as any[];
    const testCmd = pipeline.commands[0];
    expect(testCmd.type).toBe("TestCommand");
    expect(testCmd.expression.type).toBe("TestBinary");
    expect(testCmd.expression.op).toBe("=~");
    expect(testCmd.expression.regex).not.toBeNull();
  });

  test("zsh anonymous functions with arguments parse into FunctionDef with name=null and args", () => {
    const src = 'function {\n  local x=$1\n  echo "$x"\n} "first" "second"\n';
    const script = parseShell(src, { dialect: "zsh" });
    const [pipeline] = script.commands as any[];
    const fnDef = pipeline.commands[0];
    expect(fnDef.type).toBe("FunctionDef");
    expect(fnDef.name).toBeNull();
    expect(fnDef.args.length).toBe(2);
    expect(fnDef.args[0].parts[0].value).toBe("first");
    expect(fnDef.args[1].parts[0].value).toBe("second");
  });

  test("zsh try-finally always block attaches always body to BraceGroup", () => {
    const src = '{\n  echo "unsafe"\n} always {\n  rm -f lock\n}\n';
    const script = parseShell(src, { dialect: "zsh" });
    const [pipeline] = script.commands as any[];
    const brace = pipeline.commands[0];
    expect(brace.type).toBe("BraceGroup");
    expect(brace.always).not.toBeNull();
    expect(brace.always.commands.length).toBe(1);
  });

  test("redirection applied to while loop carries onto WhileClause.redirects", () => {
    const src = 'while read -r line; do echo "$line"; done < input.txt > output.txt\n';
    const script = parseShell(src);
    const [pipeline] = script.commands as any[];
    const loop = pipeline.commands[0];
    expect(loop.type).toBe("WhileClause");
    expect(loop.redirects.length).toBe(2);
    expect(loop.redirects[0].op).toBe("<");
    expect(loop.redirects[1].op).toBe(">");
  });
});


