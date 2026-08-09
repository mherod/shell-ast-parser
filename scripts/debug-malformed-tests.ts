/**
 * Checks the malformed `[[ … ]]` inputs from the test suite against bash.
 *
 *   bun scripts/debug-malformed-tests.ts
 *
 * Requiring the closing `]]` made two "do not hang" tests fail. Whether that is
 * a regression or the point depends on whether bash considers these inputs
 * valid, so ask it rather than argue from the test name.
 */
import { parseShell } from "../index.ts";

const INPUTS = [
  "[[",
  "[[ -f ]]",
  "[[ && ]]",
  "[[ ( ]]",
  "[[ a ==",
  "[[ ! ]]",
  "[[ $s =~ ( ]]",
  "[[ $s =~ ) ]]",
  "[[ $s =~ [ ]]",
  "[[ $s =~ * ]]",
  "[[ $s =~ a{ ]]",
];

async function bashRejects(source: string): Promise<string | null> {
  const proc = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(`${source}\n`);
  await proc.stdin.end();

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  return proc.exitCode === 0 ? null : (stderr.trim().split("\n").pop() ?? "rejected");
}

for (const input of INPUTS) {
  const bash = await bashRejects(input);

  let ours: string;
  const started = performance.now();
  try {
    parseShell(input);
    ours = "accepts";
  } catch (error) {
    ours = `throws — ${(error as Error).message}`;
  }
  const elapsed = performance.now() - started;

  const agree = (bash === null) === (ours === "accepts");
  console.log(`${JSON.stringify(input).padEnd(18)} bash: ${(bash === null ? "accepts" : "rejects").padEnd(8)} ours: ${ours}`);
  console.log(`${" ".repeat(18)} terminated in ${elapsed.toFixed(2)}ms — ${agree ? "agrees with bash" : "DISAGREES with bash"}`);
}
