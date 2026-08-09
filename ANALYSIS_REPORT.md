# Shell AST Parser — Analysis Findings (verified)

Every claim below was checked against the source and by running the code. The
previous revision of this file was written without executing the test suite; its
findings are re-adjudicated at the bottom.

**Headline:** the parser hung — `bun test` never terminated. Four tests spun
forever in `parseCompoundList`. That was not in the original report, which
concluded the parser was "fundamentally sound".

Findings 1–5 are defects the parser had, 6–10 are constructs it silently dropped
on the floor, and 11–26 are places where the AST asserted things about the
source that were not true.

Status: all findings below are fixed. `bun test` → 269 pass / 0 fail. `tsc --noEmit` → clean.

---

## Confirmed and fixed

### 1. Infinite loop on any token no rule can consume — CRITICAL
**File:** `src/parser.ts`, `parseCompoundList` / `parseSimpleCommandOrFunctionDef`

`parseSimpleCommandOrFunctionDef` returns an empty `SimpleCommand` without
consuming a token when the current token is not a Word, Assignment or Redirect.
`parseCompoundList` loops while the token is neither EOF nor a terminator, so
the parser spins forever on that token.

Reproduced by four cases in the existing suite — `function keyword`, `heredoc`,
`fixture: sample.sh` (×2, matched via `-t "comments are collected"`). `bun test`
had to be killed.

**Fix:** `parseCompoundList` records `this.pos` before each iteration and throws
`ParseError("Unexpected token")` if nothing was consumed. A malformed input now
produces a located error instead of a hang. 23 malformed inputs were checked —
none hang, all either parse or throw `ParseError`.

### 2. Heredoc bodies were never attached — HIGH
**File:** `src/parser.ts`, `parseSimpleCommandOrFunctionDef`

The tokenizer emits `HereDocBody` *after* the `Newline` that ends the command:

```
Word(cat) Redirect(<<) Word(EOF) Newline HereDocBody("hello world\n")
```

The collection loop ran immediately after argument parsing, where the current
token is still `Newline`, so it never matched. `HereDoc.content` stayed `""` for
every heredoc, and the unconsumed body token then triggered finding 1.

Two heredocs on one command were also mis-assigned: `findLast` picked the same
(last) redirect for every body, so `cmd <<A <<B` put both bodies in `B`.

**Fix:** heredoc targets are queued in `parseRedirect` in declaration order and
bodies are drained through `consumeHereDocBody()` from the newline-skipping
helpers, mirroring the tokenizer. `cmd <<A <<B` now yields `["first\n", "second\n"]`.

### 3. `{` after a name was mis-dispatched — HIGH
**Files:** `src/parser.ts`, `parseCommand` / `parseBraceGroup` / `parseCoproc`

`{` only tokenizes as a `Keyword` at command start. After `function cleanup` or
`coproc WORKER` the tokenizer is not at command start, so it emits `Operator("{")`.
`parseCommand` matched only the `Keyword` form, so `function cleanup { ... }`
fell through to finding 1 and hung. `parseCoproc`'s name detection had the same
type-based check and never recognised a named coproc.

**Fix:** dispatch on token *value* for `{`, accept either type in
`parseBraceGroup`, and match by value in `parseCoproc`. `isListTerminator` also
now treats a closing `Operator("}")` as a terminator.

### 4. `[[ ... ]]` dropped trailing redirects — MEDIUM
**File:** `src/parser.ts`, `parseDoubleSquareBracket`

Confirmed as originally reported: the returned `SimpleCommand` hard-coded
`redirects: []`, so `[[ -f x ]] > out.txt` silently lost the redirect.

**Fix:** call `parseTrailingRedirects()`, as every other compound parser does.

### 5. `HereDoc.quoted` was always false — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`

The tokenizer knew whether the delimiter was quoted but stripped the quotes
before emitting the Word token; the parser hard-coded `quoted: false` with the
comment "tokenizer handles this". Neither did. `<<'EOF'` (no expansion) was
indistinguishable from `<<EOF` (expansion) in the AST.

