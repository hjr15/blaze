"""Sync inline-embedded diagrams in this repo from their canonical sources in docs/diagrams/.

Each diagram is authored once under docs/diagrams/<slug>.md; other docs embed a
synced copy between `<!-- DIAGRAM:BEGIN docs/diagrams/<slug>.md -->` and
`<!-- DIAGRAM:END -->` markers. Run this script to regenerate every embed, or with
`--check` to verify they are in sync (exit 1 if stale). See docs/diagrams/_README.md.
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

BEGIN_RE = re.compile(r"<!--\s*DIAGRAM:BEGIN\s+([^\s>]+)\s*-->")
END_RE = re.compile(r"<!--\s*DIAGRAM:END\s*-->")


@dataclass
class Marker:
    canonical_path: str
    begin_line: int  # 0-indexed line containing BEGIN
    end_line: int    # 0-indexed line containing END


def find_markers(file_path: Path) -> list[Marker]:
    lines = file_path.read_text().splitlines()
    markers: list[Marker] = []
    pending: tuple[int, str] | None = None
    for i, line in enumerate(lines):
        begin = BEGIN_RE.search(line)
        if begin:
            if pending is not None:
                raise ValueError(f"{file_path}:{i+1}: nested DIAGRAM:BEGIN before previous END")
            pending = (i, begin.group(1))
            continue
        if END_RE.search(line):
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
    """Return 1-indexed line numbers of ```mermaid fences outside DIAGRAM:BEGIN/END blocks.
    Files inside docs/diagrams/ are exempt (they are the canonical source)."""
    if "docs/diagrams/" in str(file_path).replace("\\", "/"):
        return []
    lines = file_path.read_text().splitlines()
    rogue: list[int] = []
    in_marker_block = False
    for i, line in enumerate(lines):
        if BEGIN_RE.search(line):
            in_marker_block = True
            continue
        if END_RE.search(line):
            in_marker_block = False
            continue
        if line.strip().startswith("```mermaid") and not in_marker_block:
            rogue.append(i + 1)
    return rogue


SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "site", "dist", "build", ".next", "fixtures", "overlay",
             # Gitignored, not this repo's canonical docs: session state + nested
             # git worktrees (.claude/worktrees/*) and external tool clones.
             ".claude", "awesome-claude-plugins"}


def walk_markdown(repo_root: Path):
    """Yield every .md file in the repo, skipping common ignore dirs."""
    for path in repo_root.rglob("*.md"):
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
    args = parser.parse_args(argv)

    rogues_total: list[str] = []
    stale_files: list[str] = []
    updated_files: list[str] = []
    errors: list[str] = []

    for md in walk_markdown(args.repo_root):
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
        print(f"OK: all embeds in sync ({sum(1 for _ in walk_markdown(args.repo_root))} files scanned)")
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
