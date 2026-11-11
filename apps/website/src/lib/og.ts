/**
 * Social cards (Open Graph / Twitter): one 1200 × 630 PNG per page, drawn at build time with sharp from an SVG — the
 * brand, the page's section and title, its description, and the page's first editor screenshot when it has one.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const root = process.cwd();
const logo = fs.readFileSync(path.resolve(root, "../../brand/logo.svg"));
const FONT = "'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

const SECTIONS: Record<string, string> = {
  "getting-started": "Get started",
  guides: "Guide",
  engines: "Engine quick start",
  runtimes: "Runtime",
  packages: "Web package",
  reference: "Reference",
  examples: "Live examples",
};

export function sectionOf(id: string): string {
  return SECTIONS[id.split("/")[0]] ?? "OpenBone";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap by an average glyph width (DejaVu Sans), at most `max` lines, with an ellipsis when cut. */
function wrap(text: string, fontSize: number, width: number, max: number, bold = false): string[] {
  const perChar = fontSize * (bold ? 0.62 : 0.56);
  const limit = Math.max(8, Math.floor(width / perChar));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= limit) line = next;
    else {
      if (line) lines.push(line);
      line = word.length > limit ? `${word.slice(0, limit - 1)}…` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    kept[max - 1] = `${kept[max - 1].replace(/[\s.,;:]+$/, "").slice(0, limit - 1)}…`;
    return kept;
  }
  return lines;
}

async function screenshotPanel(file: string | null, w: number, h: number): Promise<string | null> {
  if (!file || !fs.existsSync(file)) return null;
  const png = await sharp(file).resize(w * 2, h * 2, { fit: "cover", position: "left top" }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

export async function renderOg(opts: { title: string; description?: string; section: string; screenshot?: string | null }): Promise<Buffer> {
  const shot = await screenshotPanel(opts.screenshot ?? null, 470, 400);
  const textW = shot ? 600 : 820;
  const titleSize = opts.title.length > 34 ? 52 : 62;
  const titleLines = wrap(opts.title, titleSize, textW, 3, true);
  const descLines = opts.description ? wrap(opts.description, 25, textW, titleLines.length > 2 ? 2 : 3) : [];
  const titleY = 268;
  const descY = titleY + titleLines.length * titleSize * 1.12 + 22;
  const logoUri = `data:image/svg+xml;base64,${logo.toString("base64")}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <radialGradient id="g1" cx="0.85" cy="0.15" r="0.7"><stop offset="0" stop-color="#70c4fc" stop-opacity="0.34"/><stop offset="1" stop-color="#70c4fc" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="0.05" cy="0.95" r="0.6"><stop offset="0" stop-color="#fab70c" stop-opacity="0.22"/><stop offset="1" stop-color="#fab70c" stop-opacity="0"/></radialGradient>
    <radialGradient id="g3" cx="0.45" cy="0.55" r="0.6"><stop offset="0" stop-color="#8a63d2" stop-opacity="0.22"/><stop offset="1" stop-color="#8a63d2" stop-opacity="0"/></radialGradient>
    <linearGradient id="bar" x1="0" x2="1"><stop offset="0" stop-color="#70c4fc"/><stop offset="0.55" stop-color="#a78bfa"/><stop offset="1" stop-color="#fab70c"/></linearGradient>
    <clipPath id="shot"><rect x="690" y="115" width="470" height="400" rx="18"/></clipPath>
  </defs>
  <rect width="100%" height="100%" fill="#140a1e"/>
  <rect width="100%" height="100%" fill="url(#g1)"/>
  <rect width="100%" height="100%" fill="url(#g2)"/>
  <rect width="100%" height="100%" fill="url(#g3)"/>
  <rect x="0" y="0" width="${OG_WIDTH}" height="8" fill="url(#bar)"/>
  <image x="60" y="56" width="64" height="64" href="${logoUri}" xlink:href="${logoUri}"/>
  <text x="140" y="101" font-family="${FONT}" font-size="36" font-weight="bold" fill="#ffffff">OpenBone</text>
  <rect x="60" y="164" rx="18" ry="18" width="${Math.round(opts.section.length * 15.5 + 40)}" height="38" fill="#fab70c" fill-opacity="0.16" stroke="#fab70c" stroke-opacity="0.6"/>
  <text x="80" y="190" font-family="${FONT}" font-size="21" font-weight="bold" fill="#fab70c">${esc(opts.section.toUpperCase())}</text>
  ${titleLines.map((l, i) => `<text x="60" y="${titleY + i * titleSize * 1.12}" font-family="${FONT}" font-size="${titleSize}" font-weight="bold" fill="#ffffff">${esc(l)}</text>`).join("\n  ")}
  ${descLines.map((l, i) => `<text x="60" y="${descY + i * 36}" font-family="${FONT}" font-size="25" fill="#c7c0d4">${esc(l)}</text>`).join("\n  ")}
  <text x="60" y="580" font-family="${FONT}" font-size="24" font-weight="bold" fill="#70c4fc">openbone.io</text>
  <text x="${shot ? 690 : 1140}" y="580" text-anchor="${shot ? "start" : "end"}" font-family="${FONT}" font-size="20" fill="#9a90ab">Open-source 2D skeletal animation · MIT</text>
  ${
    shot
      ? `<rect x="684" y="109" width="482" height="412" rx="22" fill="#ffffff" fill-opacity="0.06" stroke="#70c4fc" stroke-opacity="0.35"/>
  <image x="690" y="115" width="470" height="400" preserveAspectRatio="xMidYMid slice" clip-path="url(#shot)" href="${shot}" xlink:href="${shot}"/>`
      : `<image x="900" y="150" width="260" height="260" opacity="0.18" href="${logoUri}" xlink:href="${logoUri}"/>`
  }
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false }).toBuffer();
}
