/**
 * Iterative probe for turning the parsed FizzBuzz AST into plain English.
 *
 * Run with:
 *   bun scripts/debug-humanise-fizzbuzz.ts
 */
import { parseShell } from "../index.ts";

const fixtureUrl = new URL("../fixtures/fizzbuzz.sh", import.meta.url);
const source = await Bun.file(fixtureUrl).text();

console.log("--- input ---");
console.log({
  fixture: fixtureUrl.pathname,
  type: typeof source,
  characters: source.length,
  lines: source.split("\n").length,
});
console.log(source);

const startedAt = performance.now();
const ast = parseShell(source, { dialect: "bash" });

console.log("--- parsed shape ---");
console.log({
  type: ast.type,
  keys: Object.keys(ast),
  topLevelCommands: ast.commands.length,
  comments: ast.comments.length,
  elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
});

console.log("--- full AST ---");
console.dir(ast, { depth: null, colors: false });
