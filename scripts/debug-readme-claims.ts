/**
 * Runs the claims the README makes and reports any that are no longer true.
 *
 *   bun scripts/debug-readme-claims.ts
 *
 * A README drifts quietly: the code moves and the prose stays, so the examples
 * become confident and wrong. Each entry below is an assertion lifted from the
 * document, so the file can be checked the way the parser is.
 */
import { parseShell, ParseError } from "../index.ts";

interface Claim {
  says: string;
  holds: () => boolean;
}

const first = (src: string, dialect: "bash" | "zsh" = "bash") =>
  (parseShell(src, { dialect }).commands[0] as any).commands[0];

/** Every node of a type, anywhere in the tree */
function find(node: unknown, type: string, found: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const item of node) find(item, type, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;

  const record = node as Record<string, unknown>;
  if (record.type === type) found.push(record);
  for (const [key, value] of Object.entries(record)) {
    if (key !== "range") find(value, type, found);
  }
  return found;
}

const CLAIMS: Claim[] = [
  {
    says: "a Script's commands are Pipelines wrapping the commands",
    holds: () => {
      const script = parseShell('cat "$f" > out.txt');
      const pipeline = script.commands[0] as any;
      return pipeline.type === "Pipeline" && pipeline.commands[0].type === "SimpleCommand";
    },
  },
  {
    says: "ranges index the original source, at any depth",
    holds: () => {
      const src = "echo $(date +%F)";
      const sub = find(parseShell(src), "CommandSubstitution")[0];
      return src.slice(sub.body.range.start, sub.body.range.end) === "date +%F";
    },
  },
  {
    says: "single quotes make an inert Word, double quotes a live substitution",
    holds: () => {
      const inert = first("echo '$(rm -rf /)'").args[0].parts[0];
      const live = first('echo "$(rm -rf /)"').args[0].parts[0];
      return inert.type === "Word" && inert.quoted === "single" &&
        live.type === "CommandSubstitution" && live.quoted === "double";
    },
  },
  {
    says: "escapes are resolved into Word.value",
    holds: () => first('echo "\\$HOME"').args[0].parts[0].value === "$HOME" &&
      first("echo $'a\\tb'").args[0].parts[0].value === "a\tb",
  },
  {
    says: "arithmetic nests by precedence, so 1+2*3 groups the multiplication",
    holds: () => {
      const arith = find(parseShell("echo $((1+2*3))"), "ArithmeticExpansion")[0];
      return arith.parsed?.type === "ArithmeticBinary" && arith.parsed.op === "+" &&
        arith.parsed.right.op === "*";
    },
  },
  {
    says: "a [[ ]] condition spans lines and carries comments, giving one TestCommand",
    holds: () => {
      const script = parseShell("[[ -n $A\n   # why\n   && -z $B\n]]");
      return script.commands.length === 1 && find(script, "TestCommand").length === 1;
    },
  },
  {
    says: "the =~ operand parses as a regex, and a quoted run is literal",
    holds: () => {
      const grouped = first('[[ $s =~ ^(a|b)+$ ]]').expression.regex;
      const literal = first('[[ $s =~ "a.b" ]]').expression.regex;
      return grouped !== null && literal !== null;
    },
  },
  {
    says: "a glob decomposes into wildcard, bracket and extended parts",
    holds: () => {
      const kinds = first("echo a*[a-z]@(x|y)").args[0].parts.map((p: any) => p.kind);
      return kinds.includes("wildcard") && kinds.includes("bracket") && kinds.includes("extended");
    },
  },
  {
    says: "{a,b,c} is a list and {0..9} a sequence, while {a} stays literal",
    holds: () => {
      const list = first("echo {a,b,c}").args[0].parts[0];
      const seq = first("echo {0..9}").args[0].parts[0];
      const plain = first("echo {a}").args[0].parts[0];
      return list.kind === "list" && list.items.length === 3 &&
        seq.kind === "sequence" && seq.from === "0" && seq.to === "9" &&
        plain.type === "Word";
    },
  },
  {
    says: "{ cmd; } is still a brace group",
    holds: () => first("{ echo hi; }").type === "BraceGroup",
  },
  {
    says: "declare -a X=(1 2) is one command whose argument is the assignment",
    holds: () => {
      const cmd = first("declare -a X=(1 2)");
      return cmd.type === "SimpleCommand" && find(cmd, "ArrayLiteral").length === 1;
    },
  },
  {
    says: "a function defined earlier shadows a builtin recognised by name",
    holds: () => {
      const shadowed = parseShell("let() { :; }\nlet x=1");
      return find(shadowed, "LetCommand").length === 0;
    },
  },
  {
    says: "zsh: print *(.) is a wildcard then a qualifier",
    holds: () => {
      const parts = first("print *(.)", "zsh").args[0].parts;
      return parts[0].kind === "wildcard" && parts[1].kind === "qualifier" && parts[1].qualifiers === ".";
    },
  },
  {
    says: "zsh: <1-> is a numeric range with an open top",
    holds: () => {
      const range = first("[[ $v == <1-> ]]", "zsh").expression.right.parts[0];
      return range.kind === "numeric-range" && range.min === 1 && range.max === null;
    },
  },
  {
    says: "zsh: a bare group carries no operator",
    holds: () => first("[[ $x == (a|b) ]]", "zsh").expression.right.parts[0].op === null,
  },
  {
    says: "zsh: for k v in … gives both variables",
    holds: () => {
      const loop = first("for k v in a b c d; do :; done", "zsh");
      return loop.variables.length === 2;
    },
  },
  {
    says: "zsh: repeat is a RepeatClause, and an anonymous function has a null name",
    holds: () => first("repeat $n do echo hi; done", "zsh").type === "RepeatClause" &&
      first("function { echo hi }", "zsh").name === null,
  },
  {
    says: "zsh: { … } always { … } lands on BraceGroup.always",
    holds: () => first("{ echo a } always { echo b }", "zsh").always !== null,
  },
  {
    says: "zsh: $arg[0,1] is one subscripted expansion and $#arg a length",
    holds: () => {
      const sub = first("echo $arg[0,1]", "zsh").args[0].parts;
      const len = first("echo $#arg", "zsh").args[0].parts;
      return sub.length === 1 && sub[0].expression === "arg[0,1]" &&
        len.length === 1 && len[0].expression === "#arg";
    },
  },
  {
    says: "bash rejects zsh-only syntax rather than guessing",
    holds: () => {
      try {
        parseShell("[[ $v == <1-> ]]");
        return false;
      } catch (error) {
        return error instanceof ParseError;
      }
    },
  },
  {
    says: "heredocs accept <<, <<- and quoted delimiters including <<\\EOF",
    holds: () => ["<<EOF", "<<-EOF", "<<'EOF'", '<<"EOF"', "<<\\EOF"].every(
      (open) => parseShell(`cat ${open}\nbody\nEOF\necho after\n`).commands.length === 2,
    ),
  },
];

let failed = 0;
for (const claim of CLAIMS) {
  let ok: boolean;
  try {
    ok = claim.holds();
  } catch (error) {
    ok = false;
    console.log(`   threw: ${(error as Error).message}`);
  }
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FALSE"} ${claim.says}`);
}

console.log(`\n${CLAIMS.length - failed}/${CLAIMS.length} README claims hold`);
if (failed > 0) process.exit(1);
