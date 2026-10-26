# SurfCode motion logo

The README banner is a blue, seamless SurfCode lockup: blue equalizer
bars, a blue gradient wordmark, a passing shine, and the “RIDE THE CODE”
tagline. The layout and motion are unchanged; only the palette is blue.

There are two renderers:

1. **SVG + ImageMagick** (default, deterministic). It produces the 480×160,
   ~50KB GIF in `assets/` with no Manim or ffmpeg install required.
2. **Manim** (optional). It renders a higher-resolution 3-second loop that can
   be encoded with ffmpeg.

The TUI never plays a video. Its bottom-right status mark keeps the original
rainbow equalizer even though the README banner is blue. These renderers are
for the README and promotional surfaces.

## Render

From the repo root:

```bash
npm run logo:render            # SVG + ImageMagick, ~50KB
npm run logo:render -- manim   # Manim + ffmpeg, if installed
```

The SVG path uses `scripts/generate-logo-gif.mjs`. It renders 14 SVG frames at
2×, downsamples them, quantizes to a 24-color palette, and uses inter-frame GIF
optimization. All motion completes a whole cycle, so frame 14 flows into frame
0 without a cut. Optional environment variables:

```bash
LOGO_FRAMES=18 LOGO_COLORS=32 node scripts/generate-logo-gif.mjs assets/surfcode-logo.gif
```

More frames or colors produce a larger file.

The Manim path uses a local `manim` binary when available, then falls back to
Podman or Docker with the `manimcommunity/manim:stable` image. It also requires
`ffmpeg`, which crops the centered 3:1 lockup and builds a looping palette GIF.

To render the scene manually with the container:

```bash
podman run --rm --userns=keep-id -v "$PWD:/manim:Z" -w /manim \
  manimcommunity/manim:stable \
  manim -ql --media_dir media manim/surfcode_logo.py SurfCodeLogo
```

Manim's raw output is written under `media/` (ignored by git). The default
`assets/surfcode-logo.gif` is the SVG-generated file because it reproduces the
same compact size on machines without a video toolchain.
