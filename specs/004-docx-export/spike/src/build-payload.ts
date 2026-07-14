/**
 * Generates the 3 fixture PNG images for the content payload.
 * Run: bun run src/build-payload.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { solidPng } from "./png";

const dir = join(import.meta.dir, "..", "fixtures");
const images: [string, number, number, [number, number, number]][] = [
  ["img-red.png", 120, 80, [220, 60, 60]],
  ["img-green.png", 100, 100, [60, 180, 90]],
  ["img-blue.png", 160, 60, [60, 100, 220]],
];
for (const [name, w, h, rgb] of images) {
  const png = solidPng(w, h, rgb);
  writeFileSync(join(dir, name), png);
  console.log(`wrote ${name} (${w}x${h}, ${png.length} bytes)`);
}
