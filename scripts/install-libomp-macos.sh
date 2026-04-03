#!/usr/bin/env bash
# Installs OpenMP for XGBoost on macOS (run in Terminal on your Mac).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only. On Linux use: sudo apt install libgomp1"
  exit 1
fi

for BREW in /opt/homebrew/bin/brew /usr/local/bin/brew "$HOME/homebrew/bin/brew"; do
  if [[ -x "$BREW" ]]; then
    echo "Using: $BREW"
    "$BREW" install libomp
    echo "Done. npm run dev uses ai-service/scripts/run-dev-ai.sh to set DYLD_LIBRARY_PATH for XGBoost."
    exit 0
  fi
done

echo "Homebrew not found. Either:"
echo "  1) Install from https://brew.sh then: brew install libomp"
echo "  2) Or use a user install: mkdir -p ~/homebrew && curl -fsSL https://github.com/Homebrew/brew/tarball/master | tar xz --strip 1 -C ~/homebrew && ~/homebrew/bin/brew install libomp"
exit 1
