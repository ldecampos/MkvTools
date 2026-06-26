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

# ── ffmpeg (optional — for future sync detection in MKV Merger) ───────────────
# Uncomment when sync detection via ffprobe is implemented.
#
# FFMPEG_PATH="$(which ffmpeg 2>/dev/null || echo '')"
# if [ -n "$FFMPEG_PATH" ]; then
#   cp "$FFMPEG_PATH"         "$ROOT/apps/merger/vendor/ffmpeg"
#   cp "$(which ffprobe)"     "$ROOT/apps/merger/vendor/ffprobe"
#   chmod +x "$ROOT/apps/merger/vendor/ffmpeg" "$ROOT/apps/merger/vendor/ffprobe"
#   echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
# else
#   echo "  WARNING: ffmpeg not found — brew install ffmpeg when needed"
# fi

echo "Done."
