/**
 * Tracks the four zsh constructs as they are added, in both dialects.
 *
 *   bun scripts/debug-zsh-constructs.ts
 *
 * Two things have to hold at once and they pull in opposite directions: zsh
 * dialect must parse each construct into the right shape, and bash dialect must
 * still refuse it. Printing both on every run keeps the second from quietly
 * regressing while the first is being built.
 */
import { parseShell } from "../index.ts";

const CASES: { name: string; source: string; expect: string }[] = [
  { name: "anonymous function", source: "function {\n  echo hi\n}\n", expect: "FunctionDef name=null" },
  { name: "anonymous function w/ args", source: "function {\n  echo $1\n} foo bar\n", expect: "FunctionDef 2 args" },
  { name: "short for-loop", source: 'for x ("$a[@]") echo $x\n', expect: "ForClause" },
  { name: "short for-loop, brace body", source: 'for x (a b) { echo $x }\n', expect: "ForClause" },
  { name: "glob qualifier (N)", source: "X=($HOME/bin(N) $X)\n", expect: "qualifier N" },
  { name: "glob qualifier (-/FN)", source: "fpath=(${loc}/functions(-/FN) $fpath)\n", expect: "qualifier -/FN" },
  { name: "glob qualifier on wildcard", source: "print -l *(.)\n", expect: "qualifier ." },
  { name: "bare alternation", source: "[[ $x == (a|b) ]]\n", expect: "extended op=null" },
  { name: "numeric range", source: "[[ $v == <1-> ]]\n", expect: "numeric-range 1..null" },
  { name: "p10k version check", source: "[[ $ZSH_VERSION == (5.<1->*|<6->.*) ]] || return\n", expect: "parses" },
  { name: "p10k wip check", source: "[[ $S == (|*[^[:alnum:]])(wip|WIP)(|[^[:alnum:]]*) ]]\n", expect: "parses" },
];

/** Compact node-type shape, with glob kinds and function names spelled out. */
function shape(node: unknown): string {
  if (Array.isArray(node)) {
    const items = node.map(shape).filter(Boolean);
    return items.length > 0 ? `[${items.join(",")}]` : "";
  }
  if (node === null || typeof node !== "object") return "";

  const record = node as Record<string, unknown>;
  const children = Object.entries(record)
    // `value` is a plain string on leaves but a real node on an Assignment, so
    // drop it only when it is text
    .filter(([key, value]) => !["range", "type", "comments"].includes(key) && typeof value !== "string")
    .map(([, value]) => shape(value))
    .filter(Boolean);

  if (typeof record.type !== "string") return children.join(",");

  let label = record.type;
  if (record.type === "GlobPattern") {
    label = `Glob:${record.kind}`;
    if (record.kind === "qualifier") label += `(${record.qualifiers})`;
    if (record.kind === "numeric-range") label += `(${record.min}..${record.max})`;
    if (record.kind === "extended") label += `(op=${record.op})`;
  }
  if (record.type === "FunctionDef") label = `FunctionDef(name=${record.name})`;

  return children.length > 0 ? `${label}{${children.join(",")}}` : label;
}

let zshOk = 0;
let bashRejects = 0;

for (const testCase of CASES) {
  console.log(`\n=== ${testCase.name} ===  (want: ${testCase.expect})`);
  console.log(`  src:  ${JSON.stringify(testCase.source)}`);

  try {
    const script = parseShell(testCase.source, { dialect: "zsh" });
    console.log(`  zsh:  ${shape(script.commands)}`);
    zshOk++;
  } catch (error) {
    console.log(`  zsh:  REJECTED — ${(error as Error).message}`);
  }

  try {
    parseShell(testCase.source, { dialect: "bash" });
    console.log(`  bash: accepts (expected to reject — zsh-only syntax)`);
  } catch (error) {
    console.log(`  bash: rejects — ${(error as Error).message}`);
    bashRejects++;
  }
}

console.log(`\n=== ${zshOk}/${CASES.length} parse as zsh, ${bashRejects}/${CASES.length} rejected as bash ===`);
