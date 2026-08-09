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

**Arithmetic is a tree.** `$(( … ))`, `(( … ))`, `let` arguments and C-style
`for` headers parse into expression nodes with real precedence, so `$((1+2*3))`
nests the multiplication. The raw text is kept alongside; `parsed` is null when
it does not fit the grammar.

```ts
parseShell("echo $((1+2*3))");   // ArithmeticBinary + { left: 1, right: (2 * 3) }
```

## Supported

Simple commands, pipelines (`|`, `!`), lists (`&&`, `||`, `;`), background (`&`),
redirections (`>`, `>>`, `<`, `>&`, `<&`, `>|`, `<>`, `<<<`) and heredocs
(`<<`, `<<-`, quoted delimiters, several per command), `if`/`elif`/`else`,
`for` (both word-list and C-style), `while`, `until`, `case` (including the
`;&` and `;;&` fallthrough terminators), `(( … ))`, subshells, brace groups,
functions (both forms), `coproc`, comments.

Conditionals become expression trees: `[[ … ]]`, `[ … ]` and `test`, told apart
by `style`. Each follows its own grammar — the keyword form joins with `&&` and
`||` and compares with `<` and `>`, while the builtin joins with `-a` and `-o`
and lets `<` redirect, exactly as the shell does.

A `[[ … ]]` condition may span lines, breaking before its operator and carrying
comments between the operands, and parses to the same tree as the single-line
form. Inside it a newline is whitespace; for the `[` builtin, which is an
ordinary command, a newline still ends the command.

```ts
parseShell("[[ -n $A\n   # why\n   && -z $B\n]]");   // one TestCommand
```

The operand of `=~` parses as an extended regular expression, honouring the two
rules that are invisible in the pattern text: a quoted run matches literally,
and an expansion supplies its pattern at runtime.

```ts
parseShell('[[ $s =~ ^(a|b)+$ ]]');   // anchors around a quantified group
parseShell('[[ $s =~ "a.b" ]]');      // a literal, not any-char
```

Words resolve into parts: literals, variable expansions (`$x`, `${x:-d}`),
command substitutions (`$( )` and backticks), arithmetic (`$(( ))`), process
substitutions (`<( )`, `>( )`), and glob patterns.

Globs decompose. A `GlobPattern` is a `wildcard` (`*`, `?`), a `bracket` with
`negated` and `members` — characters, `a-z` ranges and POSIX classes such as
`[:alpha:]` — or an `extended` group (`?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)`)
whose `alternatives` are words, so `@($x|b)` keeps its expansion as a node.
Quoting and escaping defeat globbing, as in the shell. At the start of a
command `!` stays the negation keyword, so `!(cmd)` negates a subshell.

Assignments cover scalars, arrays (`X=(a b)`), appends (`X+=y`), subscripts
(`X[i]=y`), and declaration builtins, where the assignment is an argument:
`declare -a X=(1 2)` is one command.

Builtins recognised by name — `declare`, `export`, `local`, `readonly`,
`typeset`, `let`, `[`, `test` — give way to a function of the same name defined
earlier in the script, matching the shell: a call above the definition still
uses the builtin, because the definition has not run yet.

## Known limitations

- **`GlobPattern` is syntactic.** It marks unquoted metacharacters and
  decomposes them; it does not tell you whether anything matches.
- **Shadowing is tracked by source order, not reachability.** A function
  defined inside a subshell or an untaken branch still counts as shadowing from
  that point on; separating those needs scope and flow analysis.
- **Portability is described, not judged.** GNU-only regex constructs get their
  own node types, but nothing decides whether your libc supports them.
- **zsh extensions are out of scope.** The target is bash/sh. Running the parser
  over real zsh startup files leaves four constructs bash also rejects: glob
  alternation and numeric ranges in a condition (`[[ $v == (a|b) ]]`,
  `<1->`), anonymous functions (`function { … }`), the short for-loop
  (`for x ("$a[@]") cmd`), and glob qualifiers (`dir/*(-/FN)`). Each raises a
  `ParseError` naming the position rather than parsing to something plausible.

## Development

```bash
bun test
```

```bash
bunx tsc --noEmit
```

Both run in CI on every push and pull request.
