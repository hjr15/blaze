"""Sync inline-embedded diagrams in this repo from their canonical sources in docs/diagrams/.

Each diagram is authored once under docs/diagrams/<slug>.md; other docs embed a
synced copy between `<!-- DIAGRAM:BEGIN docs/diagrams/<slug>.md -->` and
`<!-- DIAGRAM:END -->` markers. Run this script to regenerate every embed, or with
`--check` to verify they are in sync (exit 1 if stale). See docs/diagrams/_README.md.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# A canonical embed path is always repo-root-relative to a docs/diagrams/<slug>.md
# file, so it always contains a "/". Requiring one means a placeholder such as a
# bare "…" ellipsis (written in prose to *describe* the convention) is not mistaken
# for a real marker. This is the first of two defences; the second is that markers
# inside fenced code blocks or inline-code spans are skipped entirely — see
# _iter_content_lines(). Together they let a doc document the convention without
# tripping the checker (BLZ-106).
BEGIN_RE = re.compile(r"<!--\s*DIAGRAM:BEGIN\s+([^\s>]*/[^\s>]*)\s*-->")
END_RE = re.compile(r"<!--\s*DIAGRAM:END\s*-->")

# Opening/closing fence line: >=3 backticks or tildes, optional leading whitespace,
# with any info string captured in group 3 (a closing fence has an empty info string).
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")


def _strip_inline_code(line: str) -> str:
    """Blank out inline-code spans (backtick-delimited) so a marker documented
    inside one is not read as a real marker. Span contents and their delimiters
    are replaced with spaces, preserving column positions for error messages."""
    out: list[str] = []
    i, n = 0, len(line)
    while i < n:
        if line[i] == "`":
            j = i
            while j < n and line[j] == "`":
                j += 1
            delim = line[i:j]
            close = line.find(delim, j)
            if close == -1:
                out.append(line[i:])  # unterminated run — not a span, keep as-is
                break
            out.append(" " * (close + len(delim) - i))
            i = close + len(delim)
        else:
            out.append(line[i])
            i += 1
    return "".join(out)


def _iter_content_lines(lines: list[str]):
    """Yield (index, effective_line) for each source line. Lines inside a fenced
    code block yield "" (no marker detection fires inside code); lines outside a
    fence have inline-code spans blanked. Fence nesting is length-aware: a run of
    N fence chars is closed only by a run of >= N of the same char with no info
    string, so a ```mermaid block shown inside a ````markdown example is treated
    as fenced content, not as a new fence.

    A fence left unclosed at end-of-file therefore extends to EOF and any markers
    after it are ignored. This is CommonMark-consistent (an unclosed fence renders
    everything below it as a code block, so the doc is already visibly broken) and
    is the accepted trade for ignoring markers documented inside code."""
    fence: tuple[str, int] | None = None
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if fence is None:
            if m:
                fence = (m.group(1)[0], len(m.group(1)))
                yield i, ""
            else:
                yield i, _strip_inline_code(line)
        else:
            char, length = fence
            if m and m.group(1)[0] == char and len(m.group(1)) >= length and m.group(2).strip() == "":
                fence = None
            yield i, ""


@dataclass
class Marker:
    canonical_path: str
    begin_line: int  # 0-indexed line containing BEGIN
    end_line: int    # 0-indexed line containing END


def find_markers(file_path: Path) -> list[Marker]:
    lines = file_path.read_text().splitlines()
    markers: list[Marker] = []
    pending: tuple[int, str] | None = None
    for i, content in _iter_content_lines(lines):
        begin = BEGIN_RE.search(content)
        if begin:
            if pending is not None:
                raise ValueError(f"{file_path}:{i+1}: nested DIAGRAM:BEGIN before previous END")
            pending = (i, begin.group(1))
            continue
        if END_RE.search(content):
            if pending is None:
                raise ValueError(f"{file_path}:{i+1}: DIAGRAM:END without matching BEGIN")
            markers.append(Marker(canonical_path=pending[1], begin_line=pending[0], end_line=i))
            pending = None
    if pending is not None:
        raise ValueError(f"{file_path}:{pending[0]+1}: DIAGRAM:BEGIN without matching END")
    return markers


def extract_code_block(canonical_path: Path) -> str:
    """Read a docs/diagrams/<slug>.md file and return the single code block including fences.
    Raises ValueError if zero or more than one code block is present."""
    content = canonical_path.read_text()
    lines = content.splitlines()
    block_starts: list[int] = []
    block_ends: list[int] = []
    in_block = False
    for i, line in enumerate(lines):
        if line.startswith("```"):
            if not in_block:
                block_starts.append(i)
                in_block = True
            else:
                block_ends.append(i)
                in_block = False
    if len(block_starts) != 1 or len(block_ends) != 1:
        raise ValueError(
            f"{canonical_path}: expected exactly one code block, found {len(block_starts)} starts / {len(block_ends)} ends"
        )
    return "\n".join(lines[block_starts[0]:block_ends[0] + 1])


