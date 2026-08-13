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
import { shellAccepts, getCommandNames } from "./harness.ts";

const CASES: { name: string; source: string }[] = [
  { name: "array w/ paren-suffixed word", source: "X=($HOME/bin(N))\necho AFTER\n" },
  { name: "plain stray close paren", source: "echo one\n)\necho AFTER\n" },
  { name: "unbalanced close in array", source: "X=(a b))\necho AFTER\n" },
  { name: "control: balanced array", source: "X=(a b)\necho AFTER\n" },
  { name: "stray close after if", source: "if true; then\n  echo hi\nfi\n)\necho AFTER\n" },
  { name: "stray brace", source: "echo one\n}\necho AFTER\n" },
];

for (const testCase of CASES) {
  const bashResult = await shellAccepts("bash", testCase.source);
  const bash = bashResult === null ? "accepts" : "rejects";

  let ours: string;
  let names: string[] = [];
  try {
    names = getCommandNames(parseShell(testCase.source));
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
