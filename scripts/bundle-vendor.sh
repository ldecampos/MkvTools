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

# ── ffmpeg (needed by MKV Merger) ─────────────────────────────────────────────
# Uncomment once apps/merger exists.
#
# FFMPEG_PATH="$(which ffmpeg 2>/dev/null || echo '')"
# if [ -n "$FFMPEG_PATH" ]; then
#   mkdir -p "$ROOT/apps/merger/vendor"
#   cp "$FFMPEG_PATH" "$ROOT/apps/merger/vendor/ffmpeg"
#   cp "$(which ffprobe)" "$ROOT/apps/merger/vendor/ffprobe"
#   chmod +x "$ROOT/apps/merger/vendor/ffmpeg" "$ROOT/apps/merger/vendor/ffprobe"
#   cp -r "$MKVTOOLNIX_APP/libs/" "$ROOT/apps/merger/vendor/libs/"
#   echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
# else
#   echo "  WARNING: ffmpeg not found — install via: brew install ffmpeg"
# fi

echo "Done."
