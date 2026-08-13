/**
 * Compares this parser against the real shells on a set of snippets.
 *
 *   bun scripts/debug-shell-oracle.ts
 *
 * The question a failing snippet raises is always the same: is this a gap in
 * the parser, or syntax the parser deliberately does not target? `bash -n` and
 * `zsh -n` answer it. A snippet bash accepts and we reject is a real gap; one
 * only zsh accepts is out of scope, and should be recorded as such rather than
 * chased.
 */
import { runCaseTable, type CaseSnippet } from "./harness.ts";

const SNIPPETS: CaseSnippet[] = [
  {
    name: "multiline [[ ]] with && on next line",
    source: "if [[ -n $A\n      && -z $B ]]; then\n  echo yes\nfi\n",
  },
  {
    name: "multiline [[ ]] with comment inside",
    source: "if [[ -n $A\n      # why\n      && -z $B\n    ]]; then\n  echo yes\nfi\n",
  },
  {
    name: "multiline [[ ]] closing on its own line",
    source: "if [[ -n $A\n      && -z $B\n    ]]; then\n  echo yes\nfi\n",
  },
  {
    name: "zsh numeric glob range <1->",
    source: "[[ $ZSH_VERSION == (5.<1->*|<6->.*) ]] && echo old\n",
  },
  {
    name: "zsh bare glob alternation (a|b)",
    source: "[[ $x == (a|b) ]] && echo hit\n",
  },
  {
    name: "zsh parameter expansion flag ${(V)x}",
    source: 'local tag=${(V)VCS_STATUS_TAG}\n',
  },
  {
    name: "zsh subscript slice x[13,-13]",
    source: 'branch[13,-13]="…"\n',
  },
  {
    name: "multiline (( )) arithmetic",
    source: "if (( 1 +\n      2 )); then\n  echo yes\nfi\n",
  },
  {
    name: "multiline [[ ]] with || on next line",
    source: "[[ -n $A\n   || -n $B ]] && echo yes\n",
  },
  {
    name: "[[ ]] with leading newline after [[",
    source: "[[\n  -n $A\n]] && echo yes\n",
  },

  // Requiring the closing `]]` could plausibly break legitimate conditions that
  // contain parens or brackets of their own, so cover the ordinary forms too
  { name: "grouping parens", source: "[[ ( -n $A || -n $B ) && -n $C ]] && echo yes\n" },
  { name: "nested grouping parens", source: "[[ ( ( -n $A ) ) ]] && echo yes\n" },
  { name: "negated group", source: "[[ ! ( -n $A ) ]] && echo yes\n" },
  { name: "glob with bracket class", source: "[[ $f == [a-z]* ]] && echo yes\n" },
  { name: "extglob group", source: "[[ $f == @(a|b) ]] && echo yes\n" },
  { name: "regex with group", source: "[[ $s =~ ^(a|b)+$ ]] && echo yes\n" },
  { name: "string compare", source: '[[ "$a" == "$b" ]] && echo yes\n' },
  { name: "arithmetic compare", source: "[[ $a -gt 3 ]] && echo yes\n" },
  { name: "file tests joined", source: "[[ -f $f && -r $f ]] && echo yes\n" },
  { name: "condition then redirect", source: "[[ -n $A ]] > /dev/null\n" },
  { name: "nested [[ in subshell", source: "( [[ -n $A ]] ) && echo yes\n" },
  { name: "[[ inside while", source: "while [[ -n $A ]]; do\n  break\ndone\n" },
  { name: "[[ ]] on one line with ;", source: "[[ -n $A ]]; echo after\n" },
  { name: "array subscript in condition", source: "[[ -n ${arr[1]} ]] && echo yes\n" },

  // The four constructs the startup files still fail on, each reduced to its
  // essence. If bash rejects them they are zsh extensions and out of scope; if
  // bash accepts any, it is a gap worth closing.
  { name: "zsh anonymous function", source: "function {\n  echo hi\n}\n" },
  { name: "zsh short for-loop", source: 'for x ("$arr[@]") echo $x\n' },
  { name: "zsh glob qualifier in array", source: "X=(dir/*(-/FN) $X)\n" },
  { name: "zsh glob qualifier (N) in array", source: "X=($HOME/bin(N) $X)\n" },
];

await runCaseTable(SNIPPETS);
