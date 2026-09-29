#!/usr/bin/env python3
"""protoPatch merge gate — fail the `review` check ONLY on findings that actually gate.

CANONICAL COPY. This script tracks the report format `clawpatch report` renders
(src/reporting.ts) — it lives here so the parser and the format evolve together.
Consuming repos vendor it into `.github/scripts/` (protoContent is the reference
integration); sync from here, don't fork the semantics (protoAgent#1874).

protoPatch's raw report over-blocks in three ways, each filtered here:

  1. CATEGORY — "no test coverage" escalates to HIGH, maintainability/style raise
     MEDIUM. Inform-only categories never gate.
  2. FILE SCOPE — findings sometimes land in files the PR never touched. When the
     changed-file set is known, out-of-diff findings inform only.
  3. LINE SCOPE (protoAgent#1874) — a PR touching a shared, debt-laden file used to
     inherit that file's PRE-EXISTING findings as blocking. When the PR's unified
     diff is provided, a finding blocks only if some evidence line range intersects
     the changed hunks (±CONTEXT_MARGIN lines). Findings on untouched lines of a
     touched file drop to INFORM. Evidence WITHOUT line info on a touched file
     still blocks (conservative: format drift must not silently open the gate).

  WAIVE (protoAgent#1874) — the escape hatch for "yes it's real, but not this PR":
  the PR body (passed via $PROTOPATCH_WAIVERS) may carry lines of the form

      protopatch-waive: <findingId> — <reason>

  Each waived finding drops to INFORM and is logged LOUDLY in the step summary —
  a waive is an audited decision, never a silent skip.

  BLOCK  = severity in {critical, high, medium} AND category not inform-only AND
           in-diff (file scope, and line scope when the diff is available) AND
           not waived.
  INFORM = everything else — still posted in the PR comment, doesn't fail the check.

Usage: protopatch-gate.py <report.md> [<changed-files.txt>] [<pr.diff>]
Env:   PROTOPATCH_WAIVERS — text scanned for `protopatch-waive:` lines (pass the
       PR body; anything else in it is ignored).
Exit 0 = pass (merge allowed), 1 = blocking findings present.
"""

import os
import re
import sys

INFORM_CATEGORIES = {
    "test-gap", "test-coverage", "maintainability", "code-quality", "style",
    "docs", "documentation", "performance", "perf", "nit", "readability",
    "observability", "naming",
}
BLOCK_SEVERITIES = {"critical", "high", "medium"}

# Evidence ranges within this many lines of a changed hunk still count as touched —
# the diff's own context width; an off-by-context miss must not false-INFORM.
CONTEXT_MARGIN = 3

