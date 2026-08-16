/**
 * Iterative probe for turning parsed fixture ASTs into plain English.
 *
 * Run with:
 *   bun scripts/debug-humanise-fizzbuzz.ts
 *   bun scripts/debug-humanise-fizzbuzz.ts fixtures/sort-numbers.sh
 *   bun scripts/debug-humanise-fizzbuzz.ts fixtures/word-frequency.sh --check
 */
import {
  parseShell,
  type ArithmeticExpr,
  type Assignment,
  type Command,
  type CompoundWord,
  type IfClause,
  type List,
  type Pipeline,
  type Script,
  type SimpleCommand,
  type TestExpr,
  type WhileClause,
  type VariableExpansion,
} from "../index.ts";

const requestedPath = Bun.argv.find((arg) => !arg.startsWith("-") && arg.endsWith(".sh"));
const fixtureUrl = requestedPath
  ? new URL(requestedPath, `file://${process.cwd()}/`)
  : new URL("../fixtures/fizzbuzz.sh", import.meta.url);
const source = await Bun.file(fixtureUrl).text();
const verbose = Bun.argv.includes("--verbose");
const fixtureName = fixtureUrl.pathname.split("/").at(-1) ?? fixtureUrl.pathname;

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

function ordinal(position: number): string {
  if (position === 1) return "first";
  if (position === 2) return "second";
  if (position === 3) return "third";
  return `number ${position}`;
}

function describeIndex(index: string): string {
  return code(index.replace(/\s*\+\s*/g, " plus ").replace(/\s*-\s*/g, " minus "));
}

function describeExpansion(expansion: VariableExpansion): string {
  const defaulted = /^(\d+):-([\s\S]*)$/.exec(expansion.expression);
  if (defaulted) {
    const position = Number(defaulted[1]);
    const fallback = defaulted[2] === "" ? "an empty value" : code(defaulted[2]!);
    return `the ${ordinal(position)} command-line argument, or ${fallback} if it is missing or empty`;
  }

  if (expansion.expression === "#") return "the number of command-line arguments";
  if (expansion.expression === "@") return "all command-line arguments";

  const positional = /^(\d+)$/.exec(expansion.expression);
  if (positional) return `the ${ordinal(Number(positional[1]))} command-line argument`;

  const arrayLength = /^#([a-zA-Z_][a-zA-Z0-9_]*)\[@\]$/.exec(expansion.expression);
  if (arrayLength) return `the number of values in ${code(arrayLength[1]!)}`;

  const allArrayValues = /^([a-zA-Z_][a-zA-Z0-9_]*)\[@\]$/.exec(expansion.expression);
  if (allArrayValues) return `all values in ${code(allArrayValues[1]!)}`;

  const arrayValue = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([\s\S]+)\]$/.exec(expansion.expression);
  if (arrayValue) return `the value in ${code(arrayValue[1]!)} at index ${describeIndex(arrayValue[2]!)}`;

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
    const index = describeArithmetic(expression.index);
    return `the value in ${code(expression.name)} at index ${expression.index.type === "ArithmeticBinary" ? `(${index})` : index}`;
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
      return expression.part.type === "VariableExpansion"
        ? describeExpansion(expression.part)
        : "a substituted value";
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
  const target = assignment.subscript
    ? `the value in ${code(assignment.name)} at index ${describeIndex(plainWord(assignment.subscript) ?? "an expression")}`
    : code(assignment.name);

  if (!assignment.value) return `Set ${target} to an empty value.`;
  if (assignment.value.type === "ArrayLiteral") {
    if (assignment.value.elements.length === 0) return `Set ${target} to an empty list.`;
    const [only] = assignment.value.elements;
    if (
      only &&
      only.parts.length === 1 &&
      only.parts[0]?.type === "VariableExpansion" &&
      only.parts[0].expression === "@"
    ) {
      return `${assignment.append ? "Append" : "Set"} ${assignment.append ? "all command-line arguments to" : target + " to a list containing"} all command-line arguments.`;
    }
    const values = assignment.value.elements.map(describeWord).join(", ");
    return assignment.append
      ? `Append ${values} to ${target}.`
      : `Set ${target} to a list containing ${values}.`;
  }
  return `${assignment.append ? "Append" : "Set"} ${assignment.append ? describeWord(assignment.value) + " to " + target : target + " to " + describeWord(assignment.value)}.`;
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
  const words = command.args.filter((arg): arg is CompoundWord => arg.type === "CompoundWord");
  const args = words.map(plainWord);

  if (name === "set" && args[0] === "-euo" && args[1] === "pipefail") {
    return ["Enable strict shell behaviour: stop on errors, reject unset variables, and fail a pipeline if any command fails."];
  }
  if (name === "echo") return [describeEcho(command)];
  if (name === "cat") {
    return words.length === 0
      ? ["Copy standard input to standard output."]
      : [`Output the contents of ${describeWord(words[0]!)}.`];
  }
  if (name === "printf" && args[0] === "%s\\n" && words[1]) {
    return [`Print ${describeWord(words[1])}, one value per line.`];
  }
  if (name === "printf" && args[0] === "%-20s %s\\n" && words[1] && words[2]) {
    return [`Print ${describeWord(words[1])} left-aligned in a 20-character field, followed by ${describeWord(words[2])}.`];
  }
  if (name === "read") {
    const targets = words
      .map(plainWord)
      .filter((arg): arg is string => arg !== null && !arg.startsWith("-"));
    return [`Read fields from standard input into ${targets.map(code).join(" and ")}, without interpreting backslashes.`];
  }

  return [`Run ${code(name ?? "a command")} with ${command.args.map((arg) => arg.type === "Assignment" ? code(arg.name) : describeWord(arg)).join(", ")}.`];
}

