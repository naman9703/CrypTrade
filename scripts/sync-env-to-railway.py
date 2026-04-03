#!/usr/bin/env python3
"""
Upload backend/.env to the linked Railway service (non-interactive).
Usage: from repo root — CI=true python3 scripts/sync-env-to-railway.py
Optional: RAILWAY_PUBLIC_HOST=your-app.up.railway.app (default: trading-stack-production.up.railway.app)
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


def parse_env(s: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in s.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k] = v
    return out


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    env_path = root / "backend" / ".env"
    if not env_path.is_file():
        print("Missing backend/.env", file=sys.stderr)
        return 1

    pairs = parse_env(env_path.read_text(encoding="utf-8", errors="replace"))
    pairs.pop("PORT", None)

    host = os.environ.get("RAILWAY_PUBLIC_HOST", "trading-stack-production.up.railway.app")
    pairs["AI_BASE_URL"] = "http://127.0.0.1:8001"
    pairs["FRONTEND_ORIGIN"] = f"https://{host}"
    pairs["LISTEN_HOST"] = "0.0.0.0"
    pairs["SERVE_FRONTEND"] = "1"
    pairs["NODE_ENV"] = "production"
    pairs = {k: v for k, v in pairs.items() if v != ""}

    env = {**os.environ, "CI": "true"}
    items = list(pairs.items())
    for i, (k, v) in enumerate(items):
        skip_deploy = i < len(items) - 1
        cmd = ["railway", "variable", "set", f"{k}={v}"]
        if skip_deploy:
            cmd.append("--skip-deploys")
        last_err = ""
        for attempt in range(4):
            r = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True, env=env)
            if r.returncode == 0:
                break
            last_err = r.stderr or r.stdout
            time.sleep(1.0 * (attempt + 1))
        else:
            print(f"FAILED {k}: {last_err}", file=sys.stderr)
            return r.returncode
        time.sleep(0.35)

    print(f"OK: set {len(items)} variables (last triggers deploy).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
