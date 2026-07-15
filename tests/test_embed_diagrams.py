import unittest, tempfile, os
from pathlib import Path
import importlib.util

import sys
def load():
    spec = importlib.util.spec_from_file_location("embed_diagrams",
        Path(__file__).resolve().parent.parent / "scripts" / "embed_diagrams.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m          # REQUIRED: @dataclass at import needs the module registered
    spec.loader.exec_module(m); return m

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


if __name__ == "__main__":
    unittest.main()
