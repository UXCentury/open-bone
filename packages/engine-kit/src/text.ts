import { type TextContext, type TextDraw, cssFont, drawTextBox, fontGeneration } from "@openbone/runtime";
import { textPad, textPadX } from "./batch.ts";

/** A canvas the rasteriser can draw into (HTMLCanvasElement, OffscreenCanvas or a headless canvas). */
export interface RasterCanvas {
  width: number;
  height: number;
  getContext(id: "2d"): unknown;
}

export interface TextRaster {
  canvas: RasterCanvas;
  /** Padding (skeleton units) around the box, so outlines and overhangs are not cut off. */
  pad: number;
  /** Pixels per skeleton unit the canvas was drawn at. */
  scale: number;
  /** Changes whenever the pixels change: re-upload the engine texture when it differs from last time. */
  version: number;
  key: string;
  used: number;
}

/** Largest side of a text texture in pixels. */
export const MAX_TEXT_TEXTURE = 2048;

const defaultCanvas = (w: number, h: number): RasterCanvas | null => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") return Object.assign(document.createElement("canvas"), { width: w, height: h });
  return null;
};

/**
 * Rasterises text attachments into canvases, one per slot and attachment, redrawn only when the content, style
 * or pixel scale changes (scales snap to powers of two so zooming does not redraw every frame), exactly like
 * render-webgl. Engines wrap `canvas` in their own texture type and refresh it when `version` changes.
 */
export class TextRasterizer {
  private entries = new Map<string, TextRaster>();
  private frame = 0;
  private versions = 0;

  constructor(private createCanvas: (w: number, h: number) => RasterCanvas | null = defaultCanvas) {}

  /** Call once per rendered frame; entries unused for `maxAge` frames are dropped (and returned, to free textures). */
  nextFrame(maxAge = 60): string[] {
    this.frame++;
    const dropped: string[] = [];
    for (const [k, t] of this.entries)
      if (this.frame - t.used > maxAge) {
        this.entries.delete(k);
        dropped.push(k);
      }
    return dropped;
  }

  /**
   * The raster for a text item. `pixelsPerUnit` is how many screen pixels one skeleton unit covers at the
   * object's current scale (render-webgl: sqrt(|det(matrix)|) × zoom).
   */
  get(id: string, t: TextDraw, pixelsPerUnit: number): TextRaster | null {
    const m = t.matrix;
    const px = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * pixelsPerUnit;
    let scale = 2 ** Math.ceil(Math.log2(Math.max(0.25, px)));
    const pad = textPad(t);
    const padX = textPadX(t);
    const w = t.width + padX * 2;
    const h = t.height + pad * 2;
    scale = Math.min(scale, MAX_TEXT_TEXTURE / Math.max(w, h));
    const key = `${t.content}|${cssFont(t)}|${t.align}|${t.width}x${t.height}|${t.fill}|${t.outline}|${t.outlineWidth}|${scale}|${fontGeneration()}`;
    let entry = this.entries.get(id);
    if (entry && entry.key === key) {
      entry.used = this.frame;
      return entry;
    }
    const W = Math.max(1, Math.ceil(w * scale));
    const H = Math.max(1, Math.ceil(h * scale));
    if (!entry) {
      const canvas = this.createCanvas(W, H);
      if (!canvas) return null;
      entry = { canvas, pad, scale, version: 0, key: "", used: this.frame };
      this.entries.set(id, entry);
    }
    const c = entry.canvas;
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(scale, 0, 0, scale, W / 2, H / 2);
    drawTextBox(ctx as unknown as TextContext, t);
    entry.key = key;
    entry.pad = pad;
    entry.scale = scale;
    entry.used = this.frame;
    entry.version = ++this.versions;
    return entry;
  }

  clear() {
    this.entries.clear();
  }
}
