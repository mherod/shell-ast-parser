import { describe, test, expect } from "bun:test";
import { parseShell, visit, ParseError } from "../index.ts";
import { ALL_FIXTURE_SUITES } from "../fixtures/index.ts";
import { findRangeFaults, getCommandNames } from "../scripts/harness.ts";

describe("Fixture Testbed Conformance & Invariants", () => {
  for (const suite of ALL_FIXTURE_SUITES) {
    describe(suite.name, () => {
      for (const fixture of suite.cases) {
        test(fixture.name, () => {
          const dialect = fixture.dialect ?? "bash";

          if (fixture.shouldError) {
            expect(() => parseShell(fixture.source, { dialect })).toThrow(ParseError);
            return;
          }

          const script = parseShell(fixture.source, { dialect });

          // 1. Root AST structure
          expect(script).toBeDefined();
          expect(script.type).toBe("Script");
          expect(Array.isArray(script.commands)).toBe(true);
          expect(script.commands.length).toBeGreaterThan(0);

          // 2. Range boundary invariants on all nodes
          visit(script, (node) => {
            expect(node.range).toBeDefined();
            expect(node.range.start).toBeGreaterThanOrEqual(0);
            expect(node.range.end).toBeGreaterThanOrEqual(node.range.start);
            expect(node.range.end).toBeLessThanOrEqual(fixture.source.length);
          });

          // 3. Word range slicing invariant (no drift across escapes or substitutions)
          const rangeFaults = findRangeFaults(fixture.source, script);
          expect(rangeFaults).toEqual([]);

          // 4. Ensure traversal extracts command names without throwing
          const names = getCommandNames(script);
          expect(Array.isArray(names)).toBe(true);
        });
      }
    });
  }
});
