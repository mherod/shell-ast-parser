/** Source location range for every AST node */
export interface Range {
  start: number;
  end: number;
}

/**
 * Which shell's grammar to read the source as. "bash" also covers sh and is
 * the default: it rejects zsh-only syntax rather than guessing at a meaning
 * bash would not give it. "zsh" additionally accepts glob qualifiers, bare
 * pattern groups, numeric ranges, anonymous functions and the short for-loop.
 */
export type Dialect = "bash" | "zsh";

export interface ParseOptions {
  /** defaults to "bash" */
  dialect?: Dialect;
}

// ── Leaf / atom nodes ──────────────────────────────────────────────

/**
 * Which quotes enclosed a word part in the source. Quoting decides whether the
 * shell expands the text and whether the result is split into fields, so it has
 * to survive into the AST — the quote characters themselves do not appear in
 * `Word.value`. `$'…'` is reported as "single": it expands nothing either.
 */
export type QuoteContext = "single" | "double" | null;

export interface Word {
  type: "Word";
  /** literal text: quotes removed, escapes resolved */
  value: string;
  quoted: QuoteContext;
  range: Range;
}

export interface VariableExpansion {
  type: "VariableExpansion";
  /** e.g. "NAME", "#NAME", "NAME:-default" */
  expression: string;
  braced: boolean;
  quoted: QuoteContext;
  range: Range;
}

export interface CommandSubstitution {
  type: "CommandSubstitution";
  /** $(…) vs `…` */
  backtick: boolean;
  body: Script;
  quoted: QuoteContext;
  range: Range;
}

export interface ArithmeticExpansion {
  type: "ArithmeticExpansion";
  /** raw text between the parens, always present */
  expression: string;
  /** the parsed form, or null if the text does not fit the arithmetic grammar */
  parsed: ArithmeticExpr | null;
  quoted: QuoteContext;
  range: Range;
}

// ── Arithmetic ─────────────────────────────────────────────────────

export interface ArithmeticNumber {
  type: "ArithmeticNumber";
  /** decoded value: handles 0x hex, leading-zero octal and base#digits */
  value: number;
  raw: string;
  range: Range;
}

export interface ArithmeticVariable {
  type: "ArithmeticVariable";
  name: string;
  range: Range;
}

/** A `$…` or backtick expansion used as an operand */
export interface ArithmeticSubstitution {
  type: "ArithmeticSubstitution";
  part: WordPart;
  range: Range;
}

/** `a[i]` — the index is itself an arithmetic expression */
export interface ArithmeticSubscript {
  type: "ArithmeticSubscript";
  name: string;
  index: ArithmeticExpr;
  range: Range;
}

export interface ArithmeticUnary {
  type: "ArithmeticUnary";
  op: "+" | "-" | "!" | "~";
  operand: ArithmeticExpr;
  range: Range;
}

/** `++x` and `x++` — `prefix` says which */
export interface ArithmeticUpdate {
  type: "ArithmeticUpdate";
  op: "++" | "--";
  prefix: boolean;
  operand: ArithmeticExpr;
  range: Range;
}

export interface ArithmeticBinary {
  type: "ArithmeticBinary";
  op: string;
  left: ArithmeticExpr;
  right: ArithmeticExpr;
  range: Range;
}

export interface ArithmeticAssignment {
  type: "ArithmeticAssignment";
  op: string;
  target: ArithmeticVariable | ArithmeticSubscript;
  value: ArithmeticExpr;
  range: Range;
}

export interface ArithmeticConditional {
  type: "ArithmeticConditional";
  condition: ArithmeticExpr;
  then: ArithmeticExpr;
  else: ArithmeticExpr;
  range: Range;
}

export type ArithmeticExpr =
  | ArithmeticNumber
  | ArithmeticVariable
  | ArithmeticSubstitution
  | ArithmeticSubscript
  | ArithmeticUnary
  | ArithmeticUpdate
  | ArithmeticBinary
  | ArithmeticAssignment
  | ArithmeticConditional;

export interface ProcessSubstitution {
  type: "ProcessSubstitution";
  direction: "<" | ">";
  body: Script;
  range: Range;
}

