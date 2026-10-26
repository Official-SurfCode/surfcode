#!/usr/bin/env node
/**
 * Build the README's animated SurfCode wordmark without Manim or ffmpeg.
 *
 * The animation is generated as a short set of SVG frames. Every motion in the
 * scene is periodic, so frame N flows back into frame 0 with no visible cut:
 *   - the equalizer bars use whole sine cycles
 *   - the shine sweeps from one off-screen edge to the other
 *   - every gradient is static
 *
 * Frames render at 2x and are downsampled during GIF assembly for clean edges.
 * Usage:
 *   node scripts/generate-logo-gif.mjs [output.gif]
 *   LOGO_COLORS=48 LOGO_FRAMES=24 node scripts/generate-logo-gif.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUTPUT = resolve(process.argv[2] ?? 'assets/surfcode-logo.gif');
const FRAMES = Number(process.env.LOGO_FRAMES ?? 14);
const COLORS = Number(process.env.LOGO_COLORS ?? 24);
const SCALE = 2;
const WIDTH = 480;
const HEIGHT = 160;

const BLUE = ['#1D4ED8', '#2563EB', '#3B82F6', '#60A5FA', '#38BDF8', '#22D3EE'];
const BAR_COUNT = 15;
const BAR_WIDTH = 7;
const BAR_GAP = 11;
const BAR_BOTTOM = 47;

const magick = findMagick();
const work = process.env.LOGO_WORK
  ? resolve(process.env.LOGO_WORK)
  : mkdtempSync(join(tmpdir(), 'surfcode-logo-'));
if (process.env.LOGO_WORK) mkdirSync(work, { recursive: true });
const frames = [];

try {
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const path = join(work, `frame-${String(frame).padStart(3, '0')}.png`);
    writeFileSync(path.replace(/\.png$/, '.svg'), svgFrame(frame));
    execFileSync(
      magick,
      [path.replace(/\.png$/, '.svg'), '-background', 'none', path],
      { stdio: 'pipe' }
    );
    frames.push(path);
  }

  // Quantize a coalesced sequence to a small palette first. ImageMagick's
  // GIF optimizer only produces inter-frame diffs reliably from paletted PNG
  // frames; optimizing the full-size truecolor render leaves every frame whole.
  const smallPattern = join(work, 'small-%03d.png');
  execFileSync(
    magick,
    [
      '-delay',
      '8',
      ...frames,
      '-resize',
      `${WIDTH}x${HEIGHT}`,
      '-filter',
      'Lanczos',
      '-coalesce',
      '+dither',
      '-colors',
      String(COLORS),
      '-type',
      'Palette',
      smallPattern
    ],
    { stdio: 'pipe' }
  );

  const smallFrames = Array.from({ length: FRAMES }, (_, index) =>
    join(work, `small-${String(index).padStart(3, '0')}.png`)
  );
  const args = [
    '-delay',
    '8',
    '-loop',
    '0',
    ...smallFrames,
    '-layers',
    'Optimize',
    OUTPUT
  ];
  execFileSync(magick, args, { stdio: 'pipe' });
  console.log(
    `wrote ${OUTPUT} · ${FRAMES} frames · ${COLORS} colors · ${WIDTH}x${HEIGHT}`
  );
} finally {
  if (!process.env.LOGO_WORK) rmSync(work, { recursive: true, force: true });
}

function findMagick() {
  for (const candidate of ['magick', 'convert']) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next binary.
    }
  }
  throw new Error('ImageMagick is required (install `magick` or `convert`).');
}

function svgFrame(frame) {
  const phase = (frame / FRAMES) * Math.PI * 2;
  // The shine starts and ends fully outside the wordmark, so the loop point is
  // invisible even though the band only travels in one direction.
  const shineX = -190 + (frame / FRAMES) * 860;
  const bars = [];
  const totalWidth = (BAR_COUNT - 1) * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH;
  const startX = (WIDTH - totalWidth) / 2;
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const sway =
      Math.sin(phase + index * 0.58) * 0.62 + Math.sin(phase * 2 + index * 0.91) * 0.38;
    const height = 7 + (sway + 1) * 0.5 * 19;
    const x = startX + index * (BAR_WIDTH + BAR_GAP);
    const y = BAR_BOTTOM - height;
    const color = BLUE[index % BLUE.length];
    bars.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${BAR_WIDTH}" height="${height.toFixed(
        2
      )}" rx="${BAR_WIDTH / 2}" fill="${color}" opacity="0.94"/>`
    );
  }

  const word =
    '<text x="240" y="108" text-anchor="middle" font-family="DejaVu Sans" ' +
    'font-size="52" font-weight="bold" letter-spacing="6">SURFCODE</text>';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * SCALE}" height="${
    HEIGHT * SCALE
  }" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="blue" x1="60" y1="0" x2="420" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1D4ED8"/>
      <stop offset="0.24" stop-color="#2563EB"/>
      <stop offset="0.46" stop-color="#3B82F6"/>
      <stop offset="0.68" stop-color="#60A5FA"/>
      <stop offset="0.85" stop-color="#38BDF8"/>
      <stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="rule" x1="92" y1="0" x2="388" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1D4ED8" stop-opacity="0"/>
      <stop offset="0.18" stop-color="#3B82F6" stop-opacity="0.8"/>
      <stop offset="0.5" stop-color="#7DD3FC" stop-opacity="0.95"/>
      <stop offset="0.82" stop-color="#22D3EE" stop-opacity="0.8"/>
      <stop offset="1" stop-color="#22D3EE" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="0.42" stop-color="#FFFFFF" stop-opacity="0.04"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.64"/>
      <stop offset="0.58" stop-color="#FFFFFF" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="word-clip">${word}</clipPath>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#050B18"/>
  ${bars.join('\n  ')}
  ${word.replace('<text ', '<text fill="url(#blue)" ')}
  <g clip-path="url(#word-clip)">
    <rect x="${shineX.toFixed(2)}" y="40" width="128" height="100" fill="url(#shine)" transform="rotate(16 240 90)"/>
  </g>
  <rect x="92" y="127" width="296" height="2.5" rx="1.25" fill="url(#rule)"/>
  <text x="240" y="149" text-anchor="middle" font-family="DejaVu Sans" font-size="10.5"
    font-weight="bold" letter-spacing="5.2" fill="#93C5FD" opacity="0.8">RIDE THE CODE</text>
</svg>`;
}
