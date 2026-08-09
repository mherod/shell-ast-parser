/**
 * Where does a backslash-newline continuation survive, and where does it not?
 *
 *   bun scripts/debug-line-continuation.ts
 *
 * A prezto sweep failed 42 times on lines ending in `\` inside `[[ … ]]`. The
 * newline there is now skipped as whitespace, so the question is whether the
 * continuation was ever handled or whether that change swallowed it — print the
 * tokens and let them say.
 */
import { tokenize } from "../src/tokenizer.ts";
import { parseShell } from "../index.ts";

const CASES: { name: string; source: string }[] = [
  { name: "continuation in [[ ]]", source: '[[ -n $A \\\n   && -n $B ]] && echo hi\n' },
  { name: "continuation in simple command", source: "echo one \\\n  two\n" },
  { name: "continuation in [ ]", source: "[ -n $A \\\n  -a -n $B ]\n" },
  { name: "continuation in if [[ ]]", source: 'if [[ -n $A \\\n  || -n $B ]]; then\n  echo hi\nfi\n' },
  { name: "continuation in for header", source: "for x \\\n  in a b; do\n  echo $x\ndone\n" },
  { name: "continuation in while [[ ]]", source: 'while [[ $P != "/" \\\n  && ! -e $P ]]; do\n  break\ndone\n' },
];

for (const testCase of CASES) {
  console.log(`\n=== ${testCase.name} ===`);
  console.log(`  src: ${JSON.stringify(testCase.source)}`);
  console.log(
    `  tok: ${tokenize(testCase.source)
      .map((token) => `${token.type}:${JSON.stringify(token.value)}`)
      .join(" ")}`,
  );

  for (const dialect of ["bash", "zsh"] as const) {
    try {
      const script = parseShell(testCase.source, { dialect });
      console.log(`  ${dialect}: ${script.commands.length} command(s)`);
    } catch (error) {
      console.log(`  ${dialect}: REJECTED — ${(error as Error).message}`);
    }
  }
}
