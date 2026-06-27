#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../.."

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
echo ""; echo "MKV Merger"; echo "────────────────────────────"

command -v node &>/dev/null || { echo -e "${RED}Node.js not found. Install from https://nodejs.org${NC}"; exit 1; }
echo -e "${GREEN}Node.js $(node --version)${NC}"

command -v pnpm &>/dev/null || { echo -e "${RED}pnpm not found. Run: npm install -g pnpm${NC}"; exit 1; }
echo -e "${GREEN}pnpm $(pnpm --version)${NC}"

MKVMERGE_FOUND=false
for p in \
  "apps/merger/vendor/mkvmerge" \
  "/Applications/MKVToolNix.app/Contents/MacOS/mkvmerge" \
  "/opt/homebrew/bin/mkvmerge" \
  "/usr/local/bin/mkvmerge" \
  "/usr/bin/mkvmerge"; do
  if [ -f "$p" ]; then MKVMERGE_FOUND=true; echo -e "${GREEN}mkvmerge found${NC}"; break; fi
done
if [ "$MKVMERGE_FOUND" = false ]; then
  echo -e "${YELLOW}mkvmerge not found${NC}"
  if command -v brew &>/dev/null; then
    echo -e "  Run: ${GREEN}brew install mkvtoolnix${NC}"
  else
    echo -e "  Or run: ${GREEN}bash scripts/bundle-vendor.sh${NC} after installing MKVToolNix"
  fi
fi

echo "Installing dependencies..."
pnpm install --frozen-lockfile --silent
echo "Launching..."; echo "────────────────────────────"
pnpm --filter mkv-merger start