**Fix:** the tokenizer emits the delimiter as written; the parser strips the
quotes and sets `quoted` accordingly.

### 6. Array assignments were not represented — MEDIUM
**Files:** `src/ast.ts`, `src/parser.ts`, `parseAssignment`

`ITEMS=(one two three)` produced an empty assignment followed by a `Subshell`
containing the command `one two three`. The elements were structurally
indistinguishable from a command invocation.

**Fix:** new `ArrayLiteral` node; `Assignment.value` is now
`CompoundWord | ArrayLiteral | null`, discriminated on `value.type`. Elements
may span lines and contain expansions. `VAR= (cmd)` — with a space — is still an
empty assignment plus a subshell, which is what bash does; the two are told
apart by checking that the paren is adjacent to the `=`.

### 7. Background `&` was discarded — MEDIUM
**Files:** `src/ast.ts`, `src/parser.ts`, `parseCompoundList`

`parseCompoundList` consumed `&` and dropped it, under a `// For simplicity`
comment. `sleep 10 &` and `sleep 10` produced identical ASTs.

**Fix:** `background: boolean` on `Pipeline` and `List` — the two node types a
`&` can terminate. The command's range now extends to cover the `&`.

### 8. Command substitution bodies were thrown away — MEDIUM
**File:** `src/parser.ts`, `parseWordParts`

`CommandSubstitution.body` was hard-coded to an empty `Script`. The inner text
was scanned to find the closing delimiter, then discarded — so `$(date +%s)` and
`$(rm -rf /)` were indistinguishable in the AST.

**Fix:** the captured text is tokenized and parsed recursively. Inner ranges are
shifted onto the absolute source offset, so `src.slice(node.range.start,
node.range.end)` returns the right text at any depth. Backtick bodies are
unescaped (`\``, `\$`, `\\`) before parsing. Verified to 150 levels of nesting.

One behaviour change: a syntax error inside a substitution now throws
`ParseError` instead of silently yielding an empty body. `echo $(if` is a syntax
error in bash too.

### 9. Process substitution was never represented — MEDIUM
**File:** `src/parser.ts`, `parseWordParts`

`ProcessSubstitution` existed in `ast.ts` but nothing produced it. The tokenizer
folds `<(ls /tmp)` into the surrounding word, and `parseWordParts` had no branch
for it, so it survived as one literal `Word` part.

**Fix:** `<(` and `>(` now produce a `ProcessSubstitution` with `direction` and a
recursively parsed body, using the same absolute-range shifting as finding 8.
Adjacent literals are preserved (`pre<(ls)post` → Word, ProcessSubstitution,
Word). The paren-matching loop, by then written three times, was extracted to
`readParenBody`.

### 10. `+=` assignments tokenized as words — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`, `src/ast.ts`

`ITEMS+=(x)` produced `Word("ITEMS+=")` because the assignment-name pattern
rejected the trailing `+`. Appends were invisible to consumers.

**Fix:** the name pattern accepts one trailing `+`, and `Assignment` carries
`append: boolean` with the `+` stripped from `name`. Works for scalars, arrays
and the bare `VAR+=` form. `a+b=c` and `+=x` remain words — neither is a valid
assignment name.

### 11. The word scanner was quote-blind — HIGH
**Files:** `src/parser.ts` (`parseWordParts`), `src/ast.ts`

`parseWordParts` scanned for `$`, backticks and `<(` with no idea whether it was
inside quotes, so it reported expansions the shell would never perform:

```
echo '$(rm -rf /)'   → CommandSubstitution running `rm -rf /`
echo '$NAME'         → VariableExpansion
```

For a static-analysis consumer this is the worst kind of wrong: inert text
reported as a live command. The quote characters were also left in the adjacent
`Word` values (`Word("'")`, `Word("'")`) rather than stripped, so nothing
downstream could correct for it.

Escapes were not handled either — `"\$NOT_EXPANDED"` in the fixture was read as
a real expansion of `$NOT_EXPANDED`.

