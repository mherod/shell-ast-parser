/**
 * Finds the `{` that never closes.
 *
 *   bun scripts/debug-unbalanced-brace.ts <file>
 *
 * "Expected }" at the end of a 9000-line file says nothing about where the
 * brace was opened. Walk the tokens keeping a stack, and whatever is still on
 * it at EOF is the culprit — with its line.
 */
import { tokenize, TokenType } from "../src/tokenizer.ts";
import type { Dialect } from "../src/ast.ts";

const file = Bun.argv[2];
if (!file) {
  console.error("usage: bun scripts/debug-unbalanced-brace.ts <file>");
  process.exit(1);
}

const dialect: Dialect = Bun.argv.includes("--bash") ? "bash" : "zsh";
const source = await Bun.file(file).text();

function lineOf(offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

const stack: { start: number; end: number }[] = [];
let closedTooMany = 0;

for (const token of tokenize(source, { dialect })) {
  if (token.type !== TokenType.Keyword && token.type !== TokenType.Operator) continue;

  if (token.value === "{") stack.push(token.range);
  else if (token.value === "}") {
    if (stack.pop() === undefined) closedTooMany++;
  }
}

console.log(`${file} (${dialect})`);
console.log(`unclosed "{": ${stack.length}, unmatched "}": ${closedTooMany}\n`);

for (const range of stack.slice(0, 10)) {
  const line = lineOf(range.start);
  const text = source.split("\n")[line - 1] ?? "";
  console.log(`  line ${line}: ${text.trim().slice(0, 100)}`);
}

// --from <line> replays the brace tokens with a running depth, so the point
// where it stops coming back to where it started is visible
const fromArg = Bun.argv.indexOf("--from");
if (fromArg !== -1) {
  const from = Number(Bun.argv[fromArg + 1]);
  console.log(`\ntrace from line ${from}:`);

  let depth = 0;
  let shown = 0;
  for (const token of tokenize(source, { dialect })) {
    if (token.type !== TokenType.Keyword && token.type !== TokenType.Operator) continue;
    if (token.value !== "{" && token.value !== "}") continue;

    depth += token.value === "{" ? 1 : -1;
    const line = lineOf(token.range.start);
    if (line < from || shown++ > 30) continue;
    console.log(`  line ${String(line).padStart(5)} ${token.value} depth=${depth}  ${(source.split("\n")[line - 1] ?? "").trim().slice(0, 80)}`);
  }
}
