import sharp from "sharp";

export const VALID_POSITIONS = [
  "tl",
  "tr",
  "bl",
  "br",
  "t",
  "b",
  "l",
  "r",
  "c",
] as const;
export type Position = (typeof VALID_POSITIONS)[number];

const SIZE = 1024;
const ZONE = Math.round(SIZE * 0.3); // ~307px per zone

function zoneRect(pos: Position): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const mid = Math.round((SIZE - ZONE) / 2);
  switch (pos) {
    case "tl":
      return { x: 0, y: 0, w: ZONE, h: ZONE };
    case "tr":
      return { x: SIZE - ZONE, y: 0, w: ZONE, h: ZONE };
    case "bl":
      return { x: 0, y: SIZE - ZONE, w: ZONE, h: ZONE };
    case "br":
      return { x: SIZE - ZONE, y: SIZE - ZONE, w: ZONE, h: ZONE };
    case "t":
      return { x: 0, y: 0, w: SIZE, h: ZONE };
    case "b":
      return { x: 0, y: SIZE - ZONE, w: SIZE, h: ZONE };
    case "l":
      return { x: 0, y: 0, w: ZONE, h: SIZE };
    case "r":
      return { x: SIZE - ZONE, y: 0, w: ZONE, h: SIZE };
    case "c":
      return { x: mid, y: mid, w: ZONE, h: ZONE };
  }
}

/**
 * Generates a 1024×1024 RGBA PNG mask.
 * Transparent pixels (alpha=0) mark editable zones.
 * Black opaque pixels (alpha=255) mark preserved areas.
 */
export async function generateMask(positions: Position[]): Promise<Buffer> {
  // Start with all-black opaque (preserved)
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);
  for (let i = 0; i < SIZE * SIZE; i++) {
    pixels[i * 4 + 3] = 255;
  }

  // Make each specified zone transparent (editable)
  for (const pos of positions) {
    const { x, y, w, h } = zoneRect(pos);
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        pixels[(row * SIZE + col) * 4 + 3] = 0;
      }
    }
  }

  return sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png()
    .toBuffer();
}
