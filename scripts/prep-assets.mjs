// One-time asset preparation. Reads the existing brand icon from
// public/icons/icon.png and produces the source files capacitor-assets
// expects in assets/, plus the Play Store listing graphics in
// docs/play-store-assets/.
//
// Run: node scripts/prep-assets.mjs
// Then: npx capacitor-assets generate
//
// Re-run only when the brand assets change. The capacitor-assets output
// (mipmap PNGs, splash drawables) is what ends up in the AAB.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const SOURCE = 'public/icons/icon.png';
const ACCENT = '#1e8040';     // Wildbloom growth — used as accent only, not as a fill
const BG_DARK = '#1a1f17';    // Wildbloom near-black (the app's default surface)
const BG_CREAM = '#f5f5f0';   // Wildbloom cream (light-mode surface)
const INK = '#f5f5f0';        // text on dark
const INK_DIM = '#a8a89c';    // muted text on dark
const ASSETS_DIR = 'assets';
const STORE_DIR = 'docs/play-store-assets';

await mkdir(ASSETS_DIR, { recursive: true });
await mkdir(STORE_DIR, { recursive: true });

// Adaptive icon foreground: 1024×1024 with the logo centered at ~64% scale,
// transparent background. Android launchers crop and zoom this layer
// (circle, squircle, etc.) — the safe area is the inner 66% of the canvas.
const fgIcon = await sharp(SOURCE)
  .resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: fgIcon, gravity: 'center' }])
  .png()
  .toFile(`${ASSETS_DIR}/icon-foreground.png`);

// Adaptive icon background: cream. The accent green is for UI buttons, not
// fills — using it at scale reads as muddy. Cream is the brand's light-mode
// surface and lets the logo carry the color.
await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: BG_CREAM,
  },
})
  .png()
  .toFile(`${ASSETS_DIR}/icon-background.png`);

// Composite icon (iOS app icon and Android fallback). Same composition over
// the cream background, foreground at ~78% scale (iOS auto-rounds the
// corners so heavy adaptive-icon padding isn't needed here).
const composeIcon = await sharp(SOURCE)
  .resize(800, 800, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: BG_CREAM },
})
  .composite([{ input: composeIcon, gravity: 'center' }])
  .png()
  .toFile(`${ASSETS_DIR}/icon-only.png`);

// Splash screen: 2732×2732, dark theme, icon centered.
const splashIcon = await sharp(SOURCE)
  .resize(900, 900, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

await sharp({
  create: { width: 2732, height: 2732, channels: 4, background: BG_DARK },
})
  .composite([{ input: splashIcon, gravity: 'center' }])
  .png()
  .toFile(`${ASSETS_DIR}/splash.png`);

// --- Play Store assets (uploaded directly to the Play Console, not in the AAB) ---

// Listing icon: 512×512, fully opaque (Play rejects transparency). Cream
// background carries through from icon-only.
await sharp(`${ASSETS_DIR}/icon-only.png`)
  .resize(512, 512)
  .flatten({ background: BG_CREAM })
  .png()
  .toFile(`${STORE_DIR}/icon-512.png`);

// Feature graphic: 1024×500 banner shown across the top of the listing.
// Dark surface with a subtle accent glow in the upper-right (matches the
// app's botanical hero pattern). Text in cream, eyebrow accent in growth
// green for a single point of color.
const featureSvg = Buffer.from(`<svg width="1024" height="500" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="78%" cy="22%" r="55%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.45"/>
      <stop offset="60%" stop-color="${ACCENT}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="500" fill="${BG_DARK}"/>
  <rect width="1024" height="500" fill="url(#glow)"/>
  <text x="72" y="225" font-family="Georgia, 'Times New Roman', serif" font-style="italic"
    font-size="92" font-weight="500" fill="${INK}" letter-spacing="-2.5">Wildbloom</text>
  <text x="76" y="270" font-family="ui-monospace, 'Courier New', monospace" font-size="14"
    font-weight="600" fill="${ACCENT}" letter-spacing="3.2">ENERGY-FIRST DAYS FOR CURIOUS MINDS</text>
  <text x="72" y="365" font-family="Georgia, 'Times New Roman', serif" font-style="italic"
    font-size="24" fill="${INK_DIM}">A planner that works the way a real day does.</text>
</svg>`);

await sharp(featureSvg)
  .png()
  .toFile(`${STORE_DIR}/feature-graphic-1024x500.png`);

console.log('✓ Source assets generated:');
console.log(`  ${ASSETS_DIR}/icon-foreground.png  (Android adaptive foreground)`);
console.log(`  ${ASSETS_DIR}/icon-background.png  (Android adaptive background — cream)`);
console.log(`  ${ASSETS_DIR}/icon-only.png        (iOS + fallback)`);
console.log(`  ${ASSETS_DIR}/splash.png           (native splash, 2732×2732)`);
console.log(`  ${STORE_DIR}/icon-512.png            (Play Console listing icon)`);
console.log(`  ${STORE_DIR}/feature-graphic-1024x500.png  (Play Console feature graphic)`);
console.log('\nNext: npx capacitor-assets generate');
