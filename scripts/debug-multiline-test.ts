/**
 * Dumps the tree for `[[ … ]]` conditions that span lines.
 *
 *   bun scripts/debug-multiline-test.ts
 *
 * Acceptance alone does not prove these parse correctly: a newline that ends
 * the condition early turns one TestCommand into a list of stray commands, and
 * that still "parses". So print the shape and compare it against the same
 * condition written on one line, which is the tree we know is right.
 */
import { parseShell } from "../index.ts";
import { tokenize } from "../src/tokenizer.ts";

const CASES: { name: string; multiline: string; oneline: string }[] = [
  {
    name: "|| on next line",
    multiline: "[[ -n $A\n   || -n $B ]] && echo yes\n",
    oneline: "[[ -n $A || -n $B ]] && echo yes\n",
  },
  {
    name: "newline right after [[",
    multiline: "[[\n  -n $A\n]] && echo yes\n",
    oneline: "[[ -n $A ]] && echo yes\n",
  },
  {
    name: "&& on next line, inside if",
    multiline: "if [[ -n $A\n  && -z $B ]]; then\n  echo yes\nfi\n",
    oneline: "if [[ -n $A && -z $B ]]; then\n  echo yes\nfi\n",
  },
];

/** A compact shape string: node types nested, values dropped. */
function shape(node: unknown): string {
  if (Array.isArray(node)) return `[${node.map(shape).filter(Boolean).join(",")}]`;
  if (node === null || typeof node !== "object") return "";

  const record = node as Record<string, unknown>;
  const children = Object.entries(record)
    .filter(([key]) => key !== "range" && key !== "type" && key !== "comments")
    .map(([, value]) => shape(value))
    .filter(Boolean);

  if (typeof record.type !== "string") return children.join(",");
  return children.length > 0 ? `${record.type}(${children.join(",")})` : String(record.type);
}

for (const testCase of CASES) {
  console.log(`\n=== ${testCase.name} ===`);

  for (const [label, source] of [
    ["one-line ", testCase.oneline],
    ["multiline", testCase.multiline],
  ] as const) {
    console.log(`  ${label} src: ${JSON.stringify(source)}`);
    console.log(
      `  ${label} tok: ${tokenize(source)
        .map((token) => `${token.type}:${token.value.replace(/\n/g, "\\n")}`)
        .join(" ")}`,
    );
    try {
      const script = parseShell(source);
      console.log(`  ${label} cmds: ${script.commands.length}`);
      console.log(`  ${label} tree: ${shape(script.commands)}`);
    } catch (error) {
      console.log(`  ${label} tree: REJECTED — ${(error as Error).message}`);
    }
  }

  try {
    const a = shape(parseShell(testCase.oneline).commands);
    const b = shape(parseShell(testCase.multiline).commands);
    console.log(`  MATCH: ${a === b ? "yes" : "NO — multiline parses differently"}`);
  } catch {
    console.log(`  MATCH: n/a (one side rejected)`);
  }
}
