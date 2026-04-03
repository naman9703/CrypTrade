#!/usr/bin/env python3
"""Print model validation summary from meta.json (no network). Run from repo: python scripts/walk_forward_report.py"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
META = ROOT / "data" / "model" / "meta.json"


def main() -> int:
    if not META.exists():
        print(f"No meta at {META}", file=sys.stderr)
        return 1
    m = json.loads(META.read_text())
    h1 = m.get("val_half1_top_decile_wr")
    h2 = m.get("val_half2_top_decile_wr")
    gap = abs(h1 - h2) if h1 is not None and h2 is not None else None
    print("trained_at:", m.get("trained_at"))
    print("trained_rows:", m.get("trained_rows"), "| symbols:", len(m.get("symbols") or []))
    print("val_accuracy:", m.get("val_accuracy"), "| val_log_loss:", m.get("val_log_loss"))
    print("val_brier:", m.get("val_brier"), "| val_roc_auc:", m.get("val_roc_auc"))
    print("val_lift:", m.get("val_lift"), "| top_decile_wr:", m.get("val_top_decile_wr"))
    print("half1_top_decile_wr:", h1, "| half2:", h2)
    if gap is not None:
        print(
            "stability:",
            "UNSTABLE (|half1-half2| > 0.15)" if gap > 0.15 else "moderate" if gap > 0.08 else "ok",
            f"(gap={gap:.4f})",
        )
    print("calibration_platt:", m.get("calibration_platt"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
