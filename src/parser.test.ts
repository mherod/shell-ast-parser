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

  test("double brackets parsed as simple command", () => {
    const script = parseShell('[[ "$x" == y ]]');
    const pipeline = script.commands[0]! as any;
    const cmd = pipeline.commands[0];
    expect(cmd.type).toBe("SimpleCommand");
    expect(cmd.name.parts[0].value).toBe("[[");
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
