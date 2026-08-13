import type { Dialect } from "../src/ast.ts";
import posixBasics from "./posix-basics.json";
import bashAdvanced from "./bash-advanced.json";
import zshExtensions from "./zsh-extensions.json";
import shellcheckTraps from "./shellcheck-traps.json";
import treeSitterCorpus from "./tree-sitter-corpus.json";
import quotingEscapes from "./quoting-escapes.json";
import parameterExpansions from "./parameter-expansions.json";
import arithmeticTorture from "./arithmetic-torture.json";
import redirectionsHeredocs from "./redirections-heredocs.json";
import conditionalsRegex from "./conditionals-regex.json";
import controlFlow from "./control-flow.json";
import zshAdvanced from "./zsh-advanced.json";
import syntaxErrors from "./syntax-errors.json";

export interface FixtureCase {
  name: string;
  source: string;
  dialect?: Dialect;
  shouldError?: boolean;
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
  { id: "quoting-escapes", name: "Quoting & Escape Sequences", cases: quotingEscapes as FixtureCase[] },
  { id: "parameter-expansions", name: "Parameter Expansions & Modifiers", cases: parameterExpansions as FixtureCase[] },
  { id: "arithmetic-torture", name: "Arithmetic Stress & Complex Precedence", cases: arithmeticTorture as FixtureCase[] },
  { id: "redirections-heredocs", name: "Redirections, Heredocs & Descriptors", cases: redirectionsHeredocs as FixtureCase[] },
  { id: "conditionals-regex", name: "Conditionals, Regexes & Pattern Matching", cases: conditionalsRegex as FixtureCase[] },
  { id: "control-flow", name: "Control Flow, Compounds & Subshells", cases: controlFlow as FixtureCase[] },
  { id: "zsh-advanced", name: "Zsh Advanced Features & Qualifiers", cases: zshAdvanced as FixtureCase[] },
  { id: "syntax-errors", name: "Syntax Errors & Error Recovery", cases: syntaxErrors as FixtureCase[] },
];
