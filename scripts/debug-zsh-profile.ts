/**
 * Runs the parser over the real zsh startup files on this machine and reports
 * what it could not handle. Startup files are the harshest corpus available —
 * hand-written over years, and zsh rather than the bash/sh the parser targets.
 *
 *   bun scripts/debug-zsh-profile.ts              # tier 1: the home profile
 *   bun scripts/debug-zsh-profile.ts --all        # plus /etc and any framework
 *   bun scripts/debug-zsh-profile.ts <file...>    # specific files
 *
 * Values that look like secrets are redacted before anything is printed, since
 * startup files hold tokens and keys.
 */
import { homedir } from "node:os";
import { tokenize, type Token } from "../src/tokenizer.ts";
import { parse, ParseError } from "../src/parser.ts";
import type { Dialect, Script } from "../src/ast.ts";

const HOME = homedir();

/** These are zsh startup files, so `--zsh` is what actually matches them */
const DIALECT: Dialect = Bun.argv.includes("--zsh") ? "zsh" : "bash";

/** The files zsh itself reads at startup, in the order it reads them */
const TIER1 = [
  `${HOME}/.zshenv`,
  `${HOME}/.zprofile`,
  `${HOME}/.zshrc`,
  `${HOME}/.zlogin`,
  `${HOME}/.p10k.zsh`,
];

const TIER2 = [
  "/etc/zprofile",
  "/etc/zshrc",
  "/etc/zshrc_Apple_Terminal",
  `${HOME}/.zprezto/init.zsh`,
  `${HOME}/.zprezto/runcoms/zshrc`,
  `${HOME}/.zprezto/runcoms/zshenv`,
  `${HOME}/.zprezto/runcoms/zprofile`,
  `${HOME}/.zprezto/runcoms/zlogin`,
  `${HOME}/.zprezto/runcoms/zlogout`,
  `${HOME}/.zprezto/runcoms/zpreztorc`,
];

// ── Redaction ──────────────────────────────────────────────────────

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API|PAT|SESSION)/i;

/** Mask assignment values under secret-looking names, plus long opaque runs. */
function redact(text: string): string {
  return text
    .replace(/([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, (whole, name: string) =>
      SECRET_NAME.test(name) ? `${name}=<redacted>` : whole,
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>");
}

// ── Source context ─────────────────────────────────────────────────

interface Position {
  line: number;
  column: number;
  text: string;
}

function positionOf(source: string, offset: number): Position {
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

// ── AST walking ────────────────────────────────────────────────────

/** Every node reachable from the root, by walking whatever has a `type`. */
function walk(node: unknown, visit: (node: { type: string }) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record as { type: string });

  for (const [key, value] of Object.entries(record)) {
    if (key === "range") continue;
    walk(value, visit);
  }
}

function countNodeTypes(script: Script): Map<string, number> {
  const counts = new Map<string, number>();
  walk(script, (node) => counts.set(node.type, (counts.get(node.type) ?? 0) + 1));
  return counts;
}

function countTokenTypes(tokens: Token[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token.type, (counts.get(token.type) ?? 0) + 1);
  }
  return counts;
}

function topEntries(counts: Map<string, number>, limit: number): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, n]) => `${name}=${n}`)
    .join(" ");
}

// ── Round-trip check: do ranges still index the source? ────────────

/**
 * The README promises `src.slice(node.range.start, node.range.end)` returns the
 * node's text at any depth. A parse that "succeeds" with wrong ranges is worse
 * than one that throws, so check every node that carries a literal value.
 */
interface RangeFault {
  type: string;
  start: number;
  end: number;
  reason: string;
}

function checkRanges(source: string, script: Script): RangeFault[] {
  const faults: RangeFault[] = [];

  walk(script, (node) => {
    const range = (node as { range?: { start: number; end: number } }).range;
    if (!range) return;

    if (range.start > range.end) {
      faults.push({ ...range, type: node.type, reason: "start > end" });
      return;
    }
    if (range.end > source.length) {
      faults.push({ ...range, type: node.type, reason: `end past EOF (${source.length})` });
      return;
    }

    // An unquoted, escape-free Word should slice back to exactly its value
    const word = node as { type: string; value?: unknown; quoted?: unknown };
    if (word.type !== "Word" || typeof word.value !== "string" || word.quoted !== null) return;
    if (word.value.includes("\\")) return;

    const sliced = source.slice(range.start, range.end);
    if (sliced !== word.value && !sliced.includes("\\")) {
      faults.push({
        ...range,
        type: node.type,
        reason: `slice ${JSON.stringify(redact(sliced))} != value ${JSON.stringify(redact(word.value))}`,
      });
    }
  });

  return faults;
}

