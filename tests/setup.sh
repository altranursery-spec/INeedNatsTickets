#!/usr/bin/env bash
# One-time setup for the audit suite: a private Python environment with Playwright and its Chromium.
set -e
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q playwright
.venv/bin/playwright install chromium
echo "Ready. Run:  .venv/bin/python -I tests/bot_audit.py"
