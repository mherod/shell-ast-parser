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

Reading zsh takes a dialect. It defaults to `"bash"`, which also covers sh:

```ts
parseShell(source, { dialect: "zsh" });
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

Braces expand. `{a,b,c}` is a `BraceExpansion` of `kind: "list"` whose `items`
are words, and `{0..9}` one of `kind: "sequence"` keeping `from`, `to` and an
optional `step` as written. Unlike a glob it consults nothing — the shell writes
out one copy of the word per item either way. Braces that cannot expand stay
literal, so `{a}` and the `{}` of `find -exec` are ordinary text, and `{ cmd; }`
is still a brace group: what separates them is the space the shell insists on.

Assignments cover scalars, arrays (`X=(a b)`), appends (`X+=y`), subscripts
(`X[i]=y`), and declaration builtins, where the assignment is an argument:
`declare -a X=(1 2)` is one command.

Builtins recognised by name — `declare`, `export`, `local`, `readonly`,
`typeset`, `let`, `[`, `test` — give way to a function of the same name defined
earlier in the script, matching the shell: a call above the definition still
uses the builtin, because the definition has not run yet.

## The zsh dialect

`{ dialect: "zsh" }` adds what zsh has and bash does not. It is opt-in because
the two disagree: bash rejects every construct below, and reading a bash script
as zsh would accept syntax bash would refuse to run.

**Globs gain qualifiers and ranges.** A `(…)` that closes a pattern selects
among what it matched rather than matching text, and is kept as written —
deciding what it selects needs a filesystem. `<1->` is a number.

```ts
parseShell("print *(.)", { dialect: "zsh" });     // wildcard, then qualifier "."
parseShell("[[ $v == <1-> ]]", { dialect: "zsh" }); // numeric-range, min 1, max null
```

What tells a qualifier from a pattern group is what precedes it: `(a|b)` alone
is a group, while the one in `bin(N)` closes a word. A bare group is what bash
writes `@(a|b)`, so its `op` is null.

**Loops take more shapes.** The word list may be parenthesised, the body may be
a single command with no `do`/`done`, and several variables share the list:

```ts
parseShell('for x (a b) echo $x', { dialect: "zsh" });
parseShell("for k v in a b c d; do :; done", { dialect: "zsh" });  // variables: ["k","v"]
parseShell("repeat $n do echo hi; done", { dialect: "zsh" });      // RepeatClause
```

`ForClause.variables` is always an array; bash simply never has more than one.

**Functions may be anonymous.** `function { … }` binds no name and runs at once,
so `name` is null and any trailing words become `args`.

**Expansions may drop their braces.** `$arg[0,1]` is a subscripted expansion
rather than an expansion followed by a glob bracket, and `$#arg` is a length.

**Blocks and conditions take other shapes.** `if cond { … }` needs no `then` or
`fi`, `{ … } always { … }` runs the second group either way and lands on
`BraceGroup.always`, and a case item may end with `;|` where bash writes `;;&`.
A case pattern may hold a group or an unquoted space — `(*# SKIP*)` is one
pattern — and `<->` is a numeric range wherever a pattern may appear.

## Known limitations

- **`GlobPattern` is syntactic.** It marks unquoted metacharacters and
  decomposes them; it does not tell you whether anything matches.
- **Shadowing is tracked by source order, not reachability.** A function
  defined inside a subshell or an untaken branch still counts as shadowing from
  that point on; separating those needs scope and flow analysis.
- **Portability is described, not judged.** GNU-only regex constructs get their
  own node types, but nothing decides whether your libc supports them.
- **zsh is covered by what has been run through it.** Every file of a prezto
  install parses — 381 files and about 2 MB, including powerlevel10k's engine
  and zsh-syntax-highlighting — but zsh is large, and what no corpus exercised
  is untested rather than known to work. Anything unsupported raises a
  `ParseError` naming the position rather than parsing to something plausible.

## Development

```bash
bun test
```

```bash
bunx tsc --noEmit
```

Both run in CI on every push and pull request.
