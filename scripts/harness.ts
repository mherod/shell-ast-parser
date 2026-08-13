import { parseShell, visit, findAll, type ParseOptions, type Script, type Dialect } from "../index.ts";

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute a shell process against a source snippet.
 */
export async function shellRun(
  shell: string,
  args: string[],
  source: string,
): Promise<ShellResult> {
  const proc = Bun.spawn([shell, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  return {
    code: proc.exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim().split("\n")[0] ?? "",
  };
}

/**
 * Checks whether `bash -n` or `zsh -n` accepts a source snippet.
 * Returns null if accepted, or the first line of stderr if rejected.
 */
export async function shellAccepts(
  shell: "bash" | "zsh" | string,
  source: string,
): Promise<string | null> {
  const res = await shellRun(shell, ["-n"], source);
  return res.code === 0 ? null : res.stderr || "rejected";
}

/**
 * Checks whether `parseShell` accepts a source snippet.
 * Returns null if accepted, or error message if rejected.
 */
export function parserAccepts(source: string, options: ParseOptions = {}): string | null {
  try {
    parseShell(source, options);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export type Verdict =
  | "ok"
  | "ok (both shells reject too)"
  | "REAL GAP (bash accepts)"
  | "REAL GAP (zsh accepts)"
  | "OVER-ACCEPTS (both shells reject)"
  | "zsh-only (out of scope)";

/**
 * Classify a differential test result across our parser, bash, and zsh.
 */
export function computeVerdict(
  ours: string | null,
  bash: string | null,
  zsh: string | null,
  dialect: Dialect = "bash",
  shouldError: boolean = false,
): Verdict {
  if (shouldError) {
    if (ours !== null) {
      return "ok (both shells reject too)";
    }
    return "OVER-ACCEPTS (both shells reject)";
  }

  if (ours === null) {
    if (dialect === "zsh") {
      return zsh === null ? "ok" : "OVER-ACCEPTS (both shells reject)";
    }
    return bash === null || zsh === null ? "ok" : "OVER-ACCEPTS (both shells reject)";
  }
  if (dialect === "bash" && bash === null) {
    return "REAL GAP (bash accepts)";
  }
  if (dialect === "zsh" && zsh === null) {
    return "REAL GAP (zsh accepts)";
  }
  if (zsh === null) {
    return "zsh-only (out of scope)";
  }
  return "ok (both shells reject too)";
}

export interface CaseSnippet {
  name: string;
  source: string;
  dialect?: Dialect;
  shouldError?: boolean;
}

export interface CaseResult {
  name: string;
  source: string;
  verdict: Verdict;
  bash: string | null;
  zsh: string | null;
  ours: string | null;
}

/**
 * Run a table of test cases against bash, zsh, and our parser, printing verdicts.
 */
export async function runCaseTable(
  cases: readonly CaseSnippet[],
  options: { verbose?: boolean; summary?: boolean } = { verbose: true, summary: true },
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (const snippet of cases) {
    const dialect = snippet.dialect ?? "bash";
    const bash = await shellAccepts("bash", snippet.source);
    const zsh = await shellAccepts("zsh", snippet.source);
    const ours = parserAccepts(snippet.source, { dialect });
    const verdict = computeVerdict(ours, bash, zsh, dialect, snippet.shouldError ?? false);

    if (options.verbose) {
      console.log(`\n=== ${snippet.name} ===`);
      console.log(JSON.stringify(snippet.source));
      console.log(`  bash: ${bash === null ? "accepts" : `rejects — ${bash}`}`);
      console.log(`  zsh:  ${zsh === null ? "accepts" : `rejects — ${zsh}`}`);
      console.log(`  ours: ${ours === null ? "accepts" : `rejects — ${ours}`}`);
      console.log(`  verdict: ${verdict}`);
    }

    results.push({
      name: snippet.name,
      source: snippet.source,
      verdict,
      bash,
      zsh,
      ours,
    });
  }

  if (options.summary) {
    console.log("\n=== summary ===");
    for (const result of results) {
      console.log(`${result.verdict.padEnd(28)} ${result.name}`);
    }
  }

  return results;
}

// ── Invariant Checkers ─────────────────────────────────────────────

export interface RangeFault {
  type: string;
  value: string;
  sliced: string;
}

/**
 * Find words whose range in source does not match their value (accounting for backslash escapes).
 */
export function findRangeFaults(source: string, scriptOrNode: unknown): RangeFault[] {
  const faults: RangeFault[] = [];

  visit(scriptOrNode, (node) => {
    if (node.type === "Word" && typeof (node as any).value === "string" && (node as any).quoted === null) {
      const range = (node as any).range as { start: number; end: number };
      const val = (node as any).value as string;
      const sliced = source.slice(range.start, range.end);
      if (sliced !== val && !val.includes("\\") && !sliced.includes("\\")) {
        faults.push({ type: "Word", value: val, sliced });
      }
    }
  });

  return faults;
}

/**
 * Extract names of all SimpleCommands in the AST.
 */
export function getCommandNames(scriptOrNode: unknown): string[] {
  const names: string[] = [];

  visit(scriptOrNode, (node) => {
    if (node.type === "SimpleCommand" && (node as any).name) {
      const parts = (node as any).name?.parts ?? [];
      names.push(parts.map((p: any) => p.value ?? "?").join(""));
    }
  });

  return names;
}

// ── Source Utilities & Redaction ───────────────────────────────────

const SECRET_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API|PAT|SESSION)/i;

/** Mask assignment values under secret-looking names, plus long opaque runs. */
export function redact(text: string): string {
  return text
    .replace(/([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, (whole, name: string) =>
      SECRET_PATTERN.test(name) ? `${name}=<redacted>` : whole,
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>");
}

export interface Position {
  line: number;
  column: number;
  text: string;
}

export function positionOf(source: string, offset: number): Position {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = source.indexOf("\n", offset);
  return {
    line,
    column: offset - lineStart + 1,
    text: source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd),
  };
}
