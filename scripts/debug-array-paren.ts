/**
 * Does bash really accept a paren-suffixed word inside an array?
 *
 *   bun scripts/debug-array-paren.ts
 *
 * `bash -n` accepted `X=(a(N))`, which would make our rejection a gap. But `-n`
 * only checks syntax, and array element parsing is one of the places it is
 * known to be lax — so run the thing and see whether bash agrees with itself.
 */

async function run(shell: string, args: string[], source: string) {
  const proc = Bun.spawn([shell, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  return { code: proc.exitCode, stdout: stdout.trim(), stderr: stderr.trim().split("\n")[0] ?? "" };
}

const SOURCES = [
  'X=(a(N))\necho "count=${#X[@]} first=${X[0]}"\n',
  'X=($HOME/bin(N))\necho "count=${#X[@]}"\n',
  'X=(a b)\necho "count=${#X[@]}"\n',
];

for (const source of SOURCES) {
  console.log(`\n=== ${JSON.stringify(source)} ===`);

  for (const shell of ["bash", "zsh"]) {
    const syntax = await run(shell, ["-n"], source);
    const executed = await run(shell, [], source);
    console.log(`  ${shell} -n : ${syntax.code === 0 ? "accepts" : `rejects — ${syntax.stderr}`}`);
    console.log(`  ${shell}    : ${executed.code === 0 ? `runs — ${executed.stdout}` : `fails — ${executed.stderr}`}`);
  }
}