/**
 * Source the AST does not account for. A parser can drop a construct silently —
 * command count still looks plausible while a chunk of the file vanished — so
 * subtract every node's range from the source and see what is left.
 */
interface Gap {
  start: number;
  end: number;
  text: string;
}

function findCoverageGaps(source: string, script: Script): Gap[] {
  const covered = new Uint8Array(source.length);

  walk(script, (node) => {
    const range = (node as { range?: { start: number; end: number } }).range;
    if (!range) return;
    for (let i = Math.max(0, range.start); i < Math.min(source.length, range.end); i++) {
      covered[i] = 1;
    }
  });

  const gaps: Gap[] = [];
  let runStart = -1;
  for (let i = 0; i <= source.length; i++) {
    // Whitespace and shell punctuation are structure, not content: a `;` or `&&`
    // is represented by the node it joins rather than by a range of its own.
    const structural = i === source.length || covered[i] === 1 || /[\s;&|()<>!]/.test(source[i]!);
    if (structural) {
      if (runStart !== -1) {
        const text = source.slice(runStart, i);
        if (text.trim().length > 0) gaps.push({ start: runStart, end: i, text });
        runStart = -1;
      }
    } else if (runStart === -1) {
      runStart = i;
    }
  }
  return gaps;
}

// ── Per-file report ────────────────────────────────────────────────

interface Failure {
  line: number;
  column: number;
  message: string;
  token: string;
  text: string;
  /** A closer left unbalanced by recovery, rather than a defect of its own */
  cascade?: boolean;
}

interface Report {
  path: string;
  bytes: number;
  lines: number;
  ok: boolean;
  detail: string;
  failures: Failure[];
}

async function probe(path: string): Promise<Report> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { path, bytes: 0, lines: 0, ok: false, detail: "missing", failures: [] };
  }

  const source = await file.text();
  const base = { path, bytes: source.length, lines: source.split("\n").length, failures: [] };

  let tokens: Token[];
  try {
    tokens = tokenize(source, { dialect: DIALECT });
  } catch (error) {
    const err = error as Error;
    console.log(`  TOKENIZE THREW: ${redact(err.message)}`);
    console.log(`  stack: ${err.stack?.split("\n").slice(1, 4).join(" | ")}`);
    return { ...base, ok: false, detail: `tokenize: ${redact(err.message)}` };
  }

  // Enumerate every failure site, not just the first: on a ParseError, drop the
  // source through the end of the offending line and parse the remainder. One
  // unsupported construct otherwise hides every construct behind it.
  const failures: Failure[] = [];
  let script: Script | null = null;
  let offset = 0;

  while (offset < source.length) {
    const remainder = source.slice(offset);
    try {
      const parsed = parse(tokenize(remainder, { dialect: DIALECT }), { dialect: DIALECT });
      if (script === null) script = parsed;
      break;
    } catch (error) {
      if (!(error instanceof ParseError)) {
        const err = error as Error;
        console.log(`  PARSE THREW (not ParseError): ${err.name}: ${redact(err.message)}`);
        console.log(`  stack: ${err.stack?.split("\n").slice(1, 4).join(" | ")}`);
        failures.push({ line: 0, column: 0, message: `${err.name}: ${err.message}`, token: "", text: "" });
        break;
      }

      const absolute = offset + error.token.range.start;
      const at = positionOf(source, absolute);
      failures.push({
        line: at.line,
        column: at.column,
        message: error.message,
        token: `${error.token.type} ${JSON.stringify(error.token.value)}`,
        text: at.text.trim(),
      });

      const nextLine = source.indexOf("\n", absolute);
      if (nextLine === -1) break;
      offset = nextLine + 1;
    }
  }

  // Resuming after a failure can land inside a block, so the block's own closer
  // then looks unbalanced. Those are artefacts of the recovery, not separate
  // defects, and counting them as findings overstates how much is broken.
  // The first failure is never one: nothing has been recovered from yet, so a
  // lone closer there is a real finding.
  const CASCADE = new Set(["fi", "done", "esac", "}", ")", "then", "else", "elif", "do"]);
  for (const [index, failure] of failures.entries()) {
    failure.cascade = index > 0 && CASCADE.has(failure.text.replace(/[;\s].*$/, ""));
  }

  const roots = failures.filter((failure) => !failure.cascade);
  for (const failure of failures) {
    const label = failure.cascade ? "cascade after recovery" : "PARSE FAILED";
    console.log(`  ${label} at line ${failure.line}:${failure.column} — ${redact(failure.message)}`);
    if (failure.cascade) continue;
    console.log(`    token: ${redact(failure.token)}`);
    console.log(`    line:  ${redact(failure.text)}`);
  }

  if (script === null) {
    return { ...base, ok: false, failures, detail: `${roots.length} parse failures, no AST` };
  }

  // Range and coverage checks compare against the whole file, so they are only
  // meaningful when the AST came from parsing it whole. After error recovery the
  // AST covers a suffix and its offsets are relative to that suffix.
  const whole = failures.length === 0;
  const nodes = countNodeTypes(script);
  const faults = whole ? checkRanges(source, script) : [];
  const gaps = whole ? findCoverageGaps(source, script) : [];

  console.log(`  tokens:      ${tokens.length}  (${topEntries(countTokenTypes(tokens), 6)})`);
  console.log(`  top-level:   ${script.commands.length} commands, ${script.comments.length} comments`);
  console.log(`  nodes:       ${[...nodes.values()].reduce((a, b) => a + b, 0)}  (${topEntries(nodes, 8)})`);
  console.log(`  range faults: ${faults.length}`);
  for (const fault of faults.slice(0, 8)) {
    console.log(`    ${fault.type} [${fault.start},${fault.end}] ${fault.reason}`);
  }
  console.log(`  coverage gaps: ${gaps.length}`);
  for (const gap of gaps.slice(0, 8)) {
    const at = positionOf(source, gap.start);
    console.log(`    line ${at.line}: ${JSON.stringify(redact(gap.text))} in ${JSON.stringify(redact(at.text.trim()))}`);
  }

  const problems = roots.length + faults.length + gaps.length;
  return {
    ...base,
    ok: problems === 0,
    failures,
    detail:
      problems === 0
        ? "parsed"
        : `${roots.length} failures (+${failures.length - roots.length} cascade), ${faults.length} range faults, ${gaps.length} gaps`,
  };
}