/** A single character listed in a bracket expression */
export interface GlobChar {
  type: "GlobChar";
  value: string;
  range: Range;
}

/** `a-z` inside a bracket expression */
export interface GlobRange {
  type: "GlobRange";
  from: string;
  to: string;
  range: Range;
}

/** A POSIX class, equivalence or collating element: `[:alpha:]`, `[=a=]`, `[.a.]` */
export interface GlobClass {
  type: "GlobClass";
  /** the name without its delimiters, e.g. "alpha" */
  name: string;
  kind: "class" | "equivalence" | "collating";
  range: Range;
}

export type GlobBracketMember = GlobChar | GlobRange | GlobClass;

/** `*` or `?` */
export interface GlobWildcard {
  type: "GlobPattern";
  kind: "wildcard";
  value: "*" | "?";
  range: Range;
}

/** `[abc]`, `[!a-z]`, `[[:digit:]]` */
export interface GlobBracket {
  type: "GlobPattern";
  kind: "bracket";
  /** the pattern as written, brackets included */
  value: string;
  /** `[!…]` or `[^…]` */
  negated: boolean;
  members: GlobBracketMember[];
  range: Range;
}

/**
 * An extended glob: `?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)`. Alternatives are
 * words in their own right, so `@($x|b)` keeps its expansion and `@(a|@(b|c))`
 * nests.
 *
 * In the zsh dialect a group may carry no operator at all — `(a|b)` matches
 * what bash writes as `@(a|b)` — and `op` is then null.
 */
export interface GlobExtended {
  type: "GlobPattern";
  kind: "extended";
  /** the pattern as written, operator and parens included */
  value: string;
  /** null for a bare zsh group, which behaves as `@(…)` */
  op: "?" | "*" | "+" | "@" | "!" | null;
  alternatives: CompoundWord[];
  range: Range;
}

/**
 * zsh only. A numeric range: `<1->` is one and up, `<-9>` is up to nine,
 * `<1-9>` is bounded, and `<->` is any number. An open end is null.
 */
export interface GlobNumericRange {
  type: "GlobPattern";
  kind: "numeric-range";
  /** the pattern as written, angle brackets included */
  value: string;
  min: number | null;
  max: number | null;
  range: Range;
}

/**
 * zsh only. The qualifier group that may close a pattern — `*(.)` for plain
 * files, `*(-/FN)` for a non-empty directory following symlinks. It selects
 * among what the pattern matched rather than matching text itself, so it is
 * kept as written; deciding what it selects needs a filesystem.
 */
export interface GlobQualifier {
  type: "GlobPattern";
  kind: "qualifier";
  /** the group as written, parens included */
  value: string;
  /** the qualifier characters alone, without the parens */
  qualifiers: string;
  range: Range;
}

/** Discriminate on `kind`; every variant keeps `value` as written */
export type GlobPattern =
  | GlobWildcard
  | GlobBracket
  | GlobExtended
  | GlobNumericRange
  | GlobQualifier;

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

/** The (one two three) of an array assignment */
export interface ArrayLiteral {
  type: "ArrayLiteral";
  elements: CompoundWord[];
  range: Range;
}

export interface Assignment {
  type: "Assignment";
  /** the bare variable name, without any subscript */
  name: string;
  /** the `i` of `NAME[i]=value`, which may itself expand; null when absent */
  subscript: CompoundWord | null;
  /** `NAME+=value` appends rather than replaces */
  append: boolean;
  /** null for a bare `VAR=`; discriminate on `value.type` */
  value: CompoundWord | ArrayLiteral | null;
  range: Range;
}

export interface SimpleCommand {
  type: "SimpleCommand";
  /** VAR=val prefixes, which apply to this command's environment */
  assignments: Assignment[];
  /** command name + arguments as compound words */
  name: CompoundWord | null;
  /**
   * Arguments. An `Assignment` appears here only for declaration builtins
   * (`declare`, `export`, …), where the assignment is the argument rather than
   * an environment prefix — discriminate on `arg.type`.
   */
  args: (CompoundWord | Assignment)[];
  redirects: Redirect[];
  range: Range;
}

