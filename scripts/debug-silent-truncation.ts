/**
 * Asks whether a stray `)` makes the parser stop early and say nothing.
 *
 *   bun scripts/debug-silent-truncation.ts
 *
 * Dropped comments were the visible symptom. The real question is whether the
 * commands after the stray `)` survive: a static-analysis parser that quietly
 * returns half a script is worse than one that throws, because every caller
 * reads the short answer as the whole answer.
 */
import { parseShell } from "../index.ts";

const CASES: { name: string; source: string }[] = [
  { name: "array w/ paren-suffixed word", source: "X=($HOME/bin(N))\necho AFTER\n" },
  { name: "plain stray close paren", source: "echo one\n)\necho AFTER\n" },
  { name: "unbalanced close in array", source: "X=(a b))\necho AFTER\n" },
  { name: "control: balanced array", source: "X=(a b)\necho AFTER\n" },
  { name: "stray close after if", source: "if true; then\n  echo hi\nfi\n)\necho AFTER\n" },
  { name: "stray brace", source: "echo one\n}\necho AFTER\n" },
];

/** Names of every SimpleCommand in the tree, at any depth. */
function commandNames(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) commandNames(item, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;

  const record = node as Record<string, unknown>;
  if (record.type === "SimpleCommand" && record.name) {
    const parts = (record.name as { parts?: { value?: string }[] }).parts ?? [];
    found.push(parts.map((part) => part.value ?? "?").join(""));
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "range") continue;
    commandNames(value, found);
  }
  return found;
}

async function bashVerdict(source: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();

  await new Response(proc.stderr).text();
  await proc.exited;

  return proc.exitCode === 0 ? "accepts" : "rejects";
}

for (const testCase of CASES) {
  const bash = await bashVerdict(testCase.source);

  let ours: string;
  let names: string[] = [];
  try {
    names = commandNames(parseShell(testCase.source));
    ours = "accepts";
  } catch (error) {
    ours = `throws — ${(error as Error).message}`;
  }

  const sawAfter = names.includes("echo");
  console.log(`\n=== ${testCase.name} ===`);
  console.log(`  src:      ${JSON.stringify(testCase.source)}`);
  console.log(`  bash:     ${bash}`);
  console.log(`  ours:     ${ours}`);
  console.log(`  commands: ${JSON.stringify(names)}`);

  // What matters is whether the trailing command survived, not whose opinion
  // bash holds: accepting the source and then omitting `echo AFTER` is the
  // failure, and it is worst precisely when bash accepts the source too.
  if (ours === "accepts" && !sawAfter) {
    console.log(`  VERDICT:  SILENT TRUNCATION — parsed without error, "echo AFTER" missing`);
  } else if (ours !== "accepts" && bash === "accepts") {
    console.log(`  VERDICT:  rejects source bash accepts`);
  } else if (ours === "accepts" && bash === "rejects") {
    console.log(`  VERDICT:  over-accepts, but kept the trailing commands`);
  } else {
    console.log(`  VERDICT:  ok`);
  }
}
