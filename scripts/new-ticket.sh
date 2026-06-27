#!/usr/bin/env bash
# new-ticket.sh — scaffold the next <KEY>-NNN ticket into backlog/ from TEMPLATE.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEY="$(node "$ROOT/scripts/config.mjs" --get key)"
KEY="${KEY:-TASK}"

TITLE="${1:-}"
if [[ -z "$TITLE" ]]; then
  echo "usage: $0 \"Ticket title\" [--type T] [--priority P] [--labels a,b]" >&2
  exit 1
fi
shift

TYPE="feature"
PRIORITY="medium"
LABELS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)     TYPE="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    --labels)   LABELS="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

LAST="$(ls */${KEY}-*.md 2>/dev/null | grep -oE "${KEY}-[0-9]+" | grep -oE '[0-9]+' \
        | sort -n | tail -1 || true)"
NEXT=$(( ${LAST:-0} + 1 ))
ID="$(printf "${KEY}-%03d" "$NEXT")"

SLUG="$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"

TODAY="$(date +%F)"

if [[ -n "$LABELS" ]]; then
  YAML_LABELS="[$(printf '%s' "$LABELS" | sed -E 's/,/, /g')]"
else
  YAML_LABELS="[]"
fi

DEST="backlog/${ID}-${SLUG}.md"
if [[ -e "$DEST" ]]; then
  echo "refusing to overwrite existing $DEST" >&2
  exit 1
fi

sed -E \
  -e "s/^id: .*/id: ${ID}/" \
  -e "s|^title: .*|title: ${TITLE}|" \
  -e "s/^type: .*/type: ${TYPE}/" \
  -e "s/^priority: .*/priority: ${PRIORITY}/" \
  -e "s|^labels: .*|labels: ${YAML_LABELS}|" \
  -e "s/^created: .*/created: ${TODAY}/" \
  -e "s/^updated: .*/updated: ${TODAY}/" \
  TEMPLATE.md > "$DEST"

sed -i -E 's/^(type: [a-z]+) +#.*/\1/; s/^(priority: [a-z]+) +#.*/\1/' "$DEST"

echo "created $DEST"
