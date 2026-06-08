// pdfjs ships its worker as a separate ESM asset; importing it with `?url` lets
// Vite bundle it (offline) and gives us the URL string to point pdfjs at. The
// heavy pdfjs core itself is loaded lazily via dynamic import below so it only
// downloads when a comparison actually runs.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { diffImages, type RasterImage } from './pixelDiff';

export type PageStatus = 'same' | 'changed' | 'added' | 'removed';

export interface DiffPage {
  /** 0-based page index. */
  index: number;
  status: PageStatus;
  /** PNG data URL of the "前回" (before) page, when it exists. */
  beforeUrl?: string;
  /** PNG data URL of the "今回" (after) page, when it exists. */
  afterUrl?: string;
  /** PNG data URL of the diff overlay (changed pixels in red), when both exist. */
  diffUrl?: string;
  /** Fraction of pixels that changed, in [0, 1]. */
  changedRatio: number;
}

export interface VisualDiff {
  pages: DiffPage[];
  changedPageCount: number;
}

export interface VisualDiffOptions {
  /** Rasterization scale relative to PDF points (default 1.5 ≈ 110dpi). */
  scale?: number;
  /** pixelmatch matching threshold, 0–1; smaller is more sensitive. */
  threshold?: number;
}

interface PageRaster {
  url: string;
  image: RasterImage;
}

let workerConfigured = false;

// biome-ignore lint/suspicious/noExplicitAny: pdfjs-dist は動的import用途に十分な型を公開していないため
async function loadPdfjs(): Promise<any> {
  const pdfjs = await import('pdfjs-dist');
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    workerConfigured = true;
  }
  return pdfjs;
}

/** Render an RGBA buffer to a PNG data URL via an offscreen canvas. */
function rasterToDataUrl(data: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context is unavailable');
  // Allocate a fresh ImageData (backed by ArrayBuffer) and copy the bytes in;
  // passing the buffer directly trips the ArrayBufferLike/SharedArrayBuffer types.
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Rasterize every page of a PDF blob to {dataUrl, RGBA pixels}. */
// biome-ignore lint/suspicious/noExplicitAny: pdfjs proxy 型が動的import用途に不十分なため
async function renderPdfPages(pdfjs: any, blob: Blob, scale: number): Promise<PageRaster[]> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PageRaster[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D canvas context is unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const image: RasterImage = {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
      pages.push({ url: canvas.toDataURL('image/png'), image });
      page.cleanup?.();
    }
  } finally {
    await doc.cleanup?.();
  }
  return pages;
}

/**
 * Render both PDFs to page images and compute a per-page pixel diff. Pages that
 * exist on only one side are reported as added/removed.
 */
export async function computeVisualDiff(
  beforePdf: Blob,
  afterPdf: Blob,
  opts: VisualDiffOptions = {},
): Promise<VisualDiff> {
  const pdfjs = await loadPdfjs();
  const scale = opts.scale ?? 1.5;
  const [before, after] = await Promise.all([
    renderPdfPages(pdfjs, beforePdf, scale),
    renderPdfPages(pdfjs, afterPdf, scale),
  ]);

  const count = Math.max(before.length, after.length);
  const pages: DiffPage[] = [];
  for (let i = 0; i < count; i++) {
    const a = before[i];
    const b = after[i];
    if (a && b) {
      const d = diffImages(a.image, b.image, opts.threshold);
      pages.push({
        index: i,
        status: d.changedPixels > 0 ? 'changed' : 'same',
        beforeUrl: a.url,
        afterUrl: b.url,
        diffUrl: rasterToDataUrl(d.diff, d.width, d.height),
        changedRatio: d.changedRatio,
      });
    } else if (a) {
      pages.push({ index: i, status: 'removed', beforeUrl: a.url, changedRatio: 1 });
    } else if (b) {
      pages.push({ index: i, status: 'added', afterUrl: b.url, changedRatio: 1 });
    }
  }

  return { pages, changedPageCount: pages.filter((p) => p.status !== 'same').length };
}
