/**
 * Checks that a node's range still indexes the text it came from.
 *
 *   bun scripts/debug-range-drift.ts
 *
 * Thirteen Homebrew scripts parse but report range faults, all inside backtick
 * substitutions holding `\$` escapes. The README promises
 * `src.slice(node.range.start, node.range.end)` returns that node's text at any
 * depth, so a drift here is a broken promise rather than a parse failure —
 * quieter than an error and worse, since every offset after it is wrong too.
 */
import { parseShell } from "../index.ts";
import { findRangeFaults } from "./harness.ts";

const CASES: { name: string; source: string }[] = [
  { name: "backtick, plain", source: "x=`echo a -e b`\n" },
  { name: "backtick with \\$", source: "x=`echo \\$(CC) -e b`\n" },
  { name: "backtick with \\` ", source: "x=`echo \\` -e b`\n" },
  { name: "backtick with continuation", source: "x=`echo a \\\n  -e b`\n" },
  { name: "backtick, both", source: "x=`sed -e 's/\\$(CC)//' \\\n  -e 's/x//'`\n" },
  { name: "$() with \\$", source: "x=$(echo \\$(CC) -e b)\n" },
  { name: "$() with continuation", source: "x=$(echo a \\\n  -e b)\n" },
  { name: "plain continuation, no substitution", source: "echo a \\\n  -e b\n" },
];

for (const testCase of CASES) {
  const found = findRangeFaults(testCase.source, parseShell(testCase.source));
  console.log(`${found.length === 0 ? "ok  " : "DRIFT"} ${testCase.name}`);
  console.log(`      src: ${JSON.stringify(testCase.source)}`);
  for (const fault of found) {
    console.log(`      value ${JSON.stringify(fault.value)} but slice ${JSON.stringify(fault.sliced)}`);
  }
}