# `- path:12-34 (symbol)` | `- path:42` | `- path` (reporting.ts evidenceLabel).
_EVIDENCE_RE = re.compile(r"(?m)^-\s+([^\s:]+)(?::(\d+)(?:-(\d+))?)?")
_WAIVE_RE = re.compile(r"(?m)^\s*protopatch-waive:\s*(\S+)\s*(?:[—–-]+\s*(.*\S))?\s*$")
_HUNK_RE = re.compile(r"(?m)^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
_DIFF_FILE_RE = re.compile(r'(?m)^diff --git a/.* b/"?([^"\n]+)"?$')


def parse_changed_ranges(diff_text: str) -> dict[str, list[tuple[int, int]]]:
    """{new-file path: [(start, end), ...]} from a unified diff. A pure-deletion
    hunk (+c,0) is kept as a point range at c — the seam is still 'touched'."""
    ranges: dict[str, list[tuple[int, int]]] = {}
    current: str | None = None
    for line in diff_text.splitlines():
        fm = _DIFF_FILE_RE.match(line)
        if fm:
            current = fm.group(1)
            ranges.setdefault(current, [])
            continue
        hm = _HUNK_RE.match(line)
        if hm and current is not None:
            start = int(hm.group(1))
            count = int(hm.group(2)) if hm.group(2) is not None else 1
            end = start + max(count, 1) - 1
            ranges[current].append((start, end))
    return ranges


def parse_waivers(text: str) -> dict[str, str]:
    """{findingId: reason} from `protopatch-waive:` lines (reason may be '')."""
    return {m.group(1): (m.group(2) or "").strip() for m in _WAIVE_RE.finditer(text or "")}


def evidence_refs(block: str) -> list[tuple[str, int | None, int | None]]:
    """[(path, start|None, end|None), ...] from a finding block's evidence list."""
    out = []
    for m in _EVIDENCE_RE.finditer(block):
        path = m.group(1)
        start = int(m.group(2)) if m.group(2) else None
        end = int(m.group(3)) if m.group(3) else start
        out.append((path, start, end))
    return out


def touches_changed_lines(
    refs: list[tuple[str, int | None, int | None]],
    changed_ranges: dict[str, list[tuple[int, int]]],
) -> bool:
    """True when some evidence ref intersects a changed hunk (±margin) — or when a
    ref on a changed file carries no line info (conservative: can't prove it's
    outside the diff, so it gates)."""
    for path, start, end in refs:
        hunks = changed_ranges.get(path)
        if hunks is None:
            continue  # ref on an unchanged file — the file-scope check handles it
        if start is None:
            return True  # line-less evidence on a touched file: block conservatively
        for h_start, h_end in hunks:
            if start <= h_end + CONTEXT_MARGIN and end >= h_start - CONTEXT_MARGIN:
                return True
    return False


def main() -> int:
    report_path = sys.argv[1] if len(sys.argv) > 1 else "clawpatch-report.md"
    changed_path = sys.argv[2] if len(sys.argv) > 2 else "changed-files.txt"
    diff_path = sys.argv[3] if len(sys.argv) > 3 else "pr.diff"
    if not os.path.exists(report_path) or os.path.getsize(report_path) == 0:
        print("protoPatch: no report — not blocking.")
        return 0
    report = open(report_path).read()
    changed = set()
    if os.path.exists(changed_path):
        changed = {ln.strip() for ln in open(changed_path) if ln.strip()}
    changed_ranges: dict[str, list[tuple[int, int]]] = {}
    if os.path.exists(diff_path):
        changed_ranges = parse_changed_ranges(open(diff_path).read())
    waivers = parse_waivers(os.environ.get("PROTOPATCH_WAIVERS", ""))

    offenders, informed, waived = [], [], []
    for block in re.split(r"(?m)^##\s+", report):
        m = re.match(r"(critical|high|medium|low|info)\s*:\s*(.+)", block, re.I)
        if not m:
            continue
        sev, title = m.group(1).lower(), m.group(2).strip()[:100]
        cat_m = re.search(r"(?m)^category:\s*(\S+)", block)
        cat = cat_m.group(1).lower() if cat_m else ""
        fid_m = re.search(r"(?m)^id:\s*(\S+)", block)
        fid = fid_m.group(1) if fid_m else ""
        label = f"{sev}/{cat or '?'}: {title}" + (f"  ({fid})" if fid else "")

        if sev not in BLOCK_SEVERITIES or cat in INFORM_CATEGORIES:
            informed.append(label)
            continue
        refs = evidence_refs(block)
        # File scope: only gate if the finding touches a changed file (when known).
        if changed:
            files = [path for path, _s, _e in refs]
            if files and not any(f in changed for f in files):
                informed.append(label + "  [outside diff]")
                continue
        # Line scope (#1874): with the diff in hand, findings whose evidence never
        # intersects a changed hunk are pre-existing debt — inform, don't gate.
        if changed_ranges and refs and not touches_changed_lines(refs, changed_ranges):
            informed.append(label + "  [untouched lines]")
            continue
        # Waive rail (#1874): an audited, per-PR acknowledgement.
        if fid and fid in waivers:
            reason = waivers[fid] or "(no reason given)"
            waived.append(f"{label} — waived: {reason}")
            continue
        offenders.append(label)

    summary = os.environ.get("GITHUB_STEP_SUMMARY", os.devnull)
    with open(summary, "a") as s:
        if offenders:
            s.write("### ❌ protoPatch gate: blocking correctness/security findings\n")
            for o in offenders:
                s.write(f"- {o}\n")
        else:
            s.write(f"protoPatch gate: pass — {len(informed)} informational finding(s), none gating.\n")
        if waived:
            s.write(f"\n### ⚠️ {len(waived)} finding(s) WAIVED on this PR (protopatch-waive)\n")
            for w in waived:
                s.write(f"- {w}\n")
        if informed and offenders:
            s.write(f"\n_{len(informed)} informational finding(s) not gating._\n")

    if waived:
        print(f"protoPatch gate: {len(waived)} finding(s) waived on this PR:")
        for w in waived:
            print("  -", w)
    if offenders:
        print("::error::protoPatch found blocking correctness/security issues in the diff — fix or waive.")
        for o in offenders:
            print("  -", o)
        return 1
    print(f"protoPatch gate: pass ({len(informed)} informational finding(s) don't block).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
