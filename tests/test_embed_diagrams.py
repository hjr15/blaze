import unittest, tempfile, os, subprocess
from pathlib import Path
import importlib.util

import sys
def load():
    spec = importlib.util.spec_from_file_location("embed_diagrams",
        Path(__file__).resolve().parent.parent / "scripts" / "embed_diagrams.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m          # REQUIRED: @dataclass at import needs the module registered
    spec.loader.exec_module(m); return m

# Build markers from parts so this test file never itself contains a literal,
# unmatched BEGIN/END marker the doc tooling could trip over.
B = "<!-- DIAGRAM:BEGIN "
E = "<!-- DIAGRAM:END -->"


def _write(tmp, name, text):
    p = Path(tmp) / name
    p.write_text(text)
    return p

class WalkTest(unittest.TestCase):
    def test_ancestor_dotclaude_not_pruned_but_nested_is(self):
        ed = load()
        with tempfile.TemporaryDirectory() as outer:
            root = Path(outer) / ".claude" / "worktrees" / "b"   # .claude is an ANCESTOR
            (root / "docs").mkdir(parents=True)
            (root / "docs" / "x.md").write_text("# x\n")
            (root / ".claude").mkdir()                            # nested .claude INSIDE the tree
            (root / ".claude" / "y.md").write_text("# y\n")
            found = [str(p) for p in ed.walk_markdown(root)]      # repo_root = the worktree root
            self.assertTrue(any(p.endswith("docs/x.md") for p in found), found)
            self.assertFalse(any(p.endswith(".claude/y.md") for p in found), found)


class MarkerParsingTest(unittest.TestCase):
    """BLZ-106: a prose/placeholder marker must not be read as a real embed marker."""

    def test_ellipsis_placeholder_in_inline_code_is_not_a_marker(self):
        # The ticket's own regression case: a doc describing the convention with an
        # ellipsis placeholder path, inside an inline-code span, with no matching END.
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "prose.md",
                       f"# About embeds\n\nWrap it in `{B}… -->` and `{E}` markers.\n")
            self.assertEqual(ed.find_markers(p), [])  # must NOT raise, must find nothing

    def test_bare_ellipsis_marker_in_plain_prose_is_not_a_marker(self):
        # Path-tightening layer: even outside a code span, a placeholder path with no
        # slash is not a real canonical path (docs/diagrams/<slug>.md always has a "/").
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "prose.md", f"# Doc\n\n{B}… -->\n\nsome text\n")
            self.assertEqual(ed.find_markers(p), [])

    def test_real_path_marker_inside_fenced_block_is_ignored(self):
        # Fence-skip layer: a real-looking path inside a ``` fence is documentation,
        # not an embed — even unmatched it must not raise.
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "howto.md",
                       f"# How to embed\n\n```markdown\n{B}docs/diagrams/x.md -->\n```\n")
            self.assertEqual(ed.find_markers(p), [])

    def test_marker_in_inline_span_with_real_path_ignored(self):
        # Inline-code span with a REAL path — path-tightening alone would not catch
        # this; the inline-code skip must.
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "howto.md",
                       f"See `{B}docs/diagrams/x.md -->` for the marker format.\n")
            self.assertEqual(ed.find_markers(p), [])

    def test_nested_fence_readme_style_ignored(self):
        # _README.md documents the convention inside a 4-backtick fence that itself
        # contains a 3-backtick ```mermaid block. The inner markers are docs, not an
        # embed, so they must be ignored (the 3-backtick lines must not close the
        # 4-backtick fence).
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "_README.md",
                       "# Diagrams\n\n"
                       "````markdown\n"
                       f"{B}docs/diagrams/architecture.md -->\n"
                       "```mermaid\nflowchart TB\n  A-->B\n```\n"
                       f"{E}\n"
                       "````\n")
            self.assertEqual(ed.find_markers(p), [])

    def test_real_embed_markers_at_top_level_still_parsed(self):
        # Guard: a genuine embed (markers at fence-depth 0, real path) must still parse.
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "README.md",
                       f"# Repo\n\n{B}docs/diagrams/architecture.md -->\n"
                       "```mermaid\nflowchart TB\n  A-->B\n```\n"
                       f"{E}\n")
            markers = ed.find_markers(p)
            self.assertEqual(len(markers), 1)
            self.assertEqual(markers[0].canonical_path, "docs/diagrams/architecture.md")

    def test_real_embed_still_syncs_end_to_end(self):
        # Guard: compute_synced_text must still replace a real embed's body from source.
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "docs" / "diagrams").mkdir(parents=True)
            _write(tmp, "docs/diagrams/x.md",
                   "---\ntitle: X\n---\n```mermaid\nflowchart TB\n  A-->B\n```\n")
            p = _write(tmp, "README.md",
                       f"{B}docs/diagrams/x.md -->\nSTALE\n{E}\n")
            synced = ed.compute_synced_text(p, repo_root=Path(tmp))
            self.assertIn("flowchart TB", synced)
            self.assertNotIn("STALE", synced)


