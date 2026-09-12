#!/usr/bin/env bash
# BLZ-556 — move pre-migration pending-op queues into the repository's single queue store.
# Companion to queue-store-migration.md. Read that first.
#
# Two subcommands:
#   count                     report ops per working copy, across EVERY working copy of the repo
#   stamp <wc> <queue-file>   write that queue file to stdout with `worktree` stamped onto
#                             every line that does not already record `worktree` (BLZ-602)
#   migrate <working-copy>    append that working copy's queues into the store, STAMPED, and
#                             move the sources aside (never delete)
#
# Design notes, because each one is a defect this script exists to not have:
#   * `set -euo pipefail` — an append that succeeds followed by an `mv` that fails must abort,
#     not print success and leave a state where re-running double-appends.
#   * Read permission and file type are asserted BEFORE any count. An unreadable source that
#     counts as zero passes every line-count check vacuously and is then moved aside and lost.
#   * Verification is a SHA-256 of (destination ‖ source) computed before the append, compared
#     with the destination after. A hash cannot pass on an input it could not read; a line
#     count can.
#   * Paths are NUL-delimited throughout. `awk '{print $2}'` truncates a path containing a
#     space, which then silently disappears from the totals and is never migrated.
#   * Quiescence is re-checked immediately before every write, across every working copy —
#     not once at the start, and not only under the main checkout.
set -euo pipefail

BLAZE_STATUS_CMD=${BLAZE_STATUS_CMD:-blaze commit --status}

die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

