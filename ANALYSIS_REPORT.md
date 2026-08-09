# Shell AST Parser — Analysis Findings (verified)

Every claim below was checked against the source and by running the code. The
previous revision of this file was written without executing the test suite; its
findings are re-adjudicated at the bottom.

**Headline:** the parser hung — `bun test` never terminated. Four tests spun
forever in `parseCompoundList`. That was not in the original report, which
concluded the parser was "fundamentally sound".

Status: all findings below are fixed. `bun test` → 70 pass / 0 fail. `tsc --noEmit` → clean.

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

## Not fixed (noted, out of scope)

- **Array assignments.** `ITEMS=(one two three)` parses as an assignment followed
  by a subshell, not an array literal. No hang, but the AST is wrong. Needs an
  `ArrayAssignment` node.
- **Background `&`.** `parseCompoundList` consumes `&` and discards it; there is
  a `// For simplicity` comment where the flag would go. The AST has no
  `background` field to record it.
- **Command substitution bodies.** `CommandSubstitution.body` is always an empty
  `Script` — the inner text is parsed off and thrown away (`src/parser.ts:769`).

## Regression coverage added

`src/parser.test.ts`: heredoc content attachment, two-heredoc ordering, quoted
and `<<-` delimiters, `function name { }`, `coproc NAME { }`, `[[ ]]` redirects,
and a `termination` block asserting that eight previously-hanging inputs return.
