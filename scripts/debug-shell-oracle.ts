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
import { parseShell } from "../index.ts";

interface Snippet {
  name: string;
  source: string;
}

const SNIPPETS: Snippet[] = [
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
];

async function shellAccepts(shell: string, source: string): Promise<string | null> {
  const proc = Bun.spawn([shell, "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  return proc.exitCode === 0 ? null : stderr.trim().split("\n")[0] ?? "rejected";
}

function parserAccepts(source: string): string | null {
  try {
    parseShell(source);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const results: { name: string; verdict: string }[] = [];

for (const snippet of SNIPPETS) {
  const bash = await shellAccepts("bash", snippet.source);
  const zsh = await shellAccepts("zsh", snippet.source);
  const ours = parserAccepts(snippet.source);

  console.log(`\n=== ${snippet.name} ===`);
  console.log(JSON.stringify(snippet.source));
  console.log(`  bash: ${bash === null ? "accepts" : `rejects — ${bash}`}`);
  console.log(`  zsh:  ${zsh === null ? "accepts" : `rejects — ${zsh}`}`);
  console.log(`  ours: ${ours === null ? "accepts" : `rejects — ${ours}`}`);

  const verdict =
    ours === null
      ? bash === null || zsh === null
        ? "ok"
        : "OVER-ACCEPTS (both shells reject)"
      : bash === null
        ? "REAL GAP (bash accepts)"
        : zsh === null
          ? "zsh-only (out of scope)"
          : "ok (both shells reject too)";

  console.log(`  verdict: ${verdict}`);
  results.push({ name: snippet.name, verdict });
}

console.log("\n=== summary ===");
for (const result of results) {
  console.log(`${result.verdict.padEnd(28)} ${result.name}`);
}
