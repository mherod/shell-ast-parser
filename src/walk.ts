import type {
  Script,
  Comment,
  SimpleCommand,
  Pipeline,
  List,
  Subshell,
  BraceGroup,
  ElifBranch,
  IfClause,
  ForClause,
  ArithmeticForClause,
  SelectClause,
  WhileClause,
  UntilClause,
  RepeatClause,
  CaseItem,
  CaseClause,
  FunctionDef,
  Coproc,
  LetCommand,
  LetExpression,
  TestCommand,
  ArithmeticCommand,
  CompoundWord,
  Assignment,
  ArrayLiteral,
  Redirect,
  HereDoc,
  Word,
  VariableExpansion,
  CommandSubstitution,
  ArithmeticExpansion,
  ProcessSubstitution,
  ArithmeticNumber,
  ArithmeticVariable,
  ArithmeticSubstitution,
  ArithmeticSubscript,
  ArithmeticUnary,
  ArithmeticUpdate,
  ArithmeticBinary,
  ArithmeticAssignment,
  ArithmeticConditional,
  GlobChar,
  GlobRange,
  GlobClass,
  GlobWildcard,
  GlobBracket,
  GlobExtended,
  GlobNumericRange,
  GlobQualifier,
  BraceList,
  BraceSequence,
  TestUnary,
  TestBinary,
  TestLogical,
  TestNegation,
  TestValue,
  RegexLiteral,
  RegexAny,
  RegexAnchor,
  RegexGroup,
  RegexClass,
  RegexQuantifier,
  RegexAlternation,
  RegexSequence,
  RegexEscape,
  RegexBackreference,
  RegexShorthand,
  RegexBoundary,
  RegexExpansion,
} from "./ast.ts";

export interface AstNodeMap {
  Script: Script;
  Comment: Comment;
  SimpleCommand: SimpleCommand;
  Pipeline: Pipeline;
  List: List;
  Subshell: Subshell;
  BraceGroup: BraceGroup;
  ElifBranch: ElifBranch;
  IfClause: IfClause;
  ForClause: ForClause;
  ArithmeticForClause: ArithmeticForClause;
  SelectClause: SelectClause;
  WhileClause: WhileClause;
  UntilClause: UntilClause;
  RepeatClause: RepeatClause;
  CaseItem: CaseItem;
  CaseClause: CaseClause;
  FunctionDef: FunctionDef;
  Coproc: Coproc;
  LetCommand: LetCommand;
  LetExpression: LetExpression;
  TestCommand: TestCommand;
  ArithmeticCommand: ArithmeticCommand;
  CompoundWord: CompoundWord;
  Assignment: Assignment;
  ArrayLiteral: ArrayLiteral;
  Redirect: Redirect;
  HereDoc: HereDoc;
  Word: Word;
  VariableExpansion: VariableExpansion;
  CommandSubstitution: CommandSubstitution;
  ArithmeticExpansion: ArithmeticExpansion;
  ProcessSubstitution: ProcessSubstitution;
  ArithmeticNumber: ArithmeticNumber;
  ArithmeticVariable: ArithmeticVariable;
  ArithmeticSubstitution: ArithmeticSubstitution;
  ArithmeticSubscript: ArithmeticSubscript;
  ArithmeticUnary: ArithmeticUnary;
  ArithmeticUpdate: ArithmeticUpdate;
  ArithmeticBinary: ArithmeticBinary;
  ArithmeticAssignment: ArithmeticAssignment;
  ArithmeticConditional: ArithmeticConditional;
  GlobChar: GlobChar;
  GlobRange: GlobRange;
  GlobClass: GlobClass;
  GlobWildcard: GlobWildcard;
  GlobBracket: GlobBracket;
  GlobExtended: GlobExtended;
  GlobNumericRange: GlobNumericRange;
  GlobQualifier: GlobQualifier;
  BraceList: BraceList;
  BraceSequence: BraceSequence;
  TestUnary: TestUnary;
  TestBinary: TestBinary;
  TestLogical: TestLogical;
  TestNegation: TestNegation;
  TestValue: TestValue;
  RegexLiteral: RegexLiteral;
  RegexAny: RegexAny;
  RegexAnchor: RegexAnchor;
  RegexGroup: RegexGroup;
  RegexClass: RegexClass;
  RegexQuantifier: RegexQuantifier;
  RegexAlternation: RegexAlternation;
  RegexSequence: RegexSequence;
  RegexEscape: RegexEscape;
  RegexBackreference: RegexBackreference;
  RegexShorthand: RegexShorthand;
  RegexBoundary: RegexBoundary;
  RegexExpansion: RegexExpansion;
}

export type AstNodeType = keyof AstNodeMap;
export type AstNode = AstNodeMap[AstNodeType];

export const SKIP = Symbol("SKIP");
export const EXIT = Symbol("EXIT");

export type VisitorResult = void | undefined | typeof SKIP | typeof EXIT | "skip" | "exit" | boolean;

export type Visitor = (
  node: AstNode,
  parent: unknown,
  key: string | number | undefined,
) => VisitorResult;

export function isAstNode(value: unknown): value is AstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    !Array.isArray(value)
  );
}

export function isNodeType<K extends keyof AstNodeMap>(
  value: unknown,
  type: K,
): value is AstNodeMap[K] {
  return isAstNode(value) && value.type === type;
}

/**
 * Depth-first pre-order traversal across an AST.
 *
 * Automatically skips `range` properties. Returns `EXIT` (or `false`) if aborted early.
 */
export function visit(node: unknown, visitor: Visitor): VisitorResult {
  function walk(
    current: unknown,
    parent: unknown,
    key: string | number | undefined,
  ): VisitorResult {
    if (current === null || typeof current !== "object") return;

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const res = walk(current[i], parent, i);
        if (res === EXIT || res === "exit" || res === false) return EXIT;
      }
      return;
    }

    if (isAstNode(current)) {
      const res = visitor(current, parent, key);
      if (res === EXIT || res === "exit" || res === false) return EXIT;
      if (res === SKIP || res === "skip") return;
    }

    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      if (k === "range") continue;
      const res = walk(v, current, k);
      if (res === EXIT || res === "exit" || res === false) return EXIT;
    }
  }

  return walk(node, null, undefined);
}

/**
 * Find all AST nodes of a given type.
 */
export function findAll<K extends keyof AstNodeMap>(node: unknown, type: K): AstNodeMap[K][];
export function findAll<T extends { type: string } = AstNode>(node: unknown, type: string): T[];
export function findAll(node: unknown, type: string): any[] {
  const results: any[] = [];
  visit(node, (n) => {
    if (n.type === type) results.push(n);
  });
  return results;
}

/**
 * Find the first AST node of a given type, stopping traversal as soon as found.
 */
export function firstOf<K extends keyof AstNodeMap>(node: unknown, type: K): AstNodeMap[K] | null;
export function firstOf<T extends { type: string } = AstNode>(node: unknown, type: string): T | null;
export function firstOf(node: unknown, type: string): any | null {
  let found: any | null = null;
  visit(node, (n) => {
    if (n.type === type) {
      found = n;
      return EXIT;
    }
  });
  return found;
}
