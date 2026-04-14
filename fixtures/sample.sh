#!/bin/bash
# A comprehensive shell script exercising major syntax constructs

# --- Variable assignments ---
NAME="world"
COUNT=10
EMPTY=
QUOTED='single quoted string'
ESCAPED="hello \"world\" \$NOT_EXPANDED"

# --- Simple commands with arguments ---
echo "Hello, $NAME!"
ls -la /tmp
grep -r "pattern" --include="*.ts" ./src

# --- Variable expansion forms ---
echo "${NAME}"
echo "${NAME:-default}"
echo "${NAME:=assigned}"
echo "${NAME:+alternate}"
echo "${#NAME}"
echo "${NAME%pattern}"
echo "${NAME##pattern}"

# --- Pipelines ---
cat /etc/passwd | grep root | awk -F: '{print $1}'
ls -1 | sort | uniq -c | sort -rn | head -5

# --- Redirections ---
echo "output" > /tmp/out.txt
echo "append" >> /tmp/out.txt
cat < /tmp/out.txt
command 2>/dev/null
command > /tmp/out.txt 2>&1
cat <<EOF
Here document content
with $NAME expansion
EOF

# --- Lists (&&, ||, ;) ---
mkdir -p /tmp/test && cd /tmp/test && echo "success"
false || echo "fallback"
echo "first"; echo "second"; echo "third"

# --- Conditionals ---
if [ -f /tmp/out.txt ]; then
    echo "file exists"
elif [ -d /tmp ]; then
    echo "directory exists"
else
    echo "nothing found"
fi

if [[ "$NAME" == w* && -n "$NAME" ]]; then
    echo "pattern match"
fi

# --- Loops ---
for i in 1 2 3 4 5; do
    echo "iteration $i"
done

for file in *.sh; do
    echo "found: $file"
done

while read -r line; do
    echo "line: $line"
done < /tmp/out.txt

until [ "$COUNT" -le 0 ]; do
    COUNT=$((COUNT - 1))
done

# --- Case statement ---
case "$NAME" in
    hello)
        echo "greeting"
        ;;
    world|earth)
        echo "planet"
        ;;
    *)
        echo "unknown"
        ;;
esac

# --- Functions ---
greet() {
    local who="$1"
    echo "Hello, $who!"
    return 0
}

function cleanup {
    rm -f /tmp/out.txt
}

greet "developer"

# --- Command substitution ---
TODAY=$(date +%Y-%m-%d)
FILES=`ls -1 | wc -l`
echo "Date: $TODAY, Files: $FILES"

# --- Arithmetic ---
RESULT=$((COUNT + 5 * 3))
echo $((2 ** 10))

# --- Subshell and grouping ---
(cd /tmp && ls)
{ echo "grouped"; echo "commands"; }

# --- Background and job control ---
sleep 10 &
BGPID=$!
wait "$BGPID"

# --- Glob patterns ---
echo /tmp/*.txt
echo /home/*/Documents

# --- Process substitution ---
diff <(ls /tmp) <(ls /var)

# --- Array (bash-specific) ---
ITEMS=(one two three)
echo "${ITEMS[0]}"
echo "${ITEMS[@]}"
echo "${#ITEMS[@]}"

# --- Trap ---
trap 'echo "caught signal"; cleanup' EXIT INT TERM

# --- Coprocess ---
coproc WORKER { while read -r line; do echo "processed: $line"; done; }

# --- Nested structures ---
if [ -d /tmp ]; then
    for f in /tmp/*; do
        if [ -f "$f" ]; then
            case "$f" in
                *.txt) echo "text: $f" ;;
                *.log) echo "log: $f" ;;
            esac
        fi
    done
fi

echo "done"