def compute_synced_text(file_path: Path, repo_root: Path) -> str | None:
    """Pure helper: return what the file's text would be after sync.

    Returns None if the file has no DIAGRAM markers (nothing to do).
    Always returns a string when markers exist, even if it equals the
    original — callers compare to decide whether to write.
    """
    original = file_path.read_text()
    markers = find_markers(file_path)
    if not markers:
        return None
    lines = original.splitlines()
    # Apply replacements bottom-up so earlier indices stay valid
    for marker in sorted(markers, key=lambda m: m.begin_line, reverse=True):
        canonical = repo_root / marker.canonical_path
        if not canonical.is_file():
            raise FileNotFoundError(
                f"{file_path}:{marker.begin_line + 1}: DIAGRAM:BEGIN references missing file {marker.canonical_path}"
            )
        block = extract_code_block(canonical)
        block_lines = block.splitlines()
        # Replace lines (begin_line+1) through (end_line-1) inclusive with block_lines
        lines = lines[:marker.begin_line + 1] + block_lines + lines[marker.end_line:]
    new_text = "\n".join(lines)
    # Preserve trailing newline if original had one
    if original.endswith("\n"):
        new_text += "\n"
    return new_text


def sync_file(file_path: Path, repo_root: Path) -> bool:
    """Sync inline-embedded diagrams in this file. Returns True if the file changed on disk."""
    new_text = compute_synced_text(file_path, repo_root)
    if new_text is None:
        return False
    if new_text == file_path.read_text():
        return False
    file_path.write_text(new_text)
    return True


def find_rogue_mermaid(file_path: Path) -> list[int]:
    """Return 1-indexed line numbers of ```mermaid fences that open at the top level
    outside a DIAGRAM:BEGIN/END block. A ```mermaid shown as an example inside an
    outer documentation fence (e.g. a ````markdown block) is not rogue, and markers
    written inside inline-code are ignored. Files inside docs/diagrams/ are exempt
    (they are the canonical source)."""
    if "docs/diagrams/" in str(file_path).replace("\\", "/"):
        return []
    lines = file_path.read_text().splitlines()
    rogue: list[int] = []
    fence: tuple[str, int] | None = None
    in_marker_block = False
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if fence is None:
            content = _strip_inline_code(line)
            if BEGIN_RE.search(content):
                in_marker_block = True
                continue
            if END_RE.search(content):
                in_marker_block = False
                continue
            if m:
                fence = (m.group(1)[0], len(m.group(1)))
                if m.group(2).strip().lower().startswith("mermaid") and not in_marker_block:
                    rogue.append(i + 1)
        elif m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1] and m.group(2).strip() == "":
            fence = None
    return rogue


SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "site", "dist", "build", ".next", "fixtures", "overlay",
             # Gitignored, not this repo's canonical docs: session state + nested
             # git worktrees (.claude/worktrees/*) and external tool clones.
             ".claude", "awesome-claude-plugins"}


