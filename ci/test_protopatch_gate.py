#!/usr/bin/env python3
"""The gate's scope + waive semantics (protoAgent#1874). Run: python3 ci/test_protopatch_gate.py"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "protopatch-gate.py")

_spec = importlib.util.spec_from_file_location("gate", GATE)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def report_block(sev="high", cat="bug", fid="f-1", title="Broken thing.", evidence=("lib/feed.ts:40-44",)):
    ev = "\n".join(f"- {e}" for e in evidence)
    return f"## {sev}: {title}\nid: {fid}\ncategory: {cat}\nevidence:\n{ev}\n"


DIFF = """diff --git a/lib/feed.ts b/lib/feed.ts
index 111..222 100644
--- a/lib/feed.ts
+++ b/lib/feed.ts
@@ -10,4 +10,6 @@
 context
+added
+added
 context
@@ -100,3 +102,0 @@
-removed
-removed
-removed
"""


class ParseTests(unittest.TestCase):
    def test_changed_ranges_from_unified_diff(self):
        ranges = gate.parse_changed_ranges(DIFF)
        self.assertEqual(ranges["lib/feed.ts"][0], (10, 15))
        # Pure deletion keeps a point range at the seam.
        self.assertEqual(ranges["lib/feed.ts"][1], (102, 102))

    def test_evidence_refs_all_label_shapes(self):
        block = "evidence:\n- a.ts:12-34 (fn)\n- b.ts:42\n- c.ts\n"
        self.assertEqual(
            gate.evidence_refs(block),
            [("a.ts", 12, 34), ("b.ts", 42, 42), ("c.ts", None, None)],
        )

    def test_waiver_lines_parse_with_and_without_reason(self):
        body = "Some PR prose.\nprotopatch-waive: f-abc — pre-existing, tracked in #431\nprotopatch-waive: f-def\n"
        self.assertEqual(gate.parse_waivers(body), {"f-abc": "pre-existing, tracked in #431", "f-def": ""})


class ScopeTests(unittest.TestCase):
    def test_evidence_inside_hunk_touches(self):
        ranges = {"lib/feed.ts": [(10, 15)]}
        self.assertTrue(gate.touches_changed_lines([("lib/feed.ts", 12, 13)], ranges))

    def test_evidence_within_margin_touches(self):
        ranges = {"lib/feed.ts": [(10, 15)]}
        self.assertTrue(gate.touches_changed_lines([("lib/feed.ts", 17, 18)], ranges))  # 15+3

    def test_evidence_far_away_does_not_touch(self):
        ranges = {"lib/feed.ts": [(10, 15)]}
        self.assertFalse(gate.touches_changed_lines([("lib/feed.ts", 40, 44)], ranges))

    def test_lineless_evidence_on_touched_file_blocks_conservatively(self):
        ranges = {"lib/feed.ts": [(10, 15)]}
        self.assertTrue(gate.touches_changed_lines([("lib/feed.ts", None, None)], ranges))


def run_gate(report, *, changed="", diff="", waivers=""):
    with tempfile.TemporaryDirectory() as td:
        rp, cp, dp = (os.path.join(td, n) for n in ("r.md", "c.txt", "p.diff"))
        open(rp, "w").write(report)
        args = [sys.executable, GATE, rp]
        if changed:
            open(cp, "w").write(changed)
            args.append(cp)
        if diff:
            open(dp, "w").write(diff)
            if len(args) == 3:
                args.append(os.path.join(td, "absent.txt"))
            args.append(dp)
        env = {**os.environ, "PROTOPATCH_WAIVERS": waivers, "GITHUB_STEP_SUMMARY": os.path.join(td, "s.md")}
        proc = subprocess.run(args, capture_output=True, text=True, env=env)
        return proc.returncode, proc.stdout


class EndToEndTests(unittest.TestCase):
    def test_finding_on_changed_lines_blocks(self):
        rc, out = run_gate(report_block(evidence=("lib/feed.ts:11",)), changed="lib/feed.ts\n", diff=DIFF)
        self.assertEqual(rc, 1)
        self.assertIn("f-1", out)

    def test_preexisting_debt_on_untouched_lines_informs(self):
        # The #1874 case: same file, lines nowhere near the hunks.
        rc, out = run_gate(report_block(evidence=("lib/feed.ts:40-44",)), changed="lib/feed.ts\n", diff=DIFF)
        self.assertEqual(rc, 0)
        self.assertIn("pass", out)

    def test_no_diff_falls_back_to_file_scope(self):
        rc, _ = run_gate(report_block(evidence=("lib/feed.ts:40-44",)), changed="lib/feed.ts\n")
        self.assertEqual(rc, 1)  # old behavior preserved without the diff input

    def test_waive_unblocks_and_is_loud(self):
        rc, out = run_gate(
            report_block(evidence=("lib/feed.ts:11",)),
            changed="lib/feed.ts\n",
            diff=DIFF,
            waivers="protopatch-waive: f-1 — pre-existing, tracked in #431\n",
        )
        self.assertEqual(rc, 0)
        self.assertIn("waived", out)
        self.assertIn("tracked in #431", out)

    def test_waive_of_a_different_finding_does_not_unblock(self):
        rc, _ = run_gate(
            report_block(evidence=("lib/feed.ts:11",)),
            changed="lib/feed.ts\n",
            diff=DIFF,
            waivers="protopatch-waive: f-OTHER — nope\n",
        )
        self.assertEqual(rc, 1)

    def test_inform_categories_and_out_of_diff_still_inform(self):
        report = report_block(cat="test-gap") + report_block(fid="f-2", evidence=("other/file.ts:5",))
        rc, _ = run_gate(report, changed="lib/feed.ts\n", diff=DIFF)
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
