import { describe, test, expect } from "bun:test";
import { parseShell, visit } from "../index.ts";
import { findRangeFaults, getCommandNames } from "../scripts/harness.ts";

const SCRIPT_FIXTURES = [
  {
    file: "fizzbuzz.sh",
    expectedCommands: ["echo"],
    expectedNodeTypes: ["ArithmeticForClause", "IfClause", "ElifBranch"],
  },
  {
    file: "sort-numbers.sh",
    expectedCommands: ["printf"],
    expectedNodeTypes: ["ArithmeticForClause", "WhileClause", "ArrayLiteral", "ArithmeticSubscript"],
  },
  {
    file: "word-frequency.sh",
    expectedCommands: ["tr", "sort", "head"],
    expectedNodeTypes: ["FunctionDef", "Pipeline", "BraceGroup"],
  },
  {
    file: "prime-report.sh",
    expectedCommands: ["printf", "return"],
    expectedNodeTypes: ["FunctionDef", "WhileClause", "ArithmeticForClause", "CaseClause", "ArrayLiteral"],
  },
] as const;

describe("Fixture shell scripts parse end-to-end", () => {
  for (const { file, expectedCommands, expectedNodeTypes } of SCRIPT_FIXTURES) {
    test(file, async () => {
      const source = await Bun.file(new URL(`../fixtures/${file}`, import.meta.url)).text();
      const script = parseShell(source, { dialect: "bash" });

      expect(script.type).toBe("Script");
      expect(script.commands.length).toBeGreaterThan(0);

      // Range invariants on every node
      const seenTypes = new Set<string>();
      visit(script, (node) => {
        seenTypes.add(node.type);
        expect(node.range.start).toBeGreaterThanOrEqual(0);
        expect(node.range.end).toBeGreaterThanOrEqual(node.range.start);
        expect(node.range.end).toBeLessThanOrEqual(source.length);
      });

      // No word-range drift against the original source
      expect(findRangeFaults(source, script)).toEqual([]);

      // Structural expectations per script
      for (const nodeType of expectedNodeTypes) {
        expect(seenTypes).toContain(nodeType);
      }
      const names = getCommandNames(script);
      for (const cmd of expectedCommands) {
        expect(names).toContain(cmd);
      }
    });
  }
});
