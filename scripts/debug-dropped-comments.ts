/**
 * Narrows down which comments never reach the AST.
 *
 *   bun scripts/debug-dropped-comments.ts
 *
 * The coverage check on ~/.zprezto/runcoms/zprofile found source text belonging
 * to no node: 32 comment tokens went in and 24 Comment nodes came out. Comments
 * are the one thing a parse can lose without changing any command, so bisect the
 * shapes around them until the losing one is isolated.
 */
import { parseShell } from "../index.ts";
import { tokenize, TokenType } from "../src/tokenizer.ts";

const CASES: { name: string; source: string }[] = [
  { name: "comment at top level", source: "# one\necho hi\n" },
  { name: "comment after simple command", source: "echo hi\n# one\n" },
  { name: "comment after scalar assignment", source: "X=1\n# one\n# two\n" },
  { name: "comment after one-line array", source: "X=(a b)\n# one\n# two\n" },
  { name: "comment after multi-line array", source: "X=(\n  a\n  b\n)\n# one\n# two\n" },
  { name: "comment inside multi-line array", source: "X=(\n  a\n  # why\n  b\n)\n" },
  { name: "comment after subshell", source: "(echo hi)\n# one\n# two\n" },
  { name: "comment after brace group", source: "{ echo hi; }\n# one\n# two\n" },
  { name: "comment after if", source: "if true; then\n  echo hi\nfi\n# one\n# two\n" },
  { name: "comment after function", source: "f() {\n  echo hi\n}\n# one\n# two\n" },

  // The real array that precedes the loss, reduced one feature at a time
  { name: "array w/ brace expansion", source: "X=(\n  $HOME/{,s}bin\n  $X\n)\n# one\n# two\n" },
  { name: "array w/ glob qualifier (N)", source: "X=(\n  $HOME/bin(N)\n  $X\n)\n# one\n# two\n" },
  { name: "array w/ both", source: "X=(\n  $HOME/{,s}bin(N)\n  $X\n)\n# one\n# two\n" },
  { name: "word w/ trailing (N), no array", source: "echo $HOME/bin(N)\n# one\n# two\n" },
  { name: "one-line array w/ (N)", source: "X=($HOME/bin(N))\n# one\n# two\n" },
];

/** Every Comment node anywhere in the tree, not just the top-level Script. */
function commentNodes(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) commentNodes(item, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;

  const record = node as Record<string, unknown>;
  if (record.type === "Comment") found.push(String(record.value));

  for (const [key, value] of Object.entries(record)) {
    if (key === "range") continue;
    commentNodes(value, found);
  }
  return found;
}

/** Comment nodes paired with their ranges, for diffing against the tokens. */
function commentRanges(node: unknown, found: Set<number> = new Set()): Set<number> {
  if (Array.isArray(node)) {
    for (const item of node) commentRanges(item, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;

  const record = node as Record<string, unknown>;
  if (record.type === "Comment") {
    found.add((record.range as { start: number }).start);
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "range") continue;
    commentRanges(value, found);
  }
  return found;
}

/**
 * The synthetic cases below did not reproduce the loss, so go at the real file
 * and name the exact comments that went missing rather than guess more shapes.
 */
const file = Bun.argv[2];
if (file) {
  const source = await Bun.file(file).text();
  const tokens = tokenize(source).filter((token) => token.type === TokenType.Comment);
  const kept = commentRanges(parseShell(source));

  console.log(`=== ${file} ===`);
  console.log(`comment tokens: ${tokens.length}, comment nodes: ${kept.size}`);

  for (const token of tokens) {
    if (kept.has(token.range.start)) continue;
    const line = source.slice(0, token.range.start).split("\n").length;
    const before = source.slice(0, token.range.start).split("\n").slice(-3, -1);
    console.log(`\n  LOST at line ${line}: ${JSON.stringify(token.value)}`);
    console.log(`    preceded by: ${JSON.stringify(before)}`);
  }
  process.exit(0);
}

for (const testCase of CASES) {
  const tokens = tokenize(testCase.source).filter((token) => token.type === TokenType.Comment);

  let nodes: string[];
  try {
    nodes = commentNodes(parseShell(testCase.source));
  } catch (error) {
    console.log(`${testCase.name.padEnd(34)} REJECTED — ${(error as Error).message}`);
    continue;
  }

  const lost = tokens.length - nodes.length;
  console.log(
    `${testCase.name.padEnd(34)} tokens=${tokens.length} nodes=${nodes.length} ${
      lost === 0 ? "ok" : `LOST ${lost}`
    }`,
  );
  if (lost !== 0) {
    console.log(`${" ".repeat(34)} in:  ${JSON.stringify(tokens.map((t) => t.value))}`);
    console.log(`${" ".repeat(34)} out: ${JSON.stringify(nodes)}`);
    console.log(`${" ".repeat(34)} src: ${JSON.stringify(testCase.source)}`);
  }
}
