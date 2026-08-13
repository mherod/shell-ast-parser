/**
 * Runs the fixture testbed against our parser and the shell oracles.
 *
 *   bun scripts/run-fixtures.ts
 *   bun scripts/run-fixtures.ts --suite=posix-basics
 *   bun scripts/run-fixtures.ts --suite=zsh-extensions
 *   bun scripts/run-fixtures.ts --suite=shellcheck-traps
 */
import { ALL_FIXTURE_SUITES, type FixtureSuite } from "../fixtures/index.ts";
import { runCaseTable } from "./harness.ts";

const suiteFlag = Bun.argv.find((arg) => arg.startsWith("--suite="));
const selectedSuiteId = suiteFlag ? suiteFlag.split("=")[1] : null;

const suitesToRun = selectedSuiteId
  ? ALL_FIXTURE_SUITES.filter((s) => s.id === selectedSuiteId)
  : ALL_FIXTURE_SUITES;

if (suitesToRun.length === 0) {
  console.error(`No suite found matching "${selectedSuiteId}". Available suites:`);
  for (const s of ALL_FIXTURE_SUITES) {
    console.error(`  - ${s.id} (${s.name})`);
  }
  process.exit(1);
}

let totalCases = 0;
let okCount = 0;

for (const suite of suitesToRun) {
  console.log(`\n======================================================`);
  console.log(`SUITE: ${suite.name} [${suite.id}] (${suite.cases.length} cases)`);
  console.log(`======================================================`);

  const results = await runCaseTable(suite.cases, { verbose: true, summary: false });
  totalCases += results.length;

  for (const res of results) {
    if (res.verdict === "ok" || res.verdict === "zsh-only (out of scope)") {
      okCount++;
    }
  }
}

console.log(`\n======================================================`);
console.log(`FIXTURE SUMMARY: ${okCount}/${totalCases} fixtures in expected conformance state`);
console.log(`======================================================`);
