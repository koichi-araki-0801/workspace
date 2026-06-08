import { describe, expect, it } from 'vitest';
import { diffImages, type RasterImage } from '@/features/compare/pixelDiff';

/** Build a solid-color RGBA raster. */
function solid(width: number, height: number, rgb: [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

const WHITE: [number, number, number] = [255, 255, 255];
const RED: [number, number, number] = [255, 0, 0];

describe('diffImages', () => {
  it('reports zero changes for identical images', () => {
    const a = solid(4, 4, WHITE);
    const b = solid(4, 4, WHITE);
    const d = diffImages(a, b);
    expect(d.changedPixels).toBe(0);
    expect(d.changedRatio).toBe(0);
    expect(d.width).toBe(4);
    expect(d.height).toBe(4);
  });

  it('counts changed pixels when content differs', () => {
    const a = solid(4, 4, WHITE);
    const b = solid(4, 4, WHITE);
    // flip one pixel to red in b
    b.data[0] = RED[0];
    b.data[1] = RED[1];
    b.data[2] = RED[2];
    const d = diffImages(a, b);
    expect(d.changedPixels).toBeGreaterThan(0);
    expect(d.changedRatio).toBeGreaterThan(0);
  });

  it('pads to the larger bounding box when sizes differ', () => {
    const a = solid(2, 2, WHITE);
    const b = solid(4, 4, WHITE);
    const d = diffImages(a, b);
    expect(d.width).toBe(4);
    expect(d.height).toBe(4);
    // a padded with white matches b's white region → no changes
    expect(d.changedPixels).toBe(0);
  });
});
