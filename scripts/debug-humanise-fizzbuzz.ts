/**
 * Iterative probe for turning the parsed FizzBuzz AST into plain English.
 *
 * Run with:
 *   bun scripts/debug-humanise-fizzbuzz.ts
 */
import {
  parseShell,
  type ArithmeticExpr,
  type Assignment,
  type Command,
  type CompoundWord,
  type IfClause,
  type Script,
  type SimpleCommand,
  type VariableExpansion,
} from "../index.ts";

const requestedPath = Bun.argv.find((arg) => !arg.startsWith("-") && arg.endsWith(".sh"));
const fixtureUrl = requestedPath
  ? new URL(requestedPath, `file://${process.cwd()}/`)
  : new URL("../fixtures/fizzbuzz.sh", import.meta.url);
const source = await Bun.file(fixtureUrl).text();
const verbose = Bun.argv.includes("--verbose");

if (verbose) {
  console.log("--- input ---");
  console.log({
    fixture: fixtureUrl.pathname,
    type: typeof source,
    characters: source.length,
    lines: source.split("\n").length,
  });
  console.log(source);
}

const startedAt = performance.now();
const ast = parseShell(source, { dialect: "bash" });

if (verbose) {
  console.log("--- parsed shape ---");
  console.log({
    type: ast.type,
    keys: Object.keys(ast),
    topLevelCommands: ast.commands.length,
    comments: ast.comments.length,
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
  });

  console.log("--- full AST ---");
  console.dir(ast, { depth: null, colors: false });
}

function code(value: string): string {
  return `\`${value}\``;
}

function commandName(command: SimpleCommand): string | null {
  if (!command.name || command.name.parts.length !== 1) return null;
  const [part] = command.name.parts;
  return part?.type === "Word" ? part.value : null;
}

function plainWord(word: CompoundWord): string | null {
  let result = "";
  for (const part of word.parts) {
    if (part.type !== "Word") return null;
    result += part.value;
  }
  return result;
}

function describeExpansion(expansion: VariableExpansion): string {
  const defaulted = /^(\d+):-([\s\S]*)$/.exec(expansion.expression);
  if (defaulted) {
    const position = Number(defaulted[1]);
    const ordinal = position === 1 ? "first" : `number ${position}`;
    return `the ${ordinal} command-line argument, or ${code(defaulted[2]!)} if it is missing or empty`;
  }

  return `the value of ${code(expansion.expression)}`;
}

function describeWord(word: CompoundWord): string {
  if (word.parts.length === 1 && word.parts[0]?.type === "VariableExpansion") {
    return describeExpansion(word.parts[0]);
  }

  const literal = plainWord(word);
  if (literal !== null) return code(literal);

  return word.parts
    .map((part) => {
      switch (part.type) {
        case "Word":
          return part.value;
        case "VariableExpansion":
          return describeExpansion(part);
        case "ArithmeticExpansion":
          return part.parsed ? describeArithmetic(part.parsed) : code(part.expression);
        case "CommandSubstitution":
          return "the output of a nested command";
        case "ProcessSubstitution":
          return "a substituted process";
        case "BraceExpansion":
        case "GlobPattern":
          return code(part.value);
      }
    })
    .join("");
}

function describeTarget(expression: ArithmeticExpr): string {
  if (expression.type === "ArithmeticVariable") return code(expression.name);
  if (expression.type === "ArithmeticSubscript") {
    return `${code(expression.name)} at index ${describeArithmetic(expression.index)}`;
  }
  return describeArithmetic(expression);
}

