import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="50%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#bg)"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" fill="white" font-family="Arial,sans-serif" font-weight="bold" font-size="${size * 0.5}">R</text>
</svg>`;
}

async function main() {
  const iconsDir = path.join(__dirname, "..", "public", "icons");
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const size of [192, 512]) {
    const svg = Buffer.from(createSVG(size));
    await sharp(svg).png().toFile(path.join(iconsDir, `icon-${size}.png`));
    console.log(`icon-${size}.png generated`);
  }

  // Apple touch icon (180x180)
  const appleSvg = Buffer.from(createSVG(180));
  await sharp(appleSvg).png().toFile(path.join(iconsDir, "apple-touch-icon.png"));
  console.log("apple-touch-icon.png generated");

  // Favicon (32x32)
  const favSvg = Buffer.from(createSVG(32));
  await sharp(favSvg).png().toFile(path.join(iconsDir, "favicon-32.png"));
  console.log("favicon-32.png generated");
}

main().catch(console.error);