class RogueMermaidFenceTest(unittest.TestCase):
    def test_mermaid_fence_inside_doc_fence_not_flagged_rogue(self):
        # A ```mermaid shown as an example inside a 4-backtick documentation fence is
        # not a rogue un-embedded diagram.
        ed = load()
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "guide.md",
                       "# Guide\n\n````markdown\n```mermaid\nflowchart TB\n  A-->B\n```\n````\n")
            self.assertEqual(ed.find_rogue_mermaid(p), [])


class TrackedOnlyWalkTest(unittest.TestCase):
    """BLZ-106 AC2: the pre-commit path must not scan untracked strays."""

    def _git(self, root, *args):
        subprocess.run(["git", *args], cwd=root, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_walk_tracked_only_excludes_untracked_files(self):
        ed = load()
        with tempfile.TemporaryDirectory() as root:
            self._git(root, "init", "-q")
            self._git(root, "config", "user.email", "t@t")
            self._git(root, "config", "user.name", "t")
            (Path(root) / "tracked.md").write_text("# tracked\n")
            self._git(root, "add", "tracked.md")
            (Path(root) / "stray.md").write_text("# stray\n")  # untracked
            tracked = [p.name for p in ed.walk_markdown(Path(root), tracked_only=True)]
            allfiles = [p.name for p in ed.walk_markdown(Path(root))]
            self.assertIn("tracked.md", tracked)
            self.assertNotIn("stray.md", tracked)
            self.assertIn("stray.md", allfiles)  # default (CI) still sees everything

    def test_tracked_only_skips_tracked_file_deleted_in_worktree(self):
        # git ls-files lists index entries incl. files deleted on disk by a
        # concurrent session; walk must skip them, not crash on read.
        ed = load()
        with tempfile.TemporaryDirectory() as root:
            self._git(root, "init", "-q")
            self._git(root, "config", "user.email", "t@t")
            self._git(root, "config", "user.name", "t")
            (Path(root) / "gone.md").write_text("# gone\n")
            (Path(root) / "here.md").write_text("# here\n")
            self._git(root, "add", "gone.md", "here.md")
            (Path(root) / "gone.md").unlink()  # tracked in index, absent on disk
            names = [p.name for p in ed.walk_markdown(Path(root), tracked_only=True)]
            self.assertIn("here.md", names)
            self.assertNotIn("gone.md", names)

    def test_tracked_only_on_non_git_dir_falls_back_not_crash(self):
        # A non-git repo_root must not raise an uncaught subprocess error — it falls
        # back to a full scan (the safe superset).
        ed = load()
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "a.md").write_text("# a\n")
            found = [p.name for p in ed.walk_markdown(Path(root), tracked_only=True)]
            self.assertIn("a.md", found)


if __name__ == "__main__":
    unittest.main()
