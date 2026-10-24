#!/bin/bash
# Screenshots of the TUI for the README, from the demo content `demo-content.ts` made.
#
#   bun scripts/readme/demo-content.ts --profile work --project ATLCLI --space DOCSY > demo.json
#   scripts/readme/tui-screenshots.sh work ATLCLI demo.json
#
# Drives the real TUI in tmux (168×42), captures each state with colors and renders it
# with freeze (charmbracelet/freeze) into assets/readme/tui-*.png, scaled by sips (macOS).
# Nothing is saved: the edit's diff is cancelled. The wiki shots hide the navigator,
# whose space list shows every space of the site.
set -euo pipefail
PROFILE=$1 PROJECT=$2 STATE=$3
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/assets/readme
TMP=$(mktemp -d)
trap 'tmux kill-session -t atlcli-readme 2>/dev/null; rm -rf "$TMP"' EXIT
S=atlcli-readme
val() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {'d': d}))" "$STATE" "$1"; }
BOARD=$(val 'd["board"]') SPRINT=$(val 'd["sprints"]["42"]') PAGE=$(val 'd["pages"]["root"]')

# The edit shot's "$EDITOR": ticks a box and adds one, without a person at the keyboard.
cat > "$TMP/editor.py" <<'EOF'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = s.replace("- [ ] Show the sprint goal in the list title", "- [x] Show the sprint goal in the list title\n- [ ] Keyboard shortcut to jump to the active sprint")
open(p, "w", encoding="utf-8").write(s)
EOF

k() { tmux send-keys -t $S "$@"; }
shot() { # name [settle seconds]
  sleep "${2:-2}"
  tmux capture-pane -e -p -t $S > "$TMP/$1.ansi"
  freeze "$TMP/$1.ansi" --language ansi -o "$OUT/tui-$1.png" --window --padding 16 --margin 0 --font.size 14 >/dev/null
  sips -Z 1800 "$OUT/tui-$1.png" >/dev/null
  echo "assets/readme/tui-$1.png"
}
start() {
  tmux kill-session -t $S 2>/dev/null || true
  tmux new-session -d -s $S -x 168 -y 42 \
    "cd '$ROOT' && TERM=xterm-256color COLORTERM=truecolor EDITOR='python3 -I $TMP/editor.py' VISUAL= bun --conditions=development apps/cli/src/index.ts tui --profile $PROFILE $*; sleep 60"
  sleep 9
}

# Jira: board → active sprint, the second issue (checklist, comments).
start --project "$PROJECT" --board "$BOARD" --jql "'sprint = $SPRINT ORDER BY rank ASC'"
k h; sleep 0.5; k l; sleep 4          # navigator: expand the board (this opens its list)
k h; sleep 0.5; k j; sleep 0.5; k Enter; sleep 4   # back to the navigator, open the active sprint
k j
shot jira-sprint 3
k .; shot jira-comments; k ,
k :; sleep 0.5; k -l "sprint"; shot jira-palette 1.5; k Escape; sleep 0.5
k e; sleep 3; k Enter; shot jira-diff 3; k Escape; sleep 1
k q; sleep 1

# Wiki: the handbook pages, "Release process" open.
start --area wiki
k '['; sleep 0.5
k /; sleep 0.5; k -l "ancestor = $PAGE OR id = $PAGE ORDER BY created ASC"; k Enter; sleep 5
k j j j
shot wiki-page 4
k q; sleep 1
