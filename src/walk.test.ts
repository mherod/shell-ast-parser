import { describe, test, expect } from "bun:test";
import { parseShell } from "../index.ts";
import {
  visit,
  findAll,
  firstOf,
  SKIP,
  EXIT,
  isAstNode,
  isNodeType,
} from "./walk.ts";
import type { HereDoc, Word, SimpleCommand, IfClause, CompoundWord } from "./ast.ts";

describe("AST walker (src/walk.ts)", () => {
  test("findAll finds all nodes of matching type with type narrowing", () => {
    const script = parseShell("echo hello world; cat <<EOF\nbody\nEOF\n");
    const heredocs: HereDoc[] = findAll(script, "HereDoc");
    expect(heredocs.length).toBe(1);
    expect(heredocs[0]!.delimiter).toBe("EOF");

    const words: Word[] = findAll(script, "Word");
    expect(words.length).toBe(4); // echo, hello, world, cat
    expect(words.map((w) => w.value)).toEqual(["echo", "hello", "world", "cat"]);
  });

  test("firstOf returns first matching node or null", () => {
    const script = parseShell("a=1; b=2; if true; then echo hi; fi");
    const ifClause: IfClause | null = firstOf(script, "IfClause");
    expect(ifClause).not.toBeNull();
    expect(ifClause!.type).toBe("IfClause");

    const nonExistent = firstOf(script, "UntilClause");
    expect(nonExistent).toBeNull();
  });

  test("visit traverses in depth-first pre-order and passes parent & key", () => {
    const script = parseShell("echo $VAR");
    const types: string[] = [];
    const parents: string[] = [];

    visit(script, (node, parent) => {
      types.push(node.type);
      if (parent && isAstNode(parent)) {
        parents.push(parent.type);
      }
    });

    expect(types).toEqual([
      "Script",
      "Pipeline",
      "SimpleCommand",
      "CompoundWord",
      "Word",
      "CompoundWord",
      "VariableExpansion",
    ]);
  });

  test("visit never visits range properties", () => {
    const script = parseShell("echo a");
    const visitedKeys: (string | number | undefined)[] = [];

    visit(script, (_node, _parent, key) => {
      visitedKeys.push(key);
    });

    expect(visitedKeys).not.toContain("range");
  });

  test("visit supports SKIP to avoid recursing into children", () => {
    const script = parseShell("if true; then echo inside; fi; echo outside");
    const visitedArguments: string[] = [];

    visit(script, (node) => {
      if (node.type === "IfClause") {
        return SKIP;
      }
      if (node.type === "SimpleCommand") {
        const cmd = node as SimpleCommand;
        const arg = (cmd.args[0] as CompoundWord)?.parts[0] as Word;
        if (arg) visitedArguments.push(arg.value);
      }
    });

    // "inside" command inside IfClause was skipped
    expect(visitedArguments).toEqual(["outside"]);
  });

  test("visit supports EXIT to abort traversal immediately", () => {
    const script = parseShell("echo first; echo second; echo third");
    const argsSeen: string[] = [];

    visit(script, (node) => {
      if (node.type === "SimpleCommand") {
        const cmd = node as SimpleCommand;
        const arg = (cmd.args[0] as CompoundWord)?.parts[0] as Word;
        if (arg) {
          argsSeen.push(arg.value);
          if (arg.value === "second") return EXIT;
        }
      }
    });

    expect(argsSeen).toEqual(["first", "second"]);
  });

  test("isAstNode and isNodeType type guards", () => {
    const script = parseShell("echo test");
    expect(isAstNode(script)).toBe(true);
    expect(isAstNode({ type: "Fake" })).toBe(true);
    expect(isAstNode(null)).toBe(false);
    expect(isAstNode("string")).toBe(false);
    expect(isAstNode({ start: 0, end: 5 })).toBe(false);

    expect(isNodeType(script, "Script")).toBe(true);
    expect(isNodeType(script, "IfClause")).toBe(false);
  });
});
