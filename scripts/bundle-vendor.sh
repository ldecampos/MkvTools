#!/usr/bin/env bash
# Populate vendor/ directories with binaries from locally installed apps.
# Run once after cloning, and again after updating MKVToolNix or ffmpeg.
# The vendor/ directories are gitignored (binaries don't belong in git).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# ── mkvmerge (MKVToolNix) ─────────────────────────────────────────────────────

MKVTOOLNIX_APP="/Applications/MKVToolNix.app/Contents/MacOS"

bundle_mkvmerge() {
  local dest="$1/vendor"
  mkdir -p "$dest/libs"

  if [ -f "$MKVTOOLNIX_APP/mkvmerge" ]; then
    cp "$MKVTOOLNIX_APP/mkvmerge" "$dest/mkvmerge"
    chmod +x "$dest/mkvmerge"
    cp -r "$MKVTOOLNIX_APP/libs/" "$dest/libs/"
    echo "  mkvmerge v$("$dest/mkvmerge" --version 2>&1 | head -1 | awk '{print $2}')"
  else
    echo "  WARNING: MKVToolNix.app not found at $MKVTOOLNIX_APP"
    echo "  Install it from https://mkvtoolnix.download and re-run this script."
  fi
}

echo "Bundling mkvmerge..."
bundle_mkvmerge "$ROOT/apps/remuxer"
bundle_mkvmerge "$ROOT/apps/merger"

# ── ffmpeg (MKV Merger only — audio sync detection) ───────────────────────────
# The Merger's sync analysis extracts PCM with ffmpeg. Bundle it so the feature
# works without the user installing ffmpeg separately. For local dev this copies
# the system ffmpeg as-is; release builds vendor a self-contained ffmpeg in CI.

echo "Bundling ffmpeg (Merger)..."
FFMPEG_PATH="$(which ffmpeg 2>/dev/null || echo '')"
if [ -n "$FFMPEG_PATH" ]; then
  mkdir -p "$ROOT/apps/merger/vendor"
  cp "$FFMPEG_PATH" "$ROOT/apps/merger/vendor/ffmpeg"
  chmod +x "$ROOT/apps/merger/vendor/ffmpeg"
  echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  echo "  WARNING: ffmpeg not found — run 'brew install ffmpeg' (sync detection needs it)"
fi

echo "Done."
