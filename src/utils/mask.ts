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

export interface ZoneSpec {
  pos: Position;
  percent: number; // 1–100
}

const SIZE = 1024;

function zoneRect(
  pos: Position,
  zone: number
): { x: number; y: number; w: number; h: number } {
  const mid = Math.round((SIZE - zone) / 2);
  switch (pos) {
    case "tl":
      return { x: 0, y: 0, w: zone, h: zone };
    case "tr":
      return { x: SIZE - zone, y: 0, w: zone, h: zone };
    case "bl":
      return { x: 0, y: SIZE - zone, w: zone, h: zone };
    case "br":
      return { x: SIZE - zone, y: SIZE - zone, w: zone, h: zone };
    case "t":
      return { x: 0, y: 0, w: SIZE, h: zone };
    case "b":
      return { x: 0, y: SIZE - zone, w: SIZE, h: zone };
    case "l":
      return { x: 0, y: 0, w: zone, h: SIZE };
    case "r":
      return { x: SIZE - zone, y: 0, w: zone, h: SIZE };
    case "c":
      return { x: mid, y: mid, w: zone, h: zone };
  }
}

/**
 * Generates a 1024×1024 RGBA PNG mask.
 * Transparent pixels (alpha=0) mark editable zones.
 * Black opaque pixels (alpha=255) mark preserved areas.
 */
export async function generateMask(zones: ZoneSpec[]): Promise<Buffer> {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);
  for (let i = 0; i < SIZE * SIZE; i++) {
    pixels[i * 4 + 3] = 255;
  }

  for (const { pos, percent } of zones) {
    const zone = Math.round(SIZE * Math.max(1, Math.min(100, percent)) / 100);
    const { x, y, w, h } = zoneRect(pos, zone);
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