**Fix:** the scanner now tracks quote state.

- Single quotes: everything is literal, including backslashes.
- Double quotes: `$` and backtick expand; `<(` does not; the five escapable
  characters (`$`, `` ` ``, `"`, `\`, newline) are resolved and any other
  backslash stays literal.
- Unquoted: `\c` yields a literal `c`, and `\<newline>` is a line continuation.
- `$'…'` resolves ANSI-C escapes (`\n`, `\t`, `\xHH`, octal, `\uHHHH`); `$"…"`
  behaves as double quotes.

Quote characters are stripped from values, and the quoting is preserved instead
on a new `quoted: QuoteContext` field (`"single" | "double" | null`) on each
part — quoting drives word splitting and globbing, so discarding it would lose
information consumers need. A word's segments are reported separately:
`a"b"'c'd` → four `Word` parts, each with its own context.

### 12. Word part ranges were the whole token — MEDIUM
**File:** `src/parser.ts`, `parseWordParts`

Every part carried the enclosing token's range, marked `// approximate` in the
source. Rewriting the scanner made real ranges nearly free, so parts now index
their own source text: for `echo pre$NAME"post $X"` the four parts slice back to
`pre`, `$NAME`, `post `, `$X`.

This also fixes a bug introduced by finding 8: `parseWordParts` received the
token range even when parsing an assignment's *value*, which starts after the
`=`. Substitution bodies inside `TODAY=$(date +%F)` were offset by the width of
`TODAY=`. The base offset is now passed explicitly.

### 13. Delimiter scanning ignored quotes, cutting tokens short — HIGH
**Files:** `src/tokenizer.ts` (`readDollar`, `readParenGroup`, `readWord`),
`src/parser.ts` (`parseWordParts`)

Finding 11 fixed *what counts as an expansion*; this is *where an expansion
ends*. Every delimiter scanner counted brackets without regard for quotes, so a
delimiter inside a string closed the region early:

```
echo $(grep ")" f)     → substitution ended at the quoted ), leaving `" f)` as words
echo ${x:-"}"}         → expansion ended at the quoted }
diff <(grep ")" a)     → same, for process substitution
```

Both layers had it: the tokenizer decided the token boundary, and
`parseWordParts` re-scanned the same text with the same flaw, so fixing one
without the other would have changed nothing observable.

Nesting inside double quotes was broken separately: `readWord` scanned a
double-quoted span character by character, so `"$(grep ")" f)"` ended at the
quote *inside* the substitution.

**Fix:** a shared quote-aware scanner in each layer — `readBalanced` in the
tokenizer, `readDelimited` in the parser — that skips quoted spans whole and
honours backslash escapes. `readWord` now hands `$(`, `${` and backticks inside
a double-quoted span to the readers that understand nesting.

This also fixed a bug in `$(( … ))`, which paired the literal strings `((` and
`))`: `$((a+(b*c)))` stopped at the first `))`, capturing `a+(b*c` and spilling
a stray `)` into the token stream as an operator. Counting single parens from a
starting depth of 2 handles it, and the arithmetic text now comes out as
`a+(b*c)`.

### 14. `#` split words that contained it — MEDIUM
**File:** `src/tokenizer.ts`, `isWordChar`

`#` was excluded from word characters unconditionally, so `echo a#b` tokenized
identically to `echo a #b` — one argument became an argument plus a comment.
`url=http://x#frag` lost everything from the `#`.

**Fix:** `#` is an ordinary word character. `tokenize` already handles a
word-initial `#` before `readWord` is reached, which is the only place a comment
can start.

### 15. Comments were invisible to the substitution scanners — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`

Finding 13 taught the delimiter scanners about quotes; they still knew nothing
about comments, so `$(echo hi # )` ended at the `)` inside the comment.

**Fix:** a `comments` flag on both scanners, enabled for `$( )` and `<( )`,
which hold shell code. It stays off for `${ }`, where `#` is the length and
prefix-strip operator, and for arithmetic — `${#NAME}`, `${NAME#pre}` and
`$((a#b))` are unchanged.

