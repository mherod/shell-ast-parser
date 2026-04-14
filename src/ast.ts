/** Source location range for every AST node */
export interface Range {
  start: number;
  end: number;
}

// ── Leaf / atom nodes ──────────────────────────────────────────────

export interface Word {
  type: "Word";
  value: string;
  range: Range;
}

export interface VariableExpansion {
  type: "VariableExpansion";
  /** e.g. "NAME", "#NAME", "NAME:-default" */
  expression: string;
  braced: boolean;
  range: Range;
}

export interface CommandSubstitution {
  type: "CommandSubstitution";
  /** $(…) vs `…` */
  backtick: boolean;
  body: Script;
  range: Range;
}

export interface ArithmeticExpansion {
  type: "ArithmeticExpansion";
  expression: string;
  range: Range;
}

export interface ProcessSubstitution {
  type: "ProcessSubstitution";
  direction: "<" | ">";
  body: Script;
  range: Range;
}

export interface GlobPattern {
  type: "GlobPattern";
  value: string;
  range: Range;
}

export interface Comment {
  type: "Comment";
  value: string;
  range: Range;
}

/** Any token-level piece that can appear in a word position */
export type WordPart =
  | Word
  | VariableExpansion
  | CommandSubstitution
  | ArithmeticExpansion
  | ProcessSubstitution
  | GlobPattern;

/** A compound word is a sequence of parts that form a single argument.
 *  e.g.  "hello ${NAME}!"  →  [Word, VariableExpansion, Word] */
export interface CompoundWord {
  type: "CompoundWord";
  parts: WordPart[];
  range: Range;
}

// ── Redirections ───────────────────────────────────────────────────

export interface Redirect {
  type: "Redirect";
  /** file descriptor number, or null for default */
  fd: number | null;
  op: ">" | ">>" | "<" | "<<" | "<<-" | "<<<" | ">&" | "<&" | ">|" | "<>";
  target: CompoundWord | HereDoc;
  range: Range;
}

export interface HereDoc {
  type: "HereDoc";
  delimiter: string;
  content: string;
  /** <<- strips leading tabs */
  stripTabs: boolean;
  /** quoted delimiter suppresses expansion */
  quoted: boolean;
  range: Range;
}

// ── Commands ───────────────────────────────────────────────────────

export interface Assignment {
  type: "Assignment";
  name: string;
  value: CompoundWord | null;
  range: Range;
}

export interface SimpleCommand {
  type: "SimpleCommand";
  /** VAR=val prefixes */
  assignments: Assignment[];
  /** command name + arguments as compound words */
  name: CompoundWord | null;
  args: CompoundWord[];
  redirects: Redirect[];
  range: Range;
}

export interface Pipeline {
  type: "Pipeline";
  /** ! prefix negates exit status */
  negated: boolean;
  commands: Command[];
  range: Range;
}

/** &&, ||, ; ,& ,newline-separated lists */
export interface List {
  type: "List";
  left: ListItem;
  op: "&&" | "||" | ";" | "&";
  right: ListItem;
  range: Range;
}

export type ListItem = Pipeline | List;

export interface Subshell {
  type: "Subshell";
  body: Script;
  redirects: Redirect[];
  range: Range;
}

export interface BraceGroup {
  type: "BraceGroup";
  body: Script;
  redirects: Redirect[];
  range: Range;
}

// ── Compound commands ──────────────────────────────────────────────

export interface IfClause {
  type: "IfClause";
  condition: Script;
  then: Script;
  elifs: { condition: Script; then: Script }[];
  else: Script | null;
  redirects: Redirect[];
  range: Range;
}

export interface ForClause {
  type: "ForClause";
  variable: string;
  words: CompoundWord[] | null;
  body: Script;
  redirects: Redirect[];
  range: Range;
}

export interface WhileClause {
  type: "WhileClause";
  condition: Script;
  body: Script;
  redirects: Redirect[];
  range: Range;
}

export interface UntilClause {
  type: "UntilClause";
  condition: Script;
  body: Script;
  redirects: Redirect[];
  range: Range;
}

export interface CaseItem {
  type: "CaseItem";
  patterns: CompoundWord[];
  body: Script;
  range: Range;
}

export interface CaseClause {
  type: "CaseClause";
  word: CompoundWord;
  items: CaseItem[];
  redirects: Redirect[];
  range: Range;
}

export interface FunctionDef {
  type: "FunctionDef";
  name: string;
  body: Command;
  redirects: Redirect[];
  range: Range;
}

export interface Coproc {
  type: "Coproc";
  name: string | null;
  body: Command;
  redirects: Redirect[];
  range: Range;
}

// ── Union types ────────────────────────────────────────────────────

export type CompoundCommand =
  | IfClause
  | ForClause
  | WhileClause
  | UntilClause
  | CaseClause
  | Subshell
  | BraceGroup;

export type Command =
  | SimpleCommand
  | Pipeline
  | List
  | CompoundCommand
  | FunctionDef
  | Coproc;

// ── Top-level ──────────────────────────────────────────────────────

export interface Script {
  type: "Script";
  commands: Command[];
  comments: Comment[];
  range: Range;
}
