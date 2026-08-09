/**
 * Isolates what still fails in the prezto sweep, one construct per line.
 *
 *   bun scripts/debug-zsh-remaining.ts
 *
 * The sweep reports a file and a message; neither says which piece of the line
 * the parser choked on. Splitting each failing line into its parts shows that.
 */
import { parseShell } from "../index.ts";

const CASES: { name: string; source: string }[] = [
  { name: "bare subscript in test", source: "[[ $arg[0,1] = x ]]\n" },
  { name: "bare subscript both sides", source: "[[ $arg[0,1] = $histchars[0,1] ]]\n" },
  { name: "$#arr in arithmetic", source: "(( $#arg == 2 ))\n" },
  { name: "$#arr[slice] in arithmetic", source: "(( $#arg[0,2] == 2 ))\n" },
  { name: "the full failing line", source: "if [[ $arg[0,1] = $histchars[0,1] ]] && (( $#arg[0,2] == 2 )); then\n  :\nfi\n" },

  { name: "repeat loop", source: "repeat 3 do echo hi; done\n" },
  { name: "repeat with expansion", source: "repeat $n do left+=(.); done\n" },

  { name: "C-style for, plain", source: "for (( i = 1 ; i <= 3 ; i += 1 )) ; do echo $i; done\n" },
  { name: "C-style for, $1 bound", source: "for (( i = $1 + 1 ; i <= 3 ; i += 1 )) ; do echo $i; done\n" },
  { name: "C-style for, $#arr bound", source: "for (( i = 1 ; i <= $#arg ; i += 1 )) ; do echo $i; done\n" },
];

for (const testCase of CASES) {
  console.log(`\n=== ${testCase.name} ===`);
  console.log(`  src:  ${JSON.stringify(testCase.source)}`);

  for (const dialect of ["bash", "zsh"] as const) {
    try {
      const script = parseShell(testCase.source, { dialect });
      console.log(`  ${dialect}: ${script.commands.length} command(s)`);
    } catch (error) {
      console.log(`  ${dialect}: REJECTED — ${(error as Error).message}`);
    }
  }
}
