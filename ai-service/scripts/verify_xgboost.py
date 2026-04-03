#!/usr/bin/env python3
"""Exit 0 if XGBoost loads; else print OS-specific fix and exit 1."""
from __future__ import annotations

import os
import platform
import sys


def main() -> int:
    if os.getenv("SKIP_XGBOOST_VERIFY", "").lower() in ("1", "true", "yes"):
        print("SKIP_XGBOOST_VERIFY set — skipping XGBoost check")
        return 0
    try:
        from xgboost import XGBClassifier  # noqa: F401

        print("XGBoost OK:", XGBClassifier.__module__)
        return 0
    except Exception as e:
        sys_kind = platform.system()
        if sys_kind == "Darwin":
            fix = "brew install libomp"
        elif sys_kind == "Linux":
            fix = "sudo apt install libgomp1   # or your distro's libgomp package"
        else:
            fix = "install OpenMP / MSVC runtime per https://xgboost.readthedocs.io/en/stable/install.html"
        print(f"XGBoost import failed: {type(e).__name__}: {e}", file=sys.stderr)
        print(f"Fix ({sys_kind}): {fix}", file=sys.stderr)
        print("To skip this check: export SKIP_XGBOOST_VERIFY=1", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