def _git_tracked_markdown(repo_root: Path):
    """Yield every git-tracked (committed or staged) .md file under repo_root.
    Used by the pre-commit path so an untracked stray never enters the scan."""
    out = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "-z"],
        capture_output=True, text=True, check=True,
    )
    for rel in out.stdout.split("\0"):
        if rel.endswith(".md"):
            path = repo_root / rel
            # git ls-files lists index entries, which include tracked files that
            # have been deleted in the working tree (e.g. by a concurrent session).
            # Only yield those still on disk — there is nothing to sync/check for a
            # file that is not there.
            if path.is_file():
                yield path


def walk_markdown(repo_root: Path, tracked_only: bool = False):
    """Yield every .md file in the repo, skipping common ignore dirs.

    tracked_only=True restricts the scan to git-tracked/staged files (for the
    pre-commit hook — an uncommitted stray must not block an unrelated commit).
    The default scans the whole working tree (for CI / manual `--check`)."""
    candidates = None
    if tracked_only:
        try:
            candidates = list(_git_tracked_markdown(repo_root))
        except (subprocess.CalledProcessError, FileNotFoundError):
            # repo_root is not a git repo (or git is unavailable). --tracked-only is
            # a pre-commit optimisation; outside git, fall back to a full scan (the
            # safe superset) rather than crash with an uncaught subprocess error.
            candidates = None
    if candidates is None:
        candidates = repo_root.rglob("*.md")
    for path in candidates:
        rel = path.relative_to(repo_root)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        yield path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync inline-embedded diagrams from docs/diagrams/.")
    parser.add_argument("--check", action="store_true", help="Read-only; exit non-zero if any embed is stale.")
    parser.add_argument(
        "--list-modified",
        action="store_true",
        help="Sync as normal, but print only the paths of files modified (one per line) to stdout. "
        "Suppresses the human-readable 'Updated:' / 'No changes' output. Intended for hook integration.",
    )
    parser.add_argument("--repo-root", type=Path, default=Path.cwd(), help="Repo root (default: cwd).")
    parser.add_argument(
        "--tracked-only",
        action="store_true",
        help="Scan only git-tracked/staged .md files, not untracked strays. Use from the "
        "pre-commit hook so an uncommitted work-in-progress doc can never block an unrelated commit.",
    )
    args = parser.parse_args(argv)

    rogues_total: list[str] = []
    stale_files: list[str] = []
    updated_files: list[str] = []
    errors: list[str] = []

    for md in walk_markdown(args.repo_root, tracked_only=args.tracked_only):
        try:
            rogues = find_rogue_mermaid(md)
            for line in rogues:
                rogues_total.append(f"{md}:{line}")

            if args.check:
                new_text = compute_synced_text(md, repo_root=args.repo_root)
                if new_text is not None and new_text != md.read_text():
                    stale_files.append(str(md))
            else:
                if sync_file(md, repo_root=args.repo_root):
                    updated_files.append(str(md))
        except (ValueError, FileNotFoundError) as e:
            errors.append(str(e))

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 2

    if rogues_total:
        print("Rogue ```mermaid fences found outside docs/diagrams/ and outside DIAGRAM markers:", file=sys.stderr)
        for r in rogues_total:
            print(f"  {r}", file=sys.stderr)
        return 2

    if args.check:
        if stale_files:
            print("Stale embedded diagrams (run without --check to update):", file=sys.stderr)
            for f in stale_files:
                print(f"  {f}", file=sys.stderr)
            return 1
        print(f"OK: all embeds in sync ({sum(1 for _ in walk_markdown(args.repo_root, tracked_only=args.tracked_only))} files scanned)")
        return 0

    if args.list_modified:
        # Machine-readable: one path per line, no prose. Empty output is valid.
        for f in updated_files:
            print(f)
        return 0

    if updated_files:
        print("Updated:")
        for f in updated_files:
            print(f"  {f}")
    else:
        print("No changes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
