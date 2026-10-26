#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p assets media

ENGINE="${1:-svg}"

usage() {
  echo "usage: scripts/render-logo.sh [svg|manim]" >&2
  echo "  svg    deterministic 480x160 blue GIF via ImageMagick (default, ~50KB)" >&2
  echo "  manim  render manim/surfcode_logo.py, then encode with ffmpeg" >&2
}

case "$ENGINE" in
  svg)
    if ! command -v node >/dev/null 2>&1; then
      echo "render-logo: node is required for the SVG renderer" >&2
      exit 1
    fi
    node scripts/generate-logo-gif.mjs assets/surfcode-logo.gif
    exit 0
    ;;
  manim) ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

if command -v manim >/dev/null 2>&1; then
  RUNNER=(manim)
elif command -v podman >/dev/null 2>&1; then
  RUNNER=(podman run --rm --userns=keep-id -v "$PWD:/manim:Z" -w /manim manimcommunity/manim:stable manim)
elif command -v docker >/dev/null 2>&1; then
  RUNNER=(docker run --rm -v "$PWD:/manim" -w /manim manimcommunity/manim:stable manim)
else
  echo "render-logo: Manim is unavailable. Use the default SVG renderer: scripts/render-logo.sh svg" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "render-logo: ffmpeg is required to build the optimized GIF. Use scripts/render-logo.sh svg instead." >&2
  exit 1
fi

"${RUNNER[@]}" -ql --disable_caching --media_dir media \
  manim/surfcode_logo.py SurfCodeLogo

SOURCE="$(find media/videos/surfcode_logo -type f -name 'SurfCodeLogo*.mp4' -not -path '*partial*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
if [ -z "$SOURCE" ]; then
  echo "render-logo: Manim did not produce an MP4" >&2
  exit 1
fi

# The scene is a seamless 3s loop. Crop the centered 3:1 lockup, quantize to a
# compact palette, and loop forever.
ffmpeg -loglevel error -y -t 3 -i "$SOURCE" \
  -vf "fps=12,crop=1440:480:(iw-1440)/2:(ih-480)/2,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=24:stats_mode=full[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 assets/surfcode-logo.gif

printf 'wrote %s\n' assets/surfcode-logo.gif