function unwrapSinglePipeline(command: Command): Command {
  if (command.type === "Pipeline" && command.commands.length === 1 && !command.negated && !command.background && !command.timed) {
    return command.commands[0]!;
  }
  return command;
}

function describeTest(expression: TestExpr): string {
  switch (expression.type) {
    case "TestUnary": {
      const [onlyPart] = expression.operand.parts;
      if (
        expression.op === "-n" &&
        expression.operand.parts.length === 1 &&
        onlyPart?.type === "VariableExpansion" &&
        /^\d+:-$/.test(onlyPart.expression)
      ) {
        return `${describeExpansion({ ...onlyPart, expression: onlyPart.expression.slice(0, -2) })} is not empty`;
      }
      const operation = {
        "-n": "is not empty",
        "-z": "is empty",
        "-f": "is a regular file",
        "-d": "is a directory",
        "-r": "is readable",
        "-w": "is writable",
        "-x": "is executable",
      }[expression.op] ?? `satisfies ${code(expression.op)}`;
      return `${describeWord(expression.operand)} ${operation}`;
    }
    case "TestBinary": {
      const operation = {
        "=": "equals",
        "==": "matches",
        "!=": "does not equal",
        "-eq": "equals",
        "-ne": "does not equal",
        "-lt": "is less than",
        "-le": "is less than or equal to",
        "-gt": "is greater than",
        "-ge": "is greater than or equal to",
      }[expression.op] ?? code(expression.op);
      return `${describeWord(expression.left)} ${operation} ${describeWord(expression.right)}`;
    }
    case "TestLogical": {
      const operation = expression.op === "&&" || expression.op === "-a" ? "and" : "or";
      return `${describeTest(expression.left)} ${operation} ${describeTest(expression.right)}`;
    }
    case "TestNegation":
      return `not (${describeTest(expression.operand)})`;
    case "TestValue":
      return `${describeWord(expression.word)} is not empty`;
  }
}