# --- the board, derived and then INDEPENDENTLY cross-checked -------------------
# Deriving $BOARD as dirname(--git-common-dir) and then asserting it equals
# dirname(--git-common-dir) is a tautology: it cannot fail, including on a linked worktree,
# where it silently retargets. The checks below are the ones that can actually fail — the
# candidate must be a working tree whose own top level is itself (false for a bare repo and
# for a .git directory), must look like a board, and must match what the ENGINE's own
# resolver reports, which is a second, independent derivation.
resolve_board() {
  local wc=$1 common board top
  common=$(git -C "$wc" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || die "$wc is not a git repository"
  board=$(dirname -- "$common")
  top=$(git -C "$board" rev-parse --show-toplevel 2>/dev/null) \
    || die "$board is not a working tree (bare repo, or a .git directory) — refusing"
  [ "$(cd -- "$top" && pwd -P)" = "$(cd -- "$board" && pwd -P)" ] \
    || die "$board is not the top level of its own working tree — refusing"
  [ -f "$board/blaze.config.json" ] || die "$board has no blaze.config.json — is this the board?"
  [ -d "$board/projects" ]          || die "$board has no projects/ — is this the board?"
  printf '%s' "$board"
}

assert_engine_agrees() {
  local board=$1 wc=$2 reported
  reported=$( (cd -- "$wc" && ${BLAZE_STATUS_CMD}) 2>/dev/null | sed -n '1s/.*queue store \([^ ]*\).*/\1/p' ) || true
  [ -n "$reported" ] || die "could not read the queue store from: $BLAZE_STATUS_CMD (run in $wc)"
  [ "$reported" = "$board" ] \
    || die "the engine resolves the store to '$reported' but this script derived '$board' — do not migrate until they agree"
}

# --- every working copy, NUL-delimited ----------------------------------------
# `git worktree list` and not a glob: on the board this was written for a
# `<board>-worktrees/*` glob finds 4 working copies where git reports 9.
working_copies() {
  git -C "$1" worktree list --porcelain | sed -n 's/^worktree //p' | tr '\n' '\0'
}

assert_regular_readable() {
  [ -f "$1" ] || die "$1 is not a regular file (FIFO, socket or directory) — refusing to read it"
  [ -r "$1" ] || die "$1 is not readable — refusing, because an unreadable queue must never be counted as zero"
}

# Command substitution strips trailing newlines, so this is empty iff the last byte is one.
ends_with_newline() { [ ! -s "$1" ] || [ -z "$(tail -c1 -- "$1")" ]; }

# How many LEADING lines of $src are already at the end of $dest?
#
# "All or nothing" was not enough. A partial append that stopped on a LINE BOUNDARY — a crash, a
# full disk — leaves the destination holding a prefix of the source. A whole-file comparison
# never matches that, so the resume appended the whole source again and the overlap was
# duplicated silently, exit 0, with the SHA-256 check passing because it hashes
# `dest-as-is || src`. The trailing-newline guard only catches a partial that stopped MID-line.
#
# So the question is "how much of it is already there", not "is all of it there". Descending
# from the whole file, so the two common answers (all, none) cost one or two comparisons.
appended_prefix_lines() {
  local dest=$1 src=$2 k bytes destsize
  [ -e "$dest" ] || { printf 0; return 0; }
  destsize=$(wc -c < "$dest")
  k=$(wc -l < "$src")
  while [ "$k" -gt 0 ]; do
    bytes=$(head -n "$k" -- "$src" | wc -c)
    if [ "$destsize" -ge "$bytes" ] \
       && [ "$(tail -c "$bytes" -- "$dest" | sha256sum)" = "$(head -n "$k" -- "$src" | sha256sum)" ]; then
      printf '%s' "$k"; return 0
    fi
    k=$((k - 1))
  done
  printf 0
}

# --- provenance (BLZ-602) -----------------------------------------------------
# STAMP `worktree` ONTO EVERY LINE THAT DOES NOT ALREADY RECORD `worktree`.
#
# `worktree` specifically, not "provenance": a line recording only `branch` IS stamped. That
# converts a branch-claimable op into a worktree-claimable one, which is the stronger fact —
# `queuedHere` decides on `worktree` first, and a branch can move between checkouts while the
# path the file was written under cannot. On the live board measured 2026-09-09, 19 of 32 ops
# were branch-only, so this is the common case, and it is said here rather than left implied.
#
# This script used to append lines byte-verbatim, and the runbook told the operator the ops
# "need no rewriting". That is true of every op queued after INF-673 and false of exactly the
# ones a migration exists to move. BLZ-590 made the store's own working tree the SOLE CLAIMANT
# of an op recording neither `worktree` nor `branch`, so a pre-INF-673 op carried out of a
# LANE's own .blaze/ and appended here unchanged is then claimed by the MAIN tree, found in
# none of its three trees, classified `superseded`, and CLEARED AT EXIT 0 — while the lane's
# file sits uncommitted and the record that would lead anyone back to it is destroyed.
#
# The stamp is the source copy's path RELATIVE TO THE STORE, which is exactly what the engine
# computes as `here.worktree` (`relative(store, dataRoot)`) and compares against. It is
# computed by node's own `path.relative` rather than by shell string surgery, so the two
# derivations cannot drift apart.
#
# THREE RULES, and each one is a way this can destroy evidence rather than preserve it:
#   * A line that ALREADY records `worktree` is emitted BYTE-VERBATIM. Overwriting it would
#     replace the only fact that says where the work is; re-serialising it would normalise a
#     line this engine did not write, and the ledger is append-only evidence.
#   * A line that will not parse is REFUSED, and nothing is written. Injecting a field into
#     text with a regex is how a migration fuses two records into one.
#   * Bytes in, bytes out. `buf.toString()` maps an incomplete trailing multibyte sequence to
#     U+FFFD, which re-encodes as three bytes that were never there — the same reason
#     `parseRecords` splits the buffer rather than the string.
stamp_stream() {  # usage: stamp_stream <board> <working-copy> <queue-file>   (stamped -> stdout)
  node -e '
const { readFileSync } = require("node:fs");
const { relative } = require("node:path");
function main([board, wc, file]) {
  const rel = relative(board, wc);
  const buf = readFileSync(file);
  const out = [];
  let start = 0, lineNo = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    const raw = buf.subarray(start, end);
    lineNo++;
    const text = raw.toString("utf8");
    if (text.trim() === "") out.push(Buffer.from(raw));
    else {
      let entry;
      try { entry = JSON.parse(text); } catch {
        process.stderr.write(`STOP: ${file} line ${lineNo} is not valid JSON — refusing to stamp text this migration could not read. Fix or quarantine that line, then re-run.\n`);
        return 1;
      }
      out.push(entry.worktree === undefined || entry.worktree === null
        ? Buffer.from(JSON.stringify({ ...entry, worktree: rel }), "utf8")
        : Buffer.from(raw));
    }
    if (nl !== -1) out.push(Buffer.from("\n"));
    start = end + 1;
  }
  process.stdout.write(Buffer.concat(out));
  return 0;
}
process.exitCode = main(process.argv.slice(1));
' "$1" "$2" "$3"
}