export interface Pipeline {
  type: "Pipeline";
  /** ! prefix negates exit status */
  negated: boolean;
  commands: Command[];
  /** terminated by & rather than ; or a newline */
  background: boolean;
  range: Range;
}

/** &&, ||, ; ,& ,newline-separated lists */
export interface List {
  type: "List";
  left: ListItem;
  op: "&&" | "||" | ";" | "&";
  right: ListItem;
  /** terminated by & rather than ; or a newline */
  background: boolean;
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
  /**
   * The loop variables. Always one in bash; zsh takes several and deals the
   * words out between them, so `for k v in a b c d` runs twice.
   */
  variables: string[];
  words: CompoundWord[] | null;
  body: Script;
  redirects: Redirect[];
  range: Range;
}

// ── Test expressions ───────────────────────────────────────────────

/** `-f file`, `-z "$x"` — a single-operand test */
export interface TestUnary {
  type: "TestUnary";
  op: string;
  operand: CompoundWord;
  range: Range;
}

/** `$a == b`, `$n -lt 3`, `$s =~ re` — `op` is kept verbatim */
export interface TestBinary {
  type: "TestBinary";
  op: string;
  left: CompoundWord;
  right: CompoundWord;
  /**
   * For `=~`, the right operand parsed as an extended regular expression.
   * Null for every other operator, and when the pattern does not fit the
   * grammar — `right` always holds the operand either way.
   */
  regex: RegexNode | null;
  range: Range;
}

// ── Regular expressions ────────────────────────────────────────────

export interface RegexLiteral {
  type: "RegexLiteral";
  value: string;
  range: Range;
}

/** `.` */
export interface RegexAny {
  type: "RegexAny";
  range: Range;
}

/** `^` or `$` */
export interface RegexAnchor {
  type: "RegexAnchor";
  kind: "start" | "end";
  range: Range;
}

/** `(…)` — capturing, as all ERE groups are */
export interface RegexGroup {
  type: "RegexGroup";
  body: RegexNode;
  range: Range;
}

/** `[…]`, the same bracket syntax globs use */
export interface RegexClass {
  type: "RegexClass";
  negated: boolean;
  members: GlobBracketMember[];
  range: Range;
}

/** `*`, `+`, `?`, `{n,m}` — `max` is null when unbounded */
export interface RegexQuantifier {
  type: "RegexQuantifier";
  operand: RegexNode;
  min: number;
  max: number | null;
  range: Range;
}

/** `a|b` */
export interface RegexAlternation {
  type: "RegexAlternation";
  alternatives: RegexNode[];
  range: Range;
}

/** Concatenation */
export interface RegexSequence {
  type: "RegexSequence";
  items: RegexNode[];
  range: Range;
}

/**
 * A backslash escape POSIX leaves undefined — `\d`, `\n`, `\q`. ERE has no
 * C-style escapes, so these are not what they look like; matchers generally
 * fall back to the bare character. Escapes with a defined meaning become a
 * `RegexLiteral`, `RegexBackreference`, `RegexShorthand` or `RegexBoundary`.
 */
export interface RegexEscape {
  type: "RegexEscape";
  char: string;
  range: Range;
}

/**
 * `\1`–`\9`. A GNU extension: POSIX ERE has no backreferences, and BSD or
 * macOS libc will not match one.
 */
export interface RegexBackreference {
  type: "RegexBackreference";
  group: number;
  range: Range;
}

/**
 * `\w`, `\W`, `\s`, `\S` — GNU shorthand for a character class, unsupported on
 * BSD and macOS. `equivalent` gives the portable spelling.
 */
export interface RegexShorthand {
  type: "RegexShorthand";
  char: string;
  negated: boolean;
  /** the bracket expression this stands for, e.g. `[[:alnum:]_]` for `\w` */
  equivalent: string;
  range: Range;
}

/**
 * A zero-width position assertion: `\b`, `\B`, `\<`, `\>`, `` \` ``, `\'`.
 * Also GNU extensions.
 */
