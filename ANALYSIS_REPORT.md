# Shell AST Parser — Analysis Findings (verified)

Every claim below was checked against the source and by running the code. The
previous revision of this file was written without executing the test suite; its
findings are re-adjudicated at the bottom.

**Headline:** the parser hung — `bun test` never terminated. Four tests spun
forever in `parseCompoundList`. That was not in the original report, which
concluded the parser was "fundamentally sound".

Findings 1–5 are defects the parser had; 6–10 are constructs it silently dropped
on the floor.

Status: all findings below are fixed. `bun test` → 100 pass / 0 fail. `tsc --noEmit` → clean.

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

### `parseWordParts` is quote-blind — the biggest remaining correctness issue

Expansions are recognised inside single quotes, where the shell treats them as
literal text:

```
echo '$NAME'      → [Word("'"), VariableExpansion(NAME), Word("'")]
echo '$(rm -rf /)' → [Word("'"), CommandSubstitution(rm -rf /), Word("'")]
```

The second line matters for any consumer doing static analysis: a quoted,
inert string is reported as a command substitution that runs `rm -rf /`. The
quote characters are also kept in the adjacent `Word` values rather than being
stripped, so no consumer can compensate by inspecting them.

This predates the work here — `'$NAME'` behaved this way before any of these
changes — but finding 9 does add one case to it: `"<(x)"` in double quotes is
now read as a process substitution. Fixing it means tracking quote state while
scanning a word, including backslash escapes in double quotes and `$'...'`
ANSI-C quoting. It is a contained change to one function, and it is the next
thing worth doing.

### Smaller

- **Arrays in argument position.** `declare -a X=(1 2)` still splits into a
  command plus a subshell — only *leading* assignments are parsed as arrays.
  Handling it means special-casing the declaration builtins (`declare`, `local`,
  `export`, `typeset`), which is arguably the consumer's job.
- **Subscripted assignment.** `ITEMS[0]=x` tokenizes as a `Word`; the name
  pattern allows no subscript.
- **Quotes inside substitution capture.** The `$( )` scanner counts parens
  without tracking quotes, so `$(grep ")" file)` closes early. Same root cause
  as the quote-blindness above, in the tokenizer rather than the parser.

## Regression coverage added

`src/parser.test.ts`, 100 tests total: heredoc content attachment, two-heredoc
ordering, quoted and `<<-` delimiters, `function name { }`, `coproc NAME { }`,
`[[ ]]` redirects, array literals (empty, multi-line, expansion elements,
detached-paren disambiguation, unterminated), background on pipelines and lists
and inside loop bodies, substitution bodies for `$()` and backticks including
nesting and absolute range mapping, process substitution in both directions
including adjacent literals and nesting inside `$()`, `+=` on scalars and arrays
with the non-assignment forms held to `Word`, and a `termination` block
asserting that eight previously-hanging inputs return.
