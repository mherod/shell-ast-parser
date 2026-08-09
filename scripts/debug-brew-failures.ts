/**
 * Isolates what the Homebrew sweep still refuses, one construct per line.
 *
 *   bun scripts/debug-brew-failures.ts
 *
 * Every failure there landed on EOF — "Expected fi", "Expected esac" — which
 * says only that something earlier swallowed the terminator, not what. These
 * are the candidates reduced out of the files that failed, with bash's verdict
 * alongside so a real gap is told from bad input.
 */
import { parseShell } from "../index.ts";

const CASES: { name: string; source: string }[] = [
  // git pre-commit.sample
  { name: "heredoc, backslash-quoted delimiter", source: "cat <<\\EOF\nhello\nEOF\necho after\n" },
  { name: "heredoc, single-quoted delimiter", source: "cat <<'EOF'\nhello\nEOF\necho after\n" },
  { name: "heredoc, double-quoted delimiter", source: 'cat <<"EOF"\nhello\nEOF\necho after\n' },
  { name: "heredoc, bare delimiter", source: "cat <<EOF\nhello\nEOF\necho after\n" },
  { name: "&& continued across a comment", source: "if true &&\n  # why\n  true\nthen\n  :\nfi\n" },
  { name: "then on its own line", source: "if true\nthen\n  :\nfi\n" },
  { name: "substitution spanning lines with a pipe", source: "x=$(echo a |\n  cat)\necho $x\n" },

  // automake ylwrap, ffmpeg patcheck, git-jump, tcl rmt
  { name: "case with esac in a heredoc", source: "case $x in\n  a) cat <<EOF\nesac\nEOF\n  ;;\nesac\necho after\n" },
  { name: "backslash-escaped quote in a word", source: "echo a\\'b\necho after\n" },
  { name: "dollar-single-quote in a case", source: "case $x in\n  $'a') echo hi;;\nesac\n" },
  { name: "comment inside a case item", source: "case $x in\n  # why\n  a) echo hi;;\nesac\n" },
  { name: "esac as a word", source: "echo esac\ncase $x in a) :;; esac\n" },

  // mole project.sh — a heredoc opened on a line that carries on with `; then`
  { name: "heredoc then `; then` on one line", source: "if cat << EOF; then\nbody\nEOF\n  echo yes\nfi\necho after\n" },
  { name: "heredoc, space before delimiter", source: "cat << EOF\nbody\nEOF\necho after\n" },
  { name: "heredoc then `; do`", source: "while cat << EOF; do\nbody\nEOF\n  break\ndone\necho after\n" },
  { name: "heredoc then `&& cmd`", source: "cat << EOF && echo yes\nbody\nEOF\necho after\n" },
  { name: "heredoc inside a redirect", source: 'cat > f << EOF\nbody\nEOF\necho after\n' },
];

async function bashVerdict(source: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();

  await new Response(proc.stderr).text();
  await proc.exited;

  return proc.exitCode === 0 ? "accepts" : "rejects";
}

for (const testCase of CASES) {
  const bash = await bashVerdict(testCase.source);

  let ours: string;
  try {
    const script = parseShell(testCase.source);
    ours = `accepts (${script.commands.length} commands)`;
  } catch (error) {
    ours = `REJECTED — ${(error as Error).message}`;
  }

  const gap = bash === "accepts" && ours.startsWith("REJECTED");
  console.log(`${gap ? "GAP " : "    "} ${testCase.name}`);
  console.log(`      src:  ${JSON.stringify(testCase.source)}`);
  console.log(`      bash: ${bash}    ours: ${ours}`);
}
