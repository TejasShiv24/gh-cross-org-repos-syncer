#!/usr/bin/env bash
#
# setup.sh - one-shot local setup for gh-cross-org-repos-syncer.
#
# What it does:
#   1. Verifies git and the GitHub CLI (gh) are installed.
#   2. Verifies gh is authenticated (prompts to log in if not).
#   3. Installs local npm dependencies.
#   4. Links the package so the `update` command is available in your shell.
#
# Usage:
#   bash setup.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "==> Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Node.js is not installed. Install Node >= 18 from https://nodejs.org and re-run.${NC}"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo -e "${RED}git is not installed. Install git and re-run.${NC}"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo -e "${RED}GitHub CLI (gh) is not installed. Install it from https://cli.github.com and re-run.${NC}"
  exit 1
fi

echo "==> Checking GitHub CLI authentication..."
if ! gh auth status >/dev/null 2>&1; then
  echo -e "${YELLOW}gh is not authenticated. Launching 'gh auth login'...${NC}"
  gh auth login
fi
echo -e "${GREEN}gh CLI is authenticated.${NC}"

echo "==> Installing local npm dependencies..."
npm install

echo "==> Making index.js executable..."
chmod +x index.js

echo "==> Linking the 'update' command locally..."
npm link

echo -e "${GREEN}\nSetup complete! Run 'update' from any terminal to sync repos between two GitHub orgs.${NC}"
