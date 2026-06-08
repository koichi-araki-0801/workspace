import pixelmatch from 'pixelmatch';

/** A decoded RGBA raster (one rendered page). */
export interface RasterImage {
  width: number;
  height: number;
  /** RGBA bytes, length === width * height * 4. */
  data: Uint8ClampedArray;
}

export interface PixelDiffResult {
  width: number;
  height: number;
  /** Number of pixels that differ between the two images. */
  changedPixels: number;
  /** changedPixels / (width * height), in [0, 1]. */
  changedRatio: number;
  /** RGBA diff image (changed pixels drawn in red over a faded original). */
  diff: Uint8ClampedArray;
}

/** Pad an image into a white w×h RGBA buffer (top-left aligned). */
function padToWhite(img: RasterImage, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  out.fill(255); // opaque white
  const rowBytes = img.width * 4;
  for (let y = 0; y < img.height; y++) {
    const src = y * rowBytes;
    out.set(img.data.subarray(src, src + rowBytes), y * width * 4);
  }
  return out;
}

/**
 * Pixel-level visual diff of two rendered pages (WinMerge-style). Images of
 * different sizes are padded to the larger bounding box on white so a page that
 * grew/shrank still compares. Pure (no DOM) so it can be unit-tested.
 */
export function diffImages(a: RasterImage, b: RasterImage, threshold = 0.1): PixelDiffResult {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const fits = (img: RasterImage) => img.width === width && img.height === height;
  const pa = fits(a) ? a.data : padToWhite(a, width, height);
  const pb = fits(b) ? b.data : padToWhite(b, width, height);
  const diff = new Uint8ClampedArray(width * height * 4);
  const changedPixels = pixelmatch(pa, pb, diff, width, height, {
    threshold,
    diffColor: [255, 0, 0],
    alpha: 0.5,
  });
  return { width, height, changedPixels, changedRatio: changedPixels / (width * height), diff };
}