cmd_stamp() {
  local wc=$1 f=$2 board
  [ -d "$wc" ] || die "$wc is not a directory"
  board=$(resolve_board "$wc")
  assert_regular_readable "$f"
  stamp_stream "$board" "$wc" "$f"
}

count_checked() {   # usage: assert_regular_readable "$f" first, in the caller
  local n; n=$(grep -c . -- "$1" || true)
  printf '%s' "${n:-0}"
}

queue_files() {  # NUL-delimited queue files of one working copy
  local wc=$1
  [ -d "$wc/.blaze/pending" ] && find "$wc/.blaze/pending" -maxdepth 1 -name '*.jsonl' -print0 || true
  [ -e "$wc/.blaze/pending-commit.jsonl" ] && printf '%s\0' "$wc/.blaze/pending-commit.jsonl" || true
}

assert_quiesced() {
  local board=$1 running wc
  # Matched on the EXECUTABLE plus its arguments, not on the raw command line: `pgrep -f`
  # matches any process whose command line merely contains the words — this script's own
  # invocation, the editor holding the runbook, the shell that pasted it — and a false
  # "blaze is running" that the operator learns to ignore is worse than no check at all.
  running=$(ps -eo pid=,comm=,args= 2>/dev/null \
    | awk '$2 ~ /^node/ && $0 ~ /(commit-runner|reconcile)\.mjs/ { print $1 }' || true)
  [ -z "$running" ] || die "blaze is running (pids: $(echo "$running" | tr '\n' ' ')) — stop every writer first"
  while IFS= read -r -d '' wc; do
    [ -e "$wc/.blaze/commit.lock" ] && die "a commit.lock is held in $wc — a flush is in progress"
  done < <(working_copies "$board")
  return 0
}

cmd_count() {
  local board wc n total=0
  board=$(resolve_board "${1:-$PWD}")
  note "board: $board"
  while IFS= read -r -d '' wc; do
    if [ ! -d "$wc" ]; then printf '%-70s (pruned, no working copy on disk)\n' "$wc"; continue; fi
    n=0
    while IFS= read -r -d '' f; do
      assert_regular_readable "$f"          # in THIS shell, so a refusal stops the run
      n=$((n + $(count_checked "$f")))
    done < <(queue_files "$wc")
    total=$((total + n))
    printf '%-70s ops=%s\n' "$wc" "$n"
  done < <(working_copies "$board")
  printf 'TOTAL=%s\n' "$total"
}