// ── Main ───────────────────────────────────────────────────────────

const argv = Bun.argv.slice(2);
const explicit = argv.filter((arg) => !arg.startsWith("--"));

/** A directory argument stands for every zsh file under it */
async function expand(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    if ((await Bun.file(path).exists()) || !path.endsWith("/")) {
      const stat = await Bun.file(path).stat().catch(() => null);
      if (stat?.isDirectory()) {
        const glob = new Bun.Glob("**/*.{zsh,sh,zshrc,zshenv,zprofile,zlogin,zlogout}");
        for await (const found of glob.scan({ cwd: path, absolute: true })) out.push(found);
        continue;
      }
    }
    out.push(path);
  }
  return out;
}

const targets = await expand(
  explicit.length > 0 ? explicit : argv.includes("--all") ? [...TIER1, ...TIER2] : TIER1,
);

// A directory sweep is about the tally, so drop the per-file detail
const quiet = argv.includes("--quiet") || targets.length > 40;
const log = console.log;
if (quiet) console.log = () => {};

const reports: Report[] = [];
for (const target of targets) {
  console.log(`\n=== ${target} ===`);
  const started = performance.now();
  const report = await probe(target);
  console.log(`  elapsed:     ${(performance.now() - started).toFixed(1)}ms`);
  reports.push(report);
}

console.log = log;

// Across a sweep the useful question is which constructs keep failing, not
// which files did. Group the root causes by the shape of the offending line.
const roots = reports.flatMap((report) =>
  report.failures.filter((failure) => !failure.cascade).map((failure) => ({ report, failure })),
);
if (roots.length > 0) {
  const byMessage = new Map<string, { count: number; example: string; where: string }>();
  for (const { report, failure } of roots) {
    const key = failure.message.replace(/at position \d+.*$/, "").trim();
    const seen = byMessage.get(key);
    if (seen) seen.count++;
    else {
      byMessage.set(key, {
        count: 1,
        example: failure.text.slice(0, 90),
        where: `${report.path.replace(HOME, "~")}:${failure.line}`,
      });
    }
  }

  console.log(`\n=== root causes (${roots.length} across ${reports.filter((r) => !r.ok).length} files) ===`);
  for (const [message, info] of [...byMessage.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${String(info.count).padStart(4)}x ${message}`);
    console.log(`      e.g. ${info.where}`);
    console.log(`           ${redact(info.example)}`);
  }
}

console.log(`\n=== summary (${DIALECT}) ===`);
for (const report of reports) {
  if (quiet && report.ok) continue;
  const mark = report.ok ? "ok  " : "FAIL";
  console.log(`${mark} ${report.path.replace(HOME, "~")}  (${report.bytes}B, ${report.lines} lines)  ${report.detail}`);
}
const failed = reports.filter((report) => !report.ok).length;
const bytes = reports.reduce((sum, report) => sum + report.bytes, 0);
console.log(`\n${reports.length - failed}/${reports.length} parsed clean (${(bytes / 1024).toFixed(0)}KB)`);