function describeArithmetic(expression: ArithmeticExpr): string {
  switch (expression.type) {
    case "ArithmeticNumber":
      return expression.raw;
    case "ArithmeticVariable":
      return code(expression.name);
    case "ArithmeticSubstitution":
      return "a substituted value";
    case "ArithmeticSubscript":
      return describeTarget(expression);
    case "ArithmeticUnary": {
      const operation = { "!": "not ", "~": "the bitwise inverse of ", "+": "positive ", "-": "negative " }[expression.op];
      return `${operation}${describeArithmetic(expression.operand)}`;
    }
    case "ArithmeticUpdate": {
      const direction = expression.op === "++" ? "increase" : "decrease";
      return `${direction} ${describeTarget(expression.operand)} by 1`;
    }
    case "ArithmeticAssignment": {
      if (expression.op === "=") {
        return `set ${describeTarget(expression.target)} to ${describeArithmetic(expression.value)}`;
      }
      return `update ${describeTarget(expression.target)} using ${code(expression.op)} and ${describeArithmetic(expression.value)}`;
    }
    case "ArithmeticConditional":
      return `if ${describeArithmetic(expression.condition)}, use ${describeArithmetic(expression.then)}; otherwise use ${describeArithmetic(expression.else)}`;
    case "ArithmeticBinary": {
      if (
        expression.op === "==" &&
        expression.left.type === "ArithmeticBinary" &&
        expression.left.op === "%" &&
        expression.right.type === "ArithmeticNumber" &&
        expression.right.value === 0
      ) {
        return `${describeArithmetic(expression.left.left)} is divisible by ${describeArithmetic(expression.left.right)}`;
      }

      const operation = {
        "<=": "is less than or equal to",
        "<": "is less than",
        ">=": "is greater than or equal to",
        ">": "is greater than",
        "==": "equals",
        "!=": "does not equal",
        "%": "modulo",
        "+": "plus",
        "-": "minus",
        "*": "multiplied by",
        "/": "divided by",
        "&&": "and",
        "||": "or",
      }[expression.op] ?? code(expression.op);
      return `${describeArithmetic(expression.left)} ${operation} ${describeArithmetic(expression.right)}`;
    }
  }
}

function describeAssignment(assignment: Assignment): string {
  const action = assignment.append ? "Append to" : "Set";
  if (!assignment.value) return `${action} ${code(assignment.name)} to an empty value.`;
  if (assignment.value.type === "ArrayLiteral") {
    return `${action} ${code(assignment.name)} to a list of ${assignment.value.elements.map(describeWord).join(", ")}.`;
  }
  return `${action} ${code(assignment.name)} to ${describeWord(assignment.value)}.`;
}

function describeEcho(command: SimpleCommand): string {
  const [first, ...rest] = command.args;
  if (!first || first.type !== "CompoundWord") return "Print a blank line.";

  if (first.parts.length === 1 && first.parts[0]?.type === "VariableExpansion") {
    return `Print ${describeExpansion(first.parts[0])}.`;
  }

  const values = [first, ...rest]
    .filter((arg): arg is CompoundWord => arg.type === "CompoundWord")
    .map(describeWord);
  return `Print ${values.join(" followed by ")}.`;
}

function describeSimpleCommand(command: SimpleCommand): string[] {
  if (!command.name) return command.assignments.map(describeAssignment);

  const name = commandName(command);
  const args = command.args
    .filter((arg): arg is CompoundWord => arg.type === "CompoundWord")
    .map(plainWord);

  if (name === "set" && args[0] === "-euo" && args[1] === "pipefail") {
    return ["Enable strict shell behaviour: stop on errors, reject unset variables, and fail a pipeline if any command fails."];
  }
  if (name === "echo") return [describeEcho(command)];

  return [`Run ${code(name ?? "a command")} with ${command.args.map((arg) => arg.type === "Assignment" ? code(arg.name) : describeWord(arg)).join(", ")}.`];
}

function unwrapSinglePipeline(command: Command): Command {
  if (command.type === "Pipeline" && command.commands.length === 1 && !command.negated && !command.background && !command.timed) {
    return command.commands[0]!;
  }
  return command;
}

