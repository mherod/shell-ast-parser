import type { Dialect } from "../src/ast.ts";
import posixBasics from "./posix-basics.json";
import bashAdvanced from "./bash-advanced.json";
import zshExtensions from "./zsh-extensions.json";
import shellcheckTraps from "./shellcheck-traps.json";
import treeSitterCorpus from "./tree-sitter-corpus.json";

export interface FixtureCase {
  name: string;
  source: string;
  dialect?: Dialect;
}

export interface FixtureSuite {
  id: string;
  name: string;
  cases: FixtureCase[];
}

export const ALL_FIXTURE_SUITES: FixtureSuite[] = [
  { id: "posix-basics", name: "POSIX Standards & Fundamentals", cases: posixBasics as FixtureCase[] },
  { id: "bash-advanced", name: "Advanced Bash Features", cases: bashAdvanced as FixtureCase[] },
  { id: "zsh-extensions", name: "Zsh Dialect & Extensions", cases: zshExtensions as FixtureCase[] },
  { id: "shellcheck-traps", name: "ShellCheck Edge Cases & Traps", cases: shellcheckTraps as FixtureCase[] },
  { id: "tree-sitter-corpus", name: "Tree-Sitter Grammar Corpus", cases: treeSitterCorpus as FixtureCase[] },
];