export interface RegexBoundary {
  type: "RegexBoundary";
  kind: "word" | "notWord" | "wordStart" | "wordEnd" | "bufferStart" | "bufferEnd";
  range: Range;
}

/** An expansion supplying part of the pattern at runtime */
export interface RegexExpansion {
  type: "RegexExpansion";
  part: WordPart;
  range: Range;
}

export type RegexNode =
  | RegexLiteral
  | RegexAny
  | RegexAnchor
  | RegexGroup
  | RegexClass
  | RegexQuantifier
  | RegexAlternation
  | RegexSequence
  | RegexEscape
  | RegexBackreference
  | RegexShorthand
  | RegexBoundary
  | RegexExpansion;

/**
 * `&&` and `||` come from `[[ … ]]`; `-a` and `-o` from `[ … ]` and `test`,
 * where the shell would treat `&&` as a command separator. Kept verbatim
 * rather than normalised, since the two forms differ in evaluation.
 */
export interface TestLogical {
  type: "TestLogical";
  op: "&&" | "||" | "-a" | "-o";
  left: TestExpr;
  right: TestExpr;
  range: Range;
}

export interface TestNegation {
  type: "TestNegation";
  operand: TestExpr;
  range: Range;
}

/** A bare word tested for being non-empty, as in `[[ $x ]]` */
export interface TestValue {
  type: "TestValue";
  word: CompoundWord;
  range: Range;
}

export type TestExpr = TestUnary | TestBinary | TestLogical | TestNegation | TestValue;

/**
 * A conditional: the `[[ … ]]` keyword, or the `[ … ]` / `test` builtin.
 *
 * `style` matters — the keyword form suppresses word splitting and globbing on
 * its operands and joins with `&&`, while the builtin is an ordinary command
 * whose operands expand and which joins with `-a`. `expression` is null when
 * there are no operands.
 */
export interface TestCommand {
  type: "TestCommand";
  style: "[[" | "[" | "test";
  expression: TestExpr | null;
  /** VAR=val prefixes; only reachable on the builtin form */
  assignments: Assignment[];
  redirects: Redirect[];
  range: Range;
}

/** One argument of `let`, which the shell evaluates as arithmetic */
export interface LetExpression {
  /** the argument with any wrapping quotes removed */
  text: string;
  parsed: ArithmeticExpr | null;
  range: Range;
}

/**
 * `let a=1 b++` — the same evaluation as `(( … ))`, spelled as a builtin and
 * taking any number of expressions.
 */
export interface LetCommand {
  type: "LetCommand";
  /** VAR=val prefixes, as on any command */
  assignments: Assignment[];
  expressions: LetExpression[];
  redirects: Redirect[];
  range: Range;
}

/** `(( expr ))` as a command — succeeds when the value is non-zero */
export interface ArithmeticCommand {
  type: "ArithmeticCommand";
  expression: string;
  parsed: ArithmeticExpr | null;
  redirects: Redirect[];
  range: Range;
}

/** `for (( init; condition; update ))` — any clause may be empty */
export interface ArithmeticForClause {
  type: "ArithmeticForClause";
  init: ArithmeticExpr | null;
  condition: ArithmeticExpr | null;
  update: ArithmeticExpr | null;
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

/** zsh only. `repeat 3 do … done` runs the body a counted number of times. */
export interface RepeatClause {
  type: "RepeatClause";
  /** how many times, as a word — it is expanded, so it need not be a literal */
  count: CompoundWord;
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
  /**
   * `;;` ends the case, `;&` falls through to the next body, and `;;&` goes on
   * testing later patterns. Null when the last item omits it before `esac`.
   */
  terminator: ";;" | ";&" | ";;&" | null;
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
  /** null for a zsh anonymous function, `function { … }`, which runs at once */
  name: string | null;
  body: Command;
  /** words passed to an anonymous function; empty for a named one */
  args: CompoundWord[];
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
  | ArithmeticForClause
  | WhileClause
  | UntilClause
  | RepeatClause
  | CaseClause
  | ArithmeticCommand
  | Subshell
  | BraceGroup;

export type Command =
  | SimpleCommand
  | LetCommand
  | TestCommand
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