function describeConditionCommand(command: Command): string {
  const actual = unwrapSinglePipeline(command);
  if (actual.type === "ArithmeticCommand" && actual.parsed) return describeArithmetic(actual.parsed);
  if (actual.type === "TestCommand" && actual.expression) return describeTest(actual.expression);
  if (actual.type === "List") {
    const join = actual.op === "&&" ? "and" : actual.op === "||" ? "or" : "then";
    return `${describeConditionCommand(actual.left)} ${join} ${describeConditionCommand(actual.right)}`;
  }
  if (actual.type === "SimpleCommand") {
    const [description] = describeSimpleCommand(actual);
    return description?.replace(/\.$/, "").replace(/^Read /, "it can read ") ?? "the command succeeds";
  }
  return "the condition succeeds";
}

function describeCondition(script: Script): string {
  if (script.commands.length !== 1) return "all of the listed conditions hold";
  return describeConditionCommand(script.commands[0]!);
}

function describeIf(command: IfClause, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const nestedPad = "  ".repeat(depth + 1);
  const bullet = depth > 0 ? "- " : "";
  const lines = [`${pad}${bullet}If ${describeCondition(command.condition)}:`];
  lines.push(...describeScript(command.then, depth + 1));

  for (const branch of command.elifs) {
    lines.push(`${pad}${bullet}Otherwise, if ${describeCondition(branch.condition)}:`);
    lines.push(...describeScript(branch.then, depth + 1));
  }

  if (command.else) {
    lines.push(`${pad}${bullet}Otherwise:`);
    lines.push(...describeScript(command.else, depth + 1));
  }

  if (lines.length === 1) lines.push(`${nestedPad}- Do nothing.`);
  return lines;
}

function describeWhile(command: WhileClause, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const bullet = depth > 0 ? "- " : "";
  const condition = unwrapSinglePipeline(command.condition.commands[0]!);

  if (condition.type === "SimpleCommand" && commandName(condition) === "read") {
    const words = condition.args.filter((arg): arg is CompoundWord => arg.type === "CompoundWord");
    const targets = words
      .map(plainWord)
      .filter((arg): arg is string => arg !== null && !arg.startsWith("-"));
    const opening = targets.length === 1
      ? `Read standard input one line at a time into ${code(targets[0]!)}, without interpreting backslashes:`
      : `For each incoming line, read its fields into ${targets.map(code).join(" and ")}, without interpreting backslashes:`;
    return [`${pad}${bullet}${opening}`, ...describeScript(command.body, depth + 1)];
  }

  return [
    `${pad}${bullet}While ${describeCondition(command.condition)}:`,
    ...describeScript(command.body, depth + 1),
  ];
}

function describeList(command: List, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const bullet = depth > 0 ? "- " : "";
  if (command.op === "&&" || command.op === "||") {
    const join = command.op === "&&" ? "If" : "Unless";
    return [
      `${pad}${bullet}${join} ${describeConditionCommand(command.left)}:`,
      ...describeCommand(command.right, depth + 1),
    ];
  }
  return [
    ...describeCommand(command.left, depth),
    ...describeCommand(command.right, depth),
  ];
}

function describePipelineStage(command: Command, depth: number): string[] {
  const actual = unwrapSinglePipeline(command);
  const pad = "  ".repeat(depth);

  if (actual.type === "WhileClause") return describeWhile(actual, depth);
  if (actual.type !== "SimpleCommand") return describeCommand(actual, depth);

  const name = commandName(actual);
  const words = actual.args.filter((arg): arg is CompoundWord => arg.type === "CompoundWord");
  const args = words.map(plainWord);
  let description: string | null = null;

  if (name === "input" && words[0]) {
    description = `Call ${code("input")} with ${describeWord(words[0])}.`;
  } else if (name === "tr" && args[0] === "[:upper:]" && args[1] === "[:lower:]") {
    description = "Convert uppercase letters to lowercase.";
  } else if (name === "tr" && args[0] === "-cs" && args[1] === "[:alnum:]" && args[2] === "\\n") {
    description = "Split the text into one alphanumeric word per line.";
  } else if (name === "grep" && args[0] === "-v" && args[1] === "^$") {
    description = "Remove empty lines.";
  } else if (name === "sort" && args.length === 0) {
    description = "Sort the words alphabetically so identical words are adjacent.";
  } else if (name === "uniq" && args[0] === "-c") {
    description = "Count each run of identical words.";
  } else if (name === "sort" && args[0] === "-rn") {
    description = "Sort the counts numerically from highest to lowest.";
  } else if (name === "head" && args[0] === "-n" && words[1]) {
    const count = describeWord(words[1]).replace(/^the value of /, "");
    description = `Keep only the first ${count} results.`;
  }

  if (description) return [`${pad}- ${description}`];
  return describeSimpleCommand(actual).map((line) => `${pad}- ${line}`);
}