### 16. Subscripted assignments were words — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`, `src/ast.ts`

`ITEMS[0]=x` failed the assignment-name pattern and fell through to `Word`.

**Fix:** the pattern accepts `NAME[subscript]` with an optional trailing `+`,
and `Assignment` carries `subscript: CompoundWord | null`. The subscript is a
word in its own right, so `ITEMS[$i]=x` records a `VariableExpansion`.

### 17. Declaration builtins produced a phantom command — HIGH
**Files:** `src/tokenizer.ts`, `src/parser.ts`, `src/ast.ts`

`declare -a X=(1 2)` parsed as a `SimpleCommand` **plus a `Subshell` running the
command `1 2`** — one source command became two AST commands, one of which does
not exist. Same class of error as the quote-blindness: the tree asserts a
command that the shell never runs.

The cause was in the tokenizer: assignments are only recognised at command
start, so `X=` after `declare -a` was a plain word, leaving `(1 2)` to be read
as a subshell.

**Fix:** the tokenizer tracks a declaration context for `declare`, `typeset`,
`local`, `export` and `readonly`, in which assignment-shaped words are
assignments. `SimpleCommand.args` widens to `(CompoundWord | Assignment)[]`,
discriminated on `arg.type` — for these builtins the assignment *is* the
argument, unlike a prefix assignment such as `FOO=bar cmd`.

A `(` glued to an assignment opens an array literal rather than a subshell, so
it no longer ends the declaration context: `declare -a X=(1 2) Y=(3)` keeps
recognising `Y`.

### 18. `GlobPattern` had no producer — MEDIUM
**File:** `src/parser.ts`, `parseWordParts`

The type existed but nothing emitted it; glob characters stayed inside `Word`
values, so nothing could tell `*.ts` from a file literally named `*.ts`.

**Fix:** unquoted `*`, `?` and `[…]` bracket expressions become `GlobPattern`
parts. This depends on finding 11 — quoting is what separates a glob from a
literal, so `"*.ts"`, `'*'` and `\*` all stay `Word`s. Bracket expressions
handle `!`/`^` negation and a leading `]` as a literal member; an unclosed `[`
is a literal. `[[` is unaffected, having no closing bracket.

### 19. Heredoc bodies were scanned as if they were code — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`

The delimiter scanners knew about quotes (13) and comments (15) but not
heredocs, so a body opened inside `$( … )` was scanned as shell syntax:

```
x=$(cat <<EOF
a ) b
EOF
)
```

The `)` on the body line closed the substitution, leaving `b`, `EOF` and `)` as
stray tokens. An unbalanced quote in a body did the same thing less visibly —
`its " odd` opened a quote span that swallowed the rest of the file, and the
region only *looked* right because everything landed in one token.

The root cause is that a heredoc body is raw text: no quote, comment or
delimiter rule applies inside it, so a scanner has to step over it wholesale.

**Fix:** two exported helpers, `readHereDocHeader` and `skipHereDocBodies`,
shared by both scanners. Operators are queued as they are seen and the bodies
are skipped at the newline that ends the line, mirroring how the tokenizer
already handles top-level heredocs. Handles `<<-`, quoted delimiters, and
several heredocs on one command.

Gating this on the shell-code flag is what keeps `<<` an operator elsewhere:
`$((1<<2))` and `${a<<b}` are unaffected, since neither region holds shell code.

### 20. Extended globs produced a phantom subshell — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`

`?(a|b)`, `*(…)`, `+(…)`, `@(…)` and `!(…)` were not recognised. The lead
character ended the word and the parenthesised list became a subshell, so
`echo ?(a|b)` parsed as two commands and `echo @(x|y).txt` as three — the same
phantom-command shape as finding 17. In a `case` pattern it was worse:
`case x in @(a|b)) … esac` threw a `ParseError`.

