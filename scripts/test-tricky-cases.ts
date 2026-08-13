import { parseShell, parse, tokenize, visit, type Script, type Dialect } from "../index.ts";
import { findRangeFaults, shellAccepts, positionOf } from "./harness.ts";

export interface TrickyTestCase {
  category: string;
  name: string;
  source: string;
  dialect?: Dialect;
  shouldError?: boolean;
  notes?: string;
}

export const TRICKY_TEST_CASES: TrickyTestCase[] = [
  // ── 1. Obscure Quoting & Escapes ────────────────────────────────────
  {
    category: "Quoting & Escapes",
    name: "adjacent mixed quoting concatenation without whitespace",
    source: `VAR=prefix'single'"double"$'$ansi_c'$"locale"suffix\n`,
    dialect: "bash",
  },
  {
    category: "Quoting & Escapes",
    name: "ANSI-C quoting with octal, hex, and unicode escapes",
    source: `MSG=$'Octal: \\101\\102, Hex: \\x43\\x44, Uni16: \\u0045, Uni32: \\U00000046, Bell: \\a, Esc: \\e'\n`,
    dialect: "bash",
  },
  {
    category: "Quoting & Escapes",
    name: "ANSI-C quoting with control chars and escaped quotes",
    source: `ESC=$'\\c?\\cM\\cI\\'\\"\\\\'\n`,
    dialect: "bash",
  },
  {
    category: "Quoting & Escapes",
    name: "line continuation across assignment and operator",
    source: `A=1 \\\nB=2 \\\ncmd \\\n  --flag \\\n  && \\\n  echo \\\n    done\n`,
    dialect: "bash",
  },
  {
    category: "Quoting & Escapes",
    name: "line continuation inside double quoted string",
    source: `STR="first line \\\nsecond line \\\nthird line"\n`,
    dialect: "bash",
  },
  {
    category: "Quoting & Escapes",
    name: "escaped special characters as unquoted words",
    source: `echo \\  \\( \\) \\{ \\} \\; \\& \\| \\< \\> \\* \\? \\[ \\] \\$ \\\\ \\\` \\"\n`,
    dialect: "bash",
  },
  {
    category: "Quoting & Escapes",
    name: "empty strings of various quote kinds concatenated",
    source: `EMPTY=""''$''$""\n`,
    dialect: "bash",
  },

  // ── 2. Deep & Tricky Parameter Expansions ───────────────────────────
  {
    category: "Parameter Expansions",
    name: "deeply nested parameter expansion defaults with substitutions",
    source: `VAL="\${A:-\${B:-\${C:-\$(echo "\${D:-fallback}")}}}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "substring expansion with negative offset and length expressions",
    source: `echo "\${VAR: -5:2}" "\${VAR:1+2:3*2}" "\${ARR[@]: -3:2}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "pattern replacement with escaped slashes and quotes",
    source: `PATH_MOD="\${ORIG_PATH//\\//:}" QUOTE_MOD="\${TEXT/foo/\\"bar/baz\\"}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "pattern replacement anchored to head and tail",
    source: `HEAD="\${VAR/#prefix/NEW}" TAIL="\${VAR/%suffix/END}" DEL="\${VAR//pattern}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "case modification with character class pattern",
    source: `UP="\${VAR^^[a-z]}" LOW="\${VAR,,[A-Z]}" FIRST_UP="\${VAR^[a-z]}" FIRST_LOW="\${VAR,[A-Z]}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "indirect expansion and variable name prefix matching",
    source: `echo "\${!REF_VAR}" "\${!PREFIX_*}" "\${!PREFIX_@}" "\${!MAP[@]}" "\${!ARR[*]}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "bash 4.4+ parameter transformations (@Q, @P, @A, @a, @E, @U, @L)",
    source: `echo "\${VAR@Q}" "\${VAR@E}" "\${VAR@P}" "\${VAR@A}" "\${VAR@a}" "\${VAR@U}" "\${VAR@L}"\n`,
    dialect: "bash",
  },
  {
    category: "Parameter Expansions",
    name: "special parameters single digit, multi-digit, and special symbols",
    source: `echo "$0" "$1" "$9" "\${10}" "\${123}" "$$" "$?" "$!" "$-" "$*" "$@" "$#"\n`,
    dialect: "bash",
  },

  // ── 3. Complex Brace Expansions ─────────────────────────────────────
  {
    category: "Brace Expansions",
    name: "nested and adjacent brace expansions",
    source: `echo {a,b{1..3},c{x,y,z}}{0..1}\n`,
    dialect: "bash",
  },
  {
    category: "Brace Expansions",
    name: "brace expansion with positive and negative step",
    source: `echo {0..20..5} {20..0..-5} {a..z..3} {z..a..-3}\n`,
    dialect: "bash",
  },
  {
    category: "Brace Expansions",
    name: "brace expansion with empty members and escapes",
    source: `echo {,a,b} {a,,b} {a,b,} {a\\,b,c\\}d}\n`,
    dialect: "bash",
  },
  {
    category: "Brace Expansions",
    name: "literal braces that must NOT expand",
    source: `echo {} {a} {1..} {..2} {1..2..} {1..a} "\\{a,b\\}" "{a,b}"\n`,
    dialect: "bash",
  },

  // ── 4. Glob Patterns & Extended Globs ────────────────────────────────
  {
    category: "Globs & Extglobs",
    name: "bracket expression with closing bracket first and dash at boundary",
    source: `ls []abc] [-abc] [abc-] [!-abc] [!^]\n`,
    dialect: "bash",
  },
  {
    category: "Globs & Extglobs",
    name: "POSIX character classes and collating symbols in glob bracket",
    source: `ls [[:alpha:][:digit:]_]* [[.ch.][=e=]]*\n`,
    dialect: "bash",
  },
  {
    category: "Globs & Extglobs",
    name: "nested extglobs with mixed operators and quotes",
    source: `rm -f !(*.jpg|*.png|@(*.tar.gz|*.tgz)|+([0-9])_backup."bak")\n`,
    dialect: "bash",
  },
  {
    category: "Globs & Extglobs",
    name: "extglob containing variable expansion in alternative",
    source: `ls @($DYNAMIC_EXT|*.txt|prefix_*(a|b))\n`,
    dialect: "bash",
  },

  // ── 5. Advanced Heredocs & Here-strings ─────────────────────────────
  {
    category: "Heredocs & Here-strings",
    name: "multiple chained heredocs across pipeline",
    source: `cmd1 <<EOF1 | cmd2 <<EOF2 | cmd3 <<EOF3\nfirst body\nEOF1\nsecond body\nEOF2\nthird body\nEOF3\n`,
    dialect: "bash",
  },
  {
    category: "Heredocs & Here-strings",
    name: "heredoc supplying input to while read loop",
    source: `while read -r key val; do\n  echo "$key => $val"\ndone <<'EOF'\nname Alice\nage 30\ncity London\nEOF\n`,
    dialect: "bash",
  },
  {
    category: "Heredocs & Here-strings",
    name: "heredoc in if condition line continuing with then",
    source: `if grep -q "pattern" <<EOF; then\nline containing pattern\nEOF\n  echo "matched"\nfi\n`,
    dialect: "bash",
  },
  {
    category: "Heredocs & Here-strings",
    name: "heredoc with delimiter appearing as substring in body",
    source: `cat <<EOF\nEOF_NOT\nMY_EOF_LINE\n   EOF\nEOF\n`,
    dialect: "bash",
  },
  {
    category: "Heredocs & Here-strings",
    name: "tab-stripped heredoc <<- with quoted delimiter",
    source: `cat <<-'END_MSG'\n\tline 1 $NOT_EXPANDED\n\tline 2 \`not_run\`\n\tEND_MSG\n`,
    dialect: "bash",
  },
  {
    category: "Heredocs & Here-strings",
    name: "here-string with expansion and ANSI-C multiline string",
    source: `grep -F "search" <<< "$DATA"\ncat <<< $'line1\\nline2\\nline3'\n`,
    dialect: "bash",
  },

  // ── 6. Advanced Redirections ─────────────────────────────────────────
  {
    category: "Redirections",
    name: "multi-digit file descriptors, reading, writing, and closing",
    source: `exec 3<input.dat 4>output.dat 5>>append.dat 6<>rw.dat 3<&- 4>&-\n`,
    dialect: "bash",
  },
  {
    category: "Redirections",
    name: "file descriptor duplication and movement 3<&0-",
    source: `cmd 3<&0- 4>&1- 2>&1 >/dev/null\n`,
    dialect: "bash",
  },
  {
    category: "Redirections",
    name: "combined redirects &> and &>> and noclobber >|",
    source: `make &> build.log\nmake test &>> build.log\necho force >| clobber.txt\n`,
    dialect: "bash",
  },
  {
    category: "Redirections",
    name: "bash automatic fd allocation {var}>file and closing",
    source: `exec {my_fd}>output.log\necho "hello" >&$my_fd\nexec {my_fd}>&-\n`,
    dialect: "bash",
  },
  {
    category: "Redirections",
    name: "leading redirections before command name",
    source: `<input.txt >output.txt 2>err.log grep "needle"\n`,
    dialect: "bash",
  },
  {
    category: "Redirections",
    name: "redirections applied to compound if, while, for, and brace groups",
    source: `if [ -f a ]; then cat a; else cat b; fi > if_out.txt 2>&1\nwhile read -r l; do echo "$l"; done < in.txt > out.txt\nfor x in 1 2 3; do echo "$x"; done > for_out.txt\n{ date; uptime; } > brace_out.txt\n( cd /tmp && ls ) > subshell_out.txt\n`,
    dialect: "bash",
  },

  // ── 7. Arithmetic Expressions & Commands ─────────────────────────────
  {
    category: "Arithmetic",
    name: "nested ternary conditional and chained assignment operators",
    source: `TOTAL=$(( a ? b : c ? d : e ? f : g ))\n(( x = y = z = 10, a += b *= c -= 2 ))\n`,
    dialect: "bash",
  },
  {
    category: "Arithmetic",
    name: "complex bitwise, logical, unary, and exponentiation precedence",
    source: `VAL=$(( ~(a << 3 & 0xFF) ^ (b >> 2 | 0x0F) ** (c % 4 + +d - -e) ))\n`,
    dialect: "bash",
  },
  {
    category: "Arithmetic",
    name: "pre/post increment/decrement chained expressions",
    source: `RES=$(( ++i + j++ - --k - l-- + +m - -n ))\n`,
    dialect: "bash",
  },
  {
    category: "Arithmetic",
    name: "multi-base numbers in arithmetic expression",
    source: `NUM=$(( 16#FF + 2#11001100 + 8#755 + 0xABCD + 0777 + 36#ZZ + 64#@_ ))\n`,
    dialect: "bash",
  },
  {
    category: "Arithmetic",
    name: "array subscripts and dynamic indexing in arithmetic",
    source: `(( arr[i * 2 + 1] += 10, matrix[x][y] = arr[i] ** 2 ))\n`,
    dialect: "bash",
  },
  {
    category: "Arithmetic",
    name: "C-style for loop with missing clauses and multiple comma expressions",
    source: `for (( ; ; )); do break; done\nfor (( i=0, j=100; i<10 && j>0; i++, j-=10 )); do :; done\nfor (( ; i<5; i++ )); do :; done\nfor (( i=0; ; i++ )); do (( i >= 5 )) && break; done\nfor (( i=0; i<5; )); do (( i++ )); done\n`,
    dialect: "bash",
  },
  {
    category: "Arithmetic",
    name: "let command evaluating multiple complex arithmetic arguments",
    source: `let "x = 5 * 10" 'y = x / 2' z=x+y 'flag = (x > y ? 1 : 0)'\n`,
    dialect: "bash",
  },

  // ── 8. Test Expressions ([[ ]] & [ ]) ────────────────────────────────
  {
    category: "Conditionals & Tests",
    name: "regex matching with complex regex groups, classes, and quantifiers",
    source: `if [[ $ip =~ ^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$ ]]; then\n  echo "valid ip"\nfi\n`,
    dialect: "bash",
  },
  {
    category: "Conditionals & Tests",
    name: "regex matching with quoted literal strings and runtime expansions",
    source: `[[ $url =~ ^https?://"$ALLOWED_HOST"(/$PATH_PATTERN)?$ ]]\n`,
    dialect: "bash",
  },
  {
    category: "Conditionals & Tests",
    name: "pattern matching with extglobs in double bracket test",
    source: `[[ $filename == !(*.bak|*.tmp|*.swp) && $answer == @([Yy]|[Yy][Ee][Ss]) ]]\n`,
    dialect: "bash",
  },
  {
    category: "Conditionals & Tests",
    name: "complex nested parentheses boolean logic in double brackets",
    source: `[[ ( -f $file && ! -s $file ) || ( -d $dir && ( -r $dir || -w $dir ) ) && ! ( -L $file ) ]]\n`,
    dialect: "bash",
  },
  {
    category: "Conditionals & Tests",
    name: "multiline double bracket with comments between each condition",
    source: `if [[ \n    -n "$A"\n    # check flag B\n    && ( -z "$B" || "$B" == "default" )\n    # check file exists\n    && -f "/path/to/\${FILE}"\n  ]]; then\n  echo "ok"\nfi\n`,
    dialect: "bash",
  },
  {
    category: "Conditionals & Tests",
    name: "POSIX test and single bracket with -a, -o, !, and sub-grouping",
    source: `[ -f "$file" -a \\( -r "$file" -o -w "$file" \\) ]\ntest ! -d "$dir" -o -x "$dir"\n[ "$a" = "$b" -a "$c" != "$d" -a "$num" -gt 10 ]\n`,
    dialect: "bash",
  },

  // ── 9. Compound Commands & Complex Control Flow ───────────────────────
  {
    category: "Control Flow",
    name: "case statement with leading parens, fallthrough ;& and ;;&",
    source: `case "$opt" in\n  (a|b) echo "ab" ;&\n  (c) echo "abc" ;;\n  (d*) echo "d prefix" ;;&\n  (*e) echo "ends with e" ;;\n  *) echo "default" ;;\nesac\n`,
    dialect: "bash",
  },
  {
    category: "Control Flow",
    name: "one-line compact compound commands",
    source: `if true; then :; elif false; then :; else :; fi\nwhile false; do :; done\nuntil true; do :; done\nfor x in 1 2 3; do :; done\n`,
    dialect: "bash",
  },
  {
    category: "Control Flow",
    name: "function with subshell body and function with loop body",
    source: `subshell_fn() ( export FOO=bar; cd /tmp; ls )\nloop_fn() while read -r line; do echo "> $line"; done\n`,
    dialect: "bash",
  },
  {
    category: "Control Flow",
    name: "coprocess with named block and anonymous block",
    source: `coproc MY_COPROC { while read -r msg; do echo "ack: $msg"; done; }\ncoproc { sleep 60; }\n`,
    dialect: "bash",
  },
  {
    category: "Control Flow",
    name: "negated background pipeline with subshell",
    source: `! ( cat /var/log/syslog | grep -E "ERROR|FATAL" | head -n 100 ) > err.txt 2>&1 &\n`,
    dialect: "bash",
  },

  // ── 10. Zsh Advanced Dialect Constructs ──────────────────────────────
  {
    category: "Zsh Dialect",
    name: "exhaustive glob qualifiers for types, permissions, times, and sorting",
    source: `print *(.) *(/) *(@) *(=) *(p) *(x) *(X) *(U) *(G) *(m-7) *(a+30) *(Lk+100) *(om[1,5]) *(On) *(-/FN) *(.^w)\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh numeric glob ranges in filenames and patterns",
    source: `ls logs/app.<1-100>.log archive/data.<-50>.tar backup.<10->.bak any.<->\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh parameter flags for case, quoting, splitting, joining, and sorting",
    source: `up=\${(U)var} low=\${(L)var} cap=\${(C)var} q=\${(q)var} qq=\${(qq)var} split=\${(f)text} join=\${(j:,:)arr} sort=\${(o)arr} rsort=\${(O)arr} keys=\${(k)map} vals=\${(v)map}\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh nested parameter expansion flags and commands",
    source: `res=\${(j:,:)\${(f)"\$(cat file.txt)"}}\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh array and string subscripts with search flags (i, I, r, R, k)",
    source: `first_idx=\${arr[(i)pattern]} last_idx=\${arr[(I)pattern]} first_val=\${arr[(r)pattern]} last_val=\${arr[(R)pattern]} slice=\${arr[2,-2]}\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh anonymous functions with trailing arguments",
    source: `function {\n  local arg1=\$1 arg2=\$2\n  print "\$arg1: \$arg2"\n} "param1" "param2"\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh try-finally always blocks with nested error handling",
    source: `{\n  print "try block"\n  perform_risky_operation\n} always {\n  print "always block"\n  rm -f /tmp/lockfile\n}\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh repeat loops with both brace and do-done syntax",
    source: `repeat 5 {\n  print "tick"\n}\nrepeat \$COUNT do\n  print "count tick"\ndone\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh short-form loops and conditionals without do/done or then/fi",
    source: `for x (alpha beta gamma) print \$x\nfor k v in k1 v1 k2 v2; do print "\$k: \$v"; done\nif [[ -n \$x ]] print "x is set"\n`,
    dialect: "zsh",
  },
  {
    category: "Zsh Dialect",
    name: "zsh case statement with ;| test-next-pattern fallthrough",
    source: `case \$opt in\n  -a) all=1 ;|\n  -v) verbose=1 ;|\n  -q) quiet=1 ;;\nesac\n`,
    dialect: "zsh",
  },

  // ── 11. Malformed / Syntax Errors (Must throw ParseError, never hang) ──
  {
    category: "Syntax Errors",
    name: "unclosed single quote",
    source: `echo 'unclosed single quote`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed double quote",
    source: `echo "unclosed double quote`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed command substitution $(",
    source: `echo $(cat /etc/passwd`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed arithmetic expansion $((",
    source: `echo $(( 1 + 2 * 3`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed parameter expansion ${",
    source: `echo \${UNCLOSED_VAR`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed brace group {",
    source: `{ echo hello; echo world`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed subshell (",
    source: `( cd /tmp && ls`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed if statement",
    source: `if [ -f /tmp/test ]; then echo "yes"`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed for loop",
    source: `for x in 1 2 3; do echo $x`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed while loop",
    source: `while true; do echo "looping"`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "unclosed case statement",
    source: `case $x in a) echo a ;;`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "missing heredoc delimiter at EOF",
    source: `cat <<EOF\nline 1 without closing delimiter\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "stray closing parenthesis",
    source: `echo hello )\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "stray fi keyword",
    source: `echo start\nfi\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "stray done keyword",
    source: `echo start\ndone\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "stray esac keyword",
    source: `echo start\nesac\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "missing redirect target",
    source: `echo hello >\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "pipe without right-hand command",
    source: `echo hello |\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "and-operator without right-hand command",
    source: `echo hello &&\n`,
    dialect: "bash",
    shouldError: true,
  },
  {
    category: "Syntax Errors",
    name: "double pipe without left-hand command",
    source: `|| echo hello\n`,
    dialect: "bash",
    shouldError: true,
  },
];

// ── Runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

console.log(`\n======================================================`);
console.log(`RUNNING TRICKY CASES TEST BED (${TRICKY_TEST_CASES.length} cases)`);
console.log(`======================================================\n`);

for (const testCase of TRICKY_TEST_CASES) {
  const dialect = testCase.dialect ?? "bash";
  let parseResult: Script | null = null;
  let parseErr: string | null = null;

  try {
    parseResult = parseShell(testCase.source, { dialect });
  } catch (err) {
    parseErr = (err as Error).message;
  }

  if (testCase.shouldError) {
    if (parseErr !== null) {
      passed++;
      console.log(`✓ [${testCase.category}] ${testCase.name} (correctly threw: ${parseErr.split("\n")[0]})`);
    } else {
      failed++;
      console.error(`✗ [${testCase.category}] ${testCase.name} (EXPECTED ERROR, but parsed successfully)`);
    }
  } else {
    if (parseErr !== null) {
      failed++;
      console.error(`✗ [${testCase.category}] ${testCase.name} (UNEXPECTED ERROR: ${parseErr})`);
      console.error(`  source: ${JSON.stringify(testCase.source)}`);
    } else if (parseResult !== null) {
      // Check AST invariants
      const rangeFaults = findRangeFaults(testCase.source, parseResult);
      if (rangeFaults.length > 0) {
        failed++;
        console.error(`✗ [${testCase.category}] ${testCase.name} (RANGE FAULT: ${JSON.stringify(rangeFaults)})`);
      } else {
        passed++;
        console.log(`✓ [${testCase.category}] ${testCase.name} (${parseResult.commands.length} cmds)`);
      }
    }
  }
}

console.log(`\n======================================================`);
console.log(`SUMMARY: ${passed}/${TRICKY_TEST_CASES.length} passed, ${failed} failed`);
console.log(`======================================================\n`);

if (failed > 0) {
  process.exit(1);
}

