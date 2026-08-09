# shell-ast-parser

A tokenizer and parser that turns bash/sh source into a typed AST. Every node
carries a source range, and quoting is preserved — so the tree tells you not
just what the script says, but where it says it and whether the shell would
expand it.

Written for static analysis: linting shell scripts, finding commands, auditing
what a script actually runs.

## Install

```bash
bun install
```

## Usage

```ts
import { parseShell } from "shell-ast-parser";

const script = parseShell('cat "$f" > out.txt');
```

You get a `Script` whose `commands` are `Pipeline`s wrapping the actual
commands:

```jsonc
{
  "type": "Script",
  "commands": [{
    "type": "Pipeline",
    "negated": false,
    "background": false,
    "commands": [{
      "type": "SimpleCommand",
      "name":  { "type": "CompoundWord", "parts": [ /* Word "cat" */ ] },
      "args":  [ { "parts": [ { "type": "VariableExpansion",
                                "expression": "f",
                                "quoted": "double",
                                "range": { "start": 5, "end": 7 } } ] } ],
      "redirects": [ { "type": "Redirect", "op": ">", "fd": null, /* … */ } ]
    }]
  }]
}
```

Tokenizing and parsing separately:

```ts
import { tokenize, parse, ParseError } from "shell-ast-parser";

try {
  const ast = parse(tokenize(source));
} catch (err) {
  if (err instanceof ParseError) {
    console.error(err.message);  // includes the offending token's position
    console.error(err.token);
  }
}
```

## What the AST guarantees

**Ranges index the original source.** `src.slice(node.range.start, node.range.end)`
returns that node's text — at any depth, including inside a command
substitution and inside an assignment's value.

```ts
const src = "echo $(date +%F)";
const sub = /* the CommandSubstitution part */;
src.slice(sub.body.range.start, sub.body.range.end);  // "date +%F"
```

**Quoting is recorded, not discarded.** Word parts carry
`quoted: "single" | "double" | null`, and quote characters are stripped from
`value`. This is what separates a live expansion from inert text:

```ts
parseShell("echo '$(rm -rf /)'");  // one Word, value "$(rm -rf /)", quoted "single"
parseShell('echo "$(rm -rf /)"');  // a CommandSubstitution, quoted "double"
```

**Substitution bodies are parsed, not captured.** `CommandSubstitution.body` and
`ProcessSubstitution.body` are real `Script` nodes, nested to any depth.

**Escapes are resolved.** `Word.value` holds the literal text the shell would
use: `"\$HOME"` yields `$HOME`, and `$'a\tb'` yields a real tab.

**Arithmetic is a tree.** `$(( … ))`, `(( … ))` and C-style `for` headers parse
into expression nodes with real precedence, so `$((1+2*3))` nests the
multiplication. `expression` keeps the raw text alongside; `parsed` is null when
the text does not fit the grammar.

```ts
parseShell("echo $((1+2*3))");   // ArithmeticBinary + { left: 1, right: (2 * 3) }
```

## Supported

Simple commands, pipelines (`|`, `!`), lists (`&&`, `||`, `;`), background (`&`),
redirections (`>`, `>>`, `<`, `>&`, `<&`, `>|`, `<>`, `<<<`) and heredocs
(`<<`, `<<-`, quoted delimiters, several per command), `if`/`elif`/`else`,
`for` (both word-list and C-style), `while`, `until`, `case`, `(( … ))`,
subshells, brace groups, functions (both forms), `coproc`, `[[ … ]]`, comments.

Words resolve into parts: literals, variable expansions (`$x`, `${x:-d}`),
command substitutions (`$( )` and backticks), arithmetic (`$(( ))`), process
substitutions (`<( )`, `>( )`), and glob patterns — `*`, `?`, `[…]` bracket
expressions, and extended globs `?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)`.
Quoting and escaping defeat globbing, as in the shell. At the start of a
command `!` stays the negation keyword, so `!(cmd)` negates a subshell.

Assignments cover scalars, arrays (`X=(a b)`), appends (`X+=y`), subscripts
(`X[i]=y`), and declaration builtins, where the assignment is an argument:
`declare -a X=(1 2)` is one command.

## Known limitations

- **`GlobPattern` is syntactic, and kept whole.** It marks unquoted
  metacharacters; it does not tell you whether anything matches. The value is
  the pattern text, so the alternatives of `@(a|b)` and the members of `[abc]`
  are not separate nodes — and an expansion inside one, as in `@($x|b)`, is
  part of that text rather than a `VariableExpansion`.
- **`case` patterns and `[[ … ]]` contents** are kept as words rather than
  being modelled as test expressions.
- **`let` is not special-cased.** `let "i = 1"` keeps its argument as an
  ordinary word rather than parsing it as arithmetic.

## Development

```bash
bun test
```

```bash
bunx tsc --noEmit
```

Both run in CI on every push and pull request.
