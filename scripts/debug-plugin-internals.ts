/**
 * Isolates the first failure from each file the prezto sweep still rejects.
 *
 *   bun scripts/debug-plugin-internals.ts
 *
 * One construct per line, reduced from the file it came from, with bash's and
 * zsh's own verdicts alongside. A construct both shells reject is bad test data
 * rather than a gap, and the ones bash accepts are bugs that were never about
 * zsh at all.
 */
import { parseShell } from "../index.ts";

const CASES: { name: string; source: string }[] = [
  // 10 of the 20 files stop here
  { name: "brace range in for list", source: "for color in {0..255}; do echo $color; done\n" },
  { name: "brace range alone", source: "echo {0..255}\n" },
  { name: "brace list alone", source: "echo {a,b,c}\n" },
  { name: "brace range in while", source: "while true; do echo {1..3}; done\n" },

  // case patterns
  { name: "case pattern (none)", source: "case $x in\n  (none) echo hi ;;\nesac\n" },
  { name: "case pattern (*)", source: "case $x in\n  (*) echo hi ;;\nesac\n" },
  { name: "case pattern with alternation", source: "case $x in\n  (#* | <->..<->) echo hi ;;\nesac\n" },

  // p10k
  { name: "group after expansion in pattern", source: '[[ $a == ${b% *}(| *) ]]\n' },
  { name: "group with a space inside", source: "[[ $a == (| *) ]]\n" },

  // syntax-highlighting test data
  { name: "$'…' with escaped quote", source: "BUFFER=$': $(( 0 * 1\\'\\'000 ))'\n" },
  { name: "$'…' plain", source: "BUFFER=$'a\\tb'\n" },

  // still failing after the first round
  { name: "always block", source: 'if ! { read -q "?y " } always { echo "" }; then\n  :\nfi\n' },
  { name: "always block, bare", source: '{ echo a } always { echo b }\n' },
  { name: "case pattern, group then glob", source: "case $x in\n  (scalar|integer|float)*) echo hi;;\nesac\n" },
  { name: "case pattern, group only", source: "case $x in\n  (scalar|integer)) echo hi;;\nesac\n" },
  { name: "case pattern starting with #", source: "case $x in\n  (#*) echo hi;;\nesac\n" },
  { name: "case body on the pattern line", source: "case $x in\n  (none) if true; then\n    echo hi\n  fi\n  ;;\nesac\n" },
];

async function shellVerdict(shell: string, source: string): Promise<string> {
  const proc = Bun.spawn([shell, "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();

  await new Response(proc.stderr).text();
  await proc.exited;

  return proc.exitCode === 0 ? "accepts" : "rejects";
}

for (const testCase of CASES) {
  console.log(`\n=== ${testCase.name} ===`);
  console.log(`  src:  ${JSON.stringify(testCase.source)}`);
  console.log(`  bash: ${await shellVerdict("bash", testCase.source)}   zsh: ${await shellVerdict("zsh", testCase.source)}`);

  for (const dialect of ["bash", "zsh"] as const) {
    try {
      parseShell(testCase.source, { dialect });
      console.log(`  ours(${dialect}): accepts`);
    } catch (error) {
      console.log(`  ours(${dialect}): REJECTED — ${(error as Error).message}`);
    }
  }
}