function describePipeline(command: Pipeline, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const bullet = depth > 0 ? "- " : "";
  return [
    `${pad}${bullet}Process data through a pipeline:`,
    ...command.commands.flatMap((stage) => describePipelineStage(stage, depth + 1)),
  ];
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
        `${pad}${depth > 0 ? "- " : ""}Repeat a loop: ${init}; continue while ${condition}; after each pass, ${update}.`,
        ...describeScript(actual.body, depth + 1),
      ];
    }
    case "IfClause":
      return describeIf(actual, depth);
    case "WhileClause":
      return describeWhile(actual, depth);
    case "List":
      return describeList(actual, depth);
    case "FunctionDef":
      return [
        `${pad}${depth > 0 ? "- " : ""}Define a function named ${code(actual.name ?? "anonymous")}:`,
        ...describeCommand(actual.body, depth + 1),
      ];
    case "BraceGroup":
      return describeScript(actual.body, depth);
    case "TestCommand":
      return [`${pad}${depth > 0 ? "- " : ""}Check whether ${actual.expression ? describeTest(actual.expression) : "the test succeeds"}.`];
    case "ArithmeticCommand":
      return [`${pad}Check whether ${actual.parsed ? describeArithmetic(actual.parsed) : code(actual.expression)}.`];
    case "Pipeline":
      return describePipeline(actual, depth);
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
console.log(`${fixtureName} does the following:`);
console.log(renderedExplanation);

if (Bun.argv.includes("--check")) {
  const checks: Record<string, { topLevelActions: number; requiredMeanings: string[] }> = {
    "fizzbuzz.sh": {
      topLevelActions: 3,
      requiredMeanings: [
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
      ],
    },
    "sort-numbers.sh": {
      topLevelActions: 5,
      requiredMeanings: [
        "the number of command-line arguments is greater than 0",
        "a list containing all command-line arguments",
        "Set `nums` to an empty list",
        "Read standard input one line at a time into `line`",
        "the value of `line` is not empty",
        "Append the value of `line` to `nums`",
        "the number of values in `nums`",
        "the value in `nums` at index `j plus 1`",
        "Print all values in `nums`, one value per line",
      ],
    },
    "word-frequency.sh": {
      topLevelActions: 4,
      requiredMeanings: [
        "the second command-line argument, or `10` if it is missing or empty",
        "Define a function named `input`",
        "the number of command-line arguments is greater than 0",
        "the first command-line argument, or an empty value if it is missing or empty",
        "Convert uppercase letters to lowercase",
        "Split the text into one alphanumeric word per line",
        "Count each run of identical words",
        "Sort the counts numerically from highest to lowest",
        "Keep only the first `top` results",
        "Print the value of `word` left-aligned in a 20-character field",
      ],
    },
  };

  const check = checks[fixtureName];
  if (!check) throw new Error(`No semantic checks are defined for ${fixtureName}`);

  const missing = check.requiredMeanings.filter((meaning) => !renderedExplanation.includes(meaning));
  if (topLevelExplanation.length !== check.topLevelActions) {
    throw new Error(`Expected ${check.topLevelActions} top-level actions, got ${topLevelExplanation.length}`);
  }
  if (missing.length > 0) {
    throw new Error(`Missing meanings: ${missing.join(", ")}`);
  }
  if (renderedExplanation.includes("[Unsupported AST node:")) {
    throw new Error("The explanation contains an unsupported AST node fallback");
  }

  console.log("--- checks ---");
  console.log(`passed: ${check.topLevelActions} top-level actions and ${check.requiredMeanings.length} required meanings`);
}
