import { ATLAS_FILTERS, ATLAS_PIXEL_FORMATS, ATLAS_WRAPS, type AtlasFilter, type AtlasPixelFormat, type AtlasWrap } from "@openbone/core";
import { z } from "zod";

/**
 * Texture packer settings as MCP input (pack_atlas, export_file `atlas`): the same `AtlasSettings` the CLI and the
 * Export dialog use. Everything is optional; defaults are the packer's.
 */
export const atlasSettingsShape = {
  padding: z.number().int().min(0).max(32).optional().describe("Empty pixels around each image (default 2)"),
  maxSize: z.number().int().min(16).max(8192).optional().describe("Largest page width and height (default 2048); maxWidth / maxHeight override one axis"),
  maxWidth: z.number().int().min(16).max(8192).optional(),
  maxHeight: z.number().int().min(16).max(8192).optional(),
  minWidth: z.number().int().min(0).max(8192).optional().describe("Smallest page width (default 0)"),
  minHeight: z.number().int().min(0).max(8192).optional(),
  powerOfTwo: z.boolean().optional().describe("Page sizes are powers of two (default true)"),
  square: z.boolean().optional().describe("Pages are square (default false)"),
  multipleOf4: z.boolean().optional().describe("Page sizes are multiples of 4, for block-compressed formats (default false)"),
  rotate: z.boolean().optional().describe("Turn images 90° when that packs tighter (images used by particles stay upright)"),
  scale: z.union([z.number().min(0.05).max(1), z.literal("auto")]).optional().describe('Store images at this fraction of their size; "auto" shrinks only as much as needed to fit one page'),
  scales: z
    .array(z.object({ scale: z.number().min(0.05).max(1), suffix: z.string().max(40).regex(/^[\w@.-]*$/) }))
    .optional()
    .describe('export_file atlas format: several scales in one pack, one data file + page set each, e.g. [{scale:1,suffix:""},{scale:0.5,suffix:"@0.5x"}]'),
  stripWhitespace: z.boolean().optional().describe("Pack each image by its visible bounds (meshes keep what their uvs cover; particle images stay whole)"),
  polygons: z.boolean().optional().describe("Polygon packing: region attachments draw a tight outline around the visible pixels instead of the full quad"),
  premultipliedAlpha: z.boolean().optional().describe("Store page pixels premultiplied (rgb × alpha); renderers use the matching blend"),
  alias: z.boolean().optional().describe("Store identical images (same pixels after trimming) once; their regions share a rect (default true)"),
  ignoreBlank: z.boolean().optional().describe("Fully transparent images take no space; their regions are marked empty (default true)"),
  alphaThreshold: z.number().int().min(0).max(255).optional().describe("Alpha at or below this counts as transparent for trimming, polygons and blank images (default 0)"),
  edgePadding: z.boolean().optional().describe("Repeat each image's edge pixels into half its padding so filtering never reads neighbours (default true)"),
  duplicatePadding: z.boolean().optional().describe("With edge padding, copy opaque edges opaque too: hard edges like a loose texture (default true; off = opaque edges fade out)"),
  bleed: z.boolean().optional().describe("Give fully transparent pixels the colour of the nearest visible one (alpha stays 0): no dark fringes when filtered (default on unless premultipliedAlpha)"),
  filterMin: z.enum(ATLAS_FILTERS as [AtlasFilter, ...AtlasFilter[]]).optional().describe("Texture minification filter written for runtimes (default linear)"),
  filterMag: z.enum(ATLAS_FILTERS as [AtlasFilter, ...AtlasFilter[]]).optional().describe("Texture magnification filter (default linear)"),
  wrapX: z.enum(ATLAS_WRAPS as [AtlasWrap, ...AtlasWrap[]]).optional().describe("Texture wrap along x (default clamp)"),
  wrapY: z.enum(ATLAS_WRAPS as [AtlasWrap, ...AtlasWrap[]]).optional(),
  pixelFormat: z.enum(ATLAS_PIXEL_FORMATS as [AtlasPixelFormat, ...AtlasPixelFormat[]]).optional().describe("Pixel format hint for runtimes (default RGBA8888)"),
  pageFormat: z.enum(["png", "jpeg"]).optional().describe("Page image format (default png); JPEG pages are opaque"),
  jpegQuality: z.number().int().min(1).max(100).optional().describe("JPEG quality (default 90)"),
  resample: z.enum(["bilinear", "bicubic", "nearest"]).optional().describe("Resampling for scaled packs (default bilinear)"),
  debug: z.boolean().optional().describe("Draw a magenta outline around every region on the pages (for checking a pack)"),
};
export const atlasSettingsSchema = z.object(atlasSettingsShape);