**Fix:** `readWord` consumes the group into the word, and `parseWordParts`
emits one `GlobPattern` spanning it. Groups nest (`@(a|@(b|c))`) and may
contain other glob syntax (`!(*.o|*.a)`). Quoting and escaping defeat it, as
with any other glob.

`!` is the exception: at the start of a command it stays the pipeline negation
keyword, so `!(cmd)` still parses as a negated subshell. Only in an argument
position is `!(…)` a pattern.

The group is kept whole rather than split into alternatives, matching how
`[abc]` is already handled — so an expansion inside one, as in `@($x|b)`, is
part of the pattern text rather than a `VariableExpansion` node.

One input remains odd: `echo \?(a)` yields a literal `?` followed by a
subshell. The escape correctly suppresses the glob; the trailing `(a)` is a
syntax error in bash, so there is no correct tree to produce.

### 21. Arithmetic was raw text, and its two command forms were broken — HIGH
**Files:** `src/arithmetic.ts` (new), `src/tokenizer.ts`, `src/parser.ts`, `src/ast.ts`

`ArithmeticExpansion.expression` was a string, so nothing downstream could see
operators or precedence. The two commands that carry arithmetic were worse than
unparsed:

- `(( i++ ))` produced two nested `Subshell`s. In `(( i < 10 ))` the `<` was
  lexed as a **redirection** — the tree claimed a file redirect that does not
  exist.
- `for ((i=0;i<3;i++))` threw a `ParseError` outright.

**Fix:** a precedence-climbing parser in `src/arithmetic.ts` covering bash's
operator set — assignment, ternary, the logical, bitwise, equality, relational
and shift families, `+ - * / %`, `**`, unary `+ - ! ~`, prefix and postfix
`++`/`--`, array subscripts, and the comma operator. `**` is the only
right-associative binary operator; assignment and `?:` associate right too.
Numbers decode from decimal, `0x` hex, leading-zero octal and `base#digits`.

`ArithmeticExpansion` gains `parsed`, and two nodes are new: `ArithmeticCommand`
for `(( … ))` and `ArithmeticForClause` for the C-style loop, whose three
clauses split on top-level `;`.

Operands that are expansions stay real nodes: `$(( $(f) + 1 ))` holds a
`CommandSubstitution` with its own parsed body, not a string.

Two decisions worth recording:

- **`((` is trial-parsed before being claimed.** `((cd /tmp) && ls)` is a
  legitimate pair of nested subshells, so the text is parsed as arithmetic
  first and only taken if it fits — the same disambiguation bash performs.
  A `for` header additionally allows its `;`-separated clauses.
- **Unparseable arithmetic yields `parsed: null`, not an error.** `expression`
  always holds the raw text, so nothing is lost, and an unmodelled corner of
  bash arithmetic cannot fail the surrounding script. This differs from the
  substitution-body decision in finding 8, where the text was otherwise
  discarded entirely and silence would have hidden it.

### 22. `let` arguments were unparsed words — LOW
**Files:** `src/ast.ts`, `src/parser.ts`

`let "i = 1"` is the builtin spelling of `(( i = 1 ))`, but its argument stayed
an ordinary word while the `(( … ))` form parsed into a tree.

**Fix:** a `LetCommand` node whose `expressions` each carry the argument text
and its parsed arithmetic. Wrapping quotes are stripped first, so `let "i = 1"`
and `let i=1` agree, and the offset is tracked so inner ranges still point at
the source. Prefix assignments and redirects are kept, as on any command.

`let` gets its own node rather than being an enriched `SimpleCommand` — unlike
the declaration builtins in finding 17, every argument is an expression and
none is a flag, which makes it the same kind of thing as `ArithmeticCommand`.

Only the command name is treated this way: `echo let` keeps `let` as a word,
and `let() { … }` is still a function definition. A user-defined function named
`let` would shadow the builtin, which this does not track — the same caveat as
finding 17.

### 23. `[[ … ]]` was a flat word list, and `<` in it was a redirect — HIGH
**Files:** `src/ast.ts`, `src/tokenizer.ts`, `src/parser.ts`