cmd_migrate() {
  local wc=$1 board store hold f rel dest holddest marker n lines done_lines rem stamped expected actual moved=0 appended=0
  [ -d "$wc" ] || die "$wc is not a directory"
  board=$(resolve_board "$wc")
  assert_engine_agrees "$board" "$wc"
  [ "$(cd -- "$wc" && pwd -P)" != "$(cd -- "$board" && pwd -P)" ] \
    || die "$wc IS the store — there is nothing to migrate from the main checkout"
  assert_quiesced "$board"

  store="$board/.blaze/pending"
  hold="$wc/.blaze/migrated-$(date +%Y%m%d-%H%M%S)"
  mkdir -p -- "$store" "$hold"

  while IFS= read -r -d '' f; do
    assert_regular_readable "$f"
    # The LEGACY fallback ledger is one EXACT path, not a suffix. `*/pending-commit.jsonl` also
    # matched `<wc>/.blaze/pending/pending-commit.jsonl` — an ordinary session queue that happens
    # to be named `pending-commit` — and routed it to the board's legacy ledger instead of the
    # store; both sources then landed on the same `$hold/pending-commit.jsonl` and the first held
    # copy was destroyed, taking the rollback with it.
    rel=${f#"$wc/.blaze/"}
    if [ "$f" = "$wc/.blaze/pending-commit.jsonl" ]; then
      dest="$board/.blaze/pending-commit.jsonl"
    else
      dest="$store/$(basename -- "$f")"
    fi
    # Hold and marker MIRROR the source's own relative path, so two sources can never collide on
    # one hold filename however they are named.
    holddest="$hold/$rel"
    marker="$wc/.blaze/migrating/$rel"
    mkdir -p -- "$(dirname -- "$holddest")" "$(dirname -- "$marker")"

    n=$(count_checked "$f")               # $f already asserted regular+readable above
    if [ "$n" -eq 0 ]; then
      mv -- "$f" "$holddest" || die "could not move the empty $f aside"
      rm -f -- "$marker"; moved=$((moved + 1)); continue
    fi
    ends_with_newline "$f" \
      || die "$f does not end in a newline — appending it would FUSE its last op onto the next line. Fix the source, then re-run."
    [ -e "$dest" ] || : > "$dest"
    assert_regular_readable "$dest"
    ends_with_newline "$dest" \
      || die "$dest does not end in a newline — appending would fuse two ops. Fix the destination, then re-run."

    # The resume is keyed on the SOURCE PATH, through a marker written before the first append —
    # not on content. Keyed on content, two working copies holding byte-identical queue files
    # made the second look already-migrated and its ops were dropped from the store (exit 0). A
    # marker exists only for a source THIS script has already begun, which is the only state in
    # which a resume may assume anything.
    # BLZ-602: everything below reasons about the STAMPED stream, because that is what lands
    # in the store. The resume's prefix detection compares the destination's tail against the
    # source's leading lines, so comparing the UNSTAMPED source would never match what was
    # actually appended and every resume would append the whole file a second time. `$f`
    # itself is never rewritten — the original is what gets moved aside, intact.
    stamped="$hold/.stamped.$$"
    stamp_stream "$board" "$wc" "$f" > "$stamped"
    lines=$(wc -l < "$stamped")
    done_lines=0
    if [ -e "$marker" ]; then
      done_lines=$(appended_prefix_lines "$dest" "$stamped")
      [ "$done_lines" -eq 0 ] \
        || note "resuming: $done_lines of $lines line(s) of $f are already in $dest"
    else
      printf '%s\n' "$dest" > "$marker"
    fi

    if [ "$done_lines" -lt "$lines" ]; then
      rem="$hold/.remainder.$$"
      tail -n +$((done_lines + 1)) -- "$stamped" > "$rem"
      # What $dest must become, hashed BEFORE the append. `cat` failing on an unreadable or
      # unseekable source fails the whole substitution under `set -o pipefail`, so this cannot
      # pass vacuously the way a line count could.
      expected=$(cat -- "$dest" "$rem" | sha256sum | cut -d' ' -f1)
      assert_quiesced "$board"          # immediately before the write, not once at the start
      cat -- "$rem" >> "$dest"
      actual=$(sha256sum < "$dest" | cut -d' ' -f1)
      rm -f -- "$rem"
      [ "$expected" = "$actual" ] \
        || die "$dest is not the concatenation of its previous contents and the un-migrated part of $f. The source has NOT been moved. Do not re-run; inspect both files."
      appended=$((appended + n - done_lines))
    fi
    mv -- "$f" "$holddest" \
      || die "$f was appended to $dest but could NOT be moved aside.
  Fix the permissions on $(dirname -- "$f"), then RE-RUN THIS WORKING COPY BEFORE MIGRATING ANY OTHER.
  The re-run detects the completed append and will not repeat it -- but that detection reads the
  TAIL of $dest, so if another working copy appends to the same destination first, the tail no
  longer matches and this source is appended a SECOND time. Migrating this copy before any other
  is what keeps that impossible."
    rm -f -- "$marker" "$stamped"
    moved=$((moved + 1))
  done < <(queue_files "$wc")

  printf 'migrated %s: %s file(s), %s op(s) appended; sources held at %s\n' "$wc" "$moved" "$appended" "$hold"
}

case "${1:-}" in
  count)   shift; cmd_count "${1:-$PWD}" ;;
  stamp)   shift; [ $# -eq 2 ] || die "usage: migrate-queue-store.sh stamp <working-copy> <queue-file>"; cmd_stamp "$1" "$2" ;;
  migrate) shift; [ $# -eq 1 ] || die "usage: migrate-queue-store.sh migrate <working-copy>"; cmd_migrate "$1" ;;
  *) die "usage: migrate-queue-store.sh count [working-copy] | stamp <working-copy> <queue-file> | migrate <working-copy>" ;;
esac
