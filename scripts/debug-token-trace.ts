/**
 * Prints the token stream for one snippet, with offsets and adjacency.
 *
 *   bun scripts/debug-token-trace.ts "case x in (a) echo hi;; esac"
 *
 * Two of the remaining failures make no sense from the parser's message alone.
 * Adjacency matters — `)*` and `) echo` differ only by a space — so the offsets
 * are printed rather than just the values.
 */
import { tokenize } from "../src/tokenizer.ts";
import type { Dialect } from "../src/ast.ts";

const source = Bun.argv[2] ?? 'if ! { read -q "?y " } always { echo "" }; then\n  :\nfi\n';
const dialect: Dialect = Bun.argv.includes("--bash") ? "bash" : "zsh";

console.log(`src (${dialect}): ${JSON.stringify(source)}\n`);

let previousEnd = -1;
for (const token of tokenize(source, { dialect })) {
  const gap = previousEnd === -1 || token.range.start > previousEnd ? " " : "|";
  console.log(
    `${String(token.range.start).padStart(4)}-${String(token.range.end).padEnd(4)} ${gap} ${token.type.padEnd(12)} ${JSON.stringify(token.value)}`,
  );
  previousEnd = token.range.end;
}
console.log("\n(a | in the gap column means the token is adjacent to the one before it)");