`parseDoubleSquareBracket` returned a `SimpleCommand` named `[[` whose args were
every token including the closing `]]`, under a `// Treat [[ ... ]] as a simple
command for now`. Operators, grouping and negation were indistinguishable from
operands.

Worse, `[[ a < b ]]` lexed the `<` as a **redirection**. `<` and `>` compare
strings inside `[[ … ]]`, so the tree claimed a file redirect the source never
wrote — the same class of error as `(( i < 10 ))` in finding 21.

**Fix:** a `TestCommand` node with a real expression tree — `TestUnary`,
`TestBinary`, `TestLogical`, `TestNegation` and `TestValue` for a bare word.
`||` binds loosest, then `&&`, then `!`, and parentheses group. The tokenizer
tracks `[[ … ]]` and emits `<`/`>` as operators inside it; outside, and after
`]]`, they remain redirections.

Operands stay `CompoundWord`s, so a pattern keeps its parts: the fixture's
`[[ "$NAME" == w* && -n "$NAME" ]]` holds a `GlobPattern` in the right operand
of the `==`.

This changes the shape of an existing node: `[[ … ]]` used to be a
`SimpleCommand`, and the repository's own test asserted that. The test now
asserts the expression instead — modelling the contents was the point.

### 24. `case` fallthrough terminators failed to parse — MEDIUM
**Files:** `src/tokenizer.ts`, `src/parser.ts`, `src/ast.ts`

`readOperator` knew `;;` but not `;&` or `;;&`, so both split into `;` plus `&`
and threw a `ParseError`. Which terminator an item used was also not recorded,
though it decides whether execution falls through.

**Fix:** both operators are tokenized, and `CaseItem` carries `terminator`
(`";;" | ";&" | ";;&" | null`, null when the final item omits it).

### 25. Glob patterns were flat text — MEDIUM
**Files:** `src/ast.ts`, `src/parser.ts`

`GlobPattern.value` held the pattern as written, so the members of `[a-z0-9]`
and the alternatives of `@(a|b)` were a string to be re-parsed by every
consumer. An expansion inside an alternative — `@($x|b)` — was text rather than
a node, unlike everywhere else in the AST.

**Fix:** `GlobPattern` becomes a union discriminated on `kind`, each variant
keeping `value` as written so existing consumers still work:

- `wildcard` — `*` or `?`
- `bracket` — `negated` plus `members`, each a `GlobChar`, `GlobRange`
  (`a-z`) or `GlobClass` (`[:alpha:]`, `[=a=]`, `[.a.]`)
- `extended` — the `op` and `alternatives`, each a `CompoundWord`

Alternatives being words is what closes the gap noted under finding 21:
`@($x|b)` now holds a `VariableExpansion`, `@(a|$(f))` a parsed
`CommandSubstitution`, and `@(a|@(b|c))` nests.

A bracket bug fell out of writing this: `[[:alpha:]]` was cut at the class's own
`]`, yielding `[[:alpha:]` plus a stray `]`. Bracket sub-expressions now carry
their own terminator.

Two details worth keeping straight, both verified against bash's behaviour: a
`-` without a neighbour is a literal member (`[-a]`, `[a-]`), and `|` inside a
bracket does not split alternatives — but at word level `echo [b|c]` really
does pipe, because the tokenizer splits there exactly as the shell does.

### 26. `[ … ]` and `test` were unstructured argument lists — MEDIUM
**Files:** `src/ast.ts`, `src/parser.ts`

Finding 23 gave `[[ … ]]` an expression tree while `[ -f x ]` stayed a
`SimpleCommand` with `[` as its name and `]` as its last argument. The two
spell the same intent, so a consumer had to handle them two different ways.

**Fix:** both become `TestCommand`, separated by `style` (`"[["`, `"["`,
`"test"`), reusing the same expression nodes.

The grammars genuinely differ, and the parser follows each rather than
pretending they are the same:

- The builtin joins with `-a` and `-o`; `&&` inside `[ … ]` would end the
  command. `TestLogical.op` widened to carry all four verbatim rather than
  normalising, since evaluation differs.
- `[ a < b ]` **redirects** from a file — the opposite of `[[ a < b ]]`, which
  compares. The `[[`-only tokenizer rule from finding 23 is deliberately not
  applied here, so this yields a redirect and a bare-value expression, exactly
  as the shell reads it.
- Grouping parens must be escaped or quoted to reach the builtin, so the
  expression is read from resolved words: `\(` and `'('` both count as a group.

`test` is included because it is the same builtin — omitting it would model
`[ -f x ]` but not `test -f x`. Both are recognised only as a command name;
`echo test` keeps the word and `test() { … }` is still a function definition.

---

## Original findings that did not hold

| # | Claim | Verdict |
|---|---|---|
| 1.1 | `<<<` needs heredoc-body handling | **False.** Here-strings take a word operand, not a body. The tokenizer emits no `HereDocBody` for `<<<` (`src/tokenizer.ts:232`), so `findLast` correctly ignores it. Adding `<<<` would have mis-assigned a later heredoc's body to the here-string. |
| 1.2 | `isListTerminator` misses `;;` | **False.** `;;` was already matched by the `atAny(Operator, ...)` branch on the following line. (`}` as an Operator was a real gap — fixed under finding 3.) |
| 1.4 | `braced: boolean` is redundant | **Not a defect.** It distinguishes `${x}` from `$x`, which the round-trip needs. A style preference, no behaviour change. |
| 2.1 | Lone `$` causes an infinite loop | **False.** The `else` branch does `literal += ch; i++` — it advances. Also cited `src/tokenizer.ts:407`; the code is in `src/parser.ts:797`. |
| 2.2 | Missing `await` on `Bun.spawn()` | **False.** No `Bun.spawn` call exists anywhere in the repo. The finding was inferred from `CLAUDE.md` guidance, not from code. |
| 2.3 | Redundant `else` after `return` | **False.** The cited lines are in `src/parser.ts`, and the branches are `else if` on a loop with `continue`, not `else` after `return`. |
| 2.4 | Unguarded array access | **No defect.** The cited access is immediately optional-chained; a length check guards the enclosing branch. |
| 3.x | Complexity / naming / validation smells | **Subjective.** Left alone — no behavioural impact, and `parseIf` mirrors the grammar it parses. |

Line references in the original were unreliable: several pointed at `tokenizer.ts`
for code that lives in `parser.ts`.

---

## Known gaps

- **Builtin shadowing is not tracked.** `declare`, `export`, `local`,
  `readonly`, `typeset`, `let`, `[` and `test` are recognised by name; a
  user-defined function of the same name would change what they mean at
  runtime.
- **`=~` regex operands are words, not regex syntax.** `[[ $s =~ ^a.*b$ ]]`
  keeps the right operand as a pattern word; its own grammar is not parsed.

## Regression coverage added

`src/parser.test.ts`, 269 tests total: heredoc content attachment, two-heredoc
ordering, quoted and `<<-` delimiters, `function name { }`, `coproc NAME { }`,
`[[ ]]` redirects, array literals (empty, multi-line, expansion elements,
detached-paren disambiguation, unterminated), background on pipelines and lists
and inside loop bodies, substitution bodies for `$()` and backticks including
nesting and absolute range mapping, process substitution in both directions
including adjacent literals and nesting inside `$()`, `+=` on scalars and arrays
with the non-assignment forms held to `Word`, quoting (expansion suppression in
single quotes, `<(` suppression in double quotes, per-segment quote context,
escapes, `$'…'` and `$"…"`, empty quoted words, unterminated quotes, per-part
and assignment-value ranges), delimiters inside quotes (quoted `)` and `}` in
substitutions, expansions and process substitutions, nesting inside double
quotes, escaped delimiters, arithmetic with nested parens, unterminated
regions), and a `termination` block asserting that eight previously-hanging
inputs return.