function describeCondition(script: Script): string {
  if (script.commands.length !== 1) return "all of the listed conditions hold";
  const command = unwrapSinglePipeline(script.commands[0]!);
  if (command.type === "ArithmeticCommand" && command.parsed) return describeArithmetic(command.parsed);
  return "the condition succeeds";
}

function describeIf(command: IfClause, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const nestedPad = "  ".repeat(depth + 1);
  const lines = [`${pad}- If ${describeCondition(command.condition)}:`];
  lines.push(...describeScript(command.then, depth + 1));

  for (const branch of command.elifs) {
    lines.push(`${pad}- Otherwise, if ${describeCondition(branch.condition)}:`);
    lines.push(...describeScript(branch.then, depth + 1));
  }

  if (command.else) {
    lines.push(`${pad}- Otherwise:`);
    lines.push(...describeScript(command.else, depth + 1));
  }

  if (lines.length === 1) lines.push(`${nestedPad}- Do nothing.`);
  return lines;
}

function describeCommand(command: Command, depth: number): string[] {
  const actual = unwrapSinglePipeline(command);
  const pad = "  ".repeat(depth);

  switch (actual.type) {
    case "SimpleCommand":
      return describeSimpleCommand(actual).map((line) => `${pad}${depth > 0 ? "- " : ""}${line}`);
    case "ArithmeticForClause": {
      const init = actual.init ? describeArithmetic(actual.init) : "do no setup";
      const condition = actual.condition ? describeArithmetic(actual.condition) : "continue forever";
      const update = actual.update ? describeArithmetic(actual.update) : "make no update";
      return [
        `${pad}Repeat a loop: ${init}; continue while ${condition}; after each pass, ${update}.`,
        ...describeScript(actual.body, depth + 1),
      ];
    }
    case "IfClause":
      return describeIf(actual, depth);
    case "ArithmeticCommand":
      return [`${pad}Check whether ${actual.parsed ? describeArithmetic(actual.parsed) : code(actual.expression)}.`];
    case "Pipeline":
      return [`${pad}Run a pipeline of ${actual.commands.length} commands.`];
    default:
      return [`${pad}[Unsupported AST node: ${actual.type}]`];
  }
}

function describeScript(script: Script, depth = 0): string[] {
  return script.commands.flatMap((command) => describeCommand(command, depth));
}

const topLevelExplanation = ast.commands.map((command) => describeCommand(command, 0));
const renderedExplanation = topLevelExplanation
  .map(([first, ...rest], index) => [
    `${index + 1}. ${first}`,
    ...rest.map((line) => `   ${line}`),
  ].join("\n"))
  .join("\n");

console.log("--- English explanation ---");
console.log("This Bash script does the following:");
console.log(renderedExplanation);

if (Bun.argv.includes("--check")) {
  const requiredMeanings = [
    "stop on errors, reject unset variables, and fail a pipeline if any command fails",
    "the first command-line argument, or `100` if it is missing or empty",
    "set `i` to 1",
    "`i` is less than or equal to `limit`",
    "increase `i` by 1",
    "`i` is divisible by 15",
    "Print `FizzBuzz`",
    "`i` is divisible by 3",
    "Print `Fizz`",
    "`i` is divisible by 5",
    "Print `Buzz`",
    "Print the value of `i`",
  ];

  const missing = requiredMeanings.filter((meaning) => !renderedExplanation.includes(meaning));
  if (topLevelExplanation.length !== 3) {
    throw new Error(`Expected 3 top-level actions, got ${topLevelExplanation.length}`);
  }
  if (missing.length > 0) {
    throw new Error(`Missing meanings: ${missing.join(", ")}`);
  }
  if (renderedExplanation.includes("[Unsupported AST node:")) {
    throw new Error("The explanation contains an unsupported AST node fallback");
  }

  console.log("--- checks ---");
  console.log(`passed: 3 top-level actions and ${requiredMeanings.length} required meanings`);
}
