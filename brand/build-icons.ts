/**
 * Builds every icon from the SVGs in brand/: the editor's favicons, PWA manifest icons and Apple touch icon,
 * and the source image for the desktop app icons (then run `tauri icon` on it, see README in this folder).
 *
 *   pnpm icons
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = (f: string) => path.join(root, "brand", f);
const pub = path.join(root, "apps/editor/public");
const desktop = path.join(root, "apps/desktop");

async function png(svgFile: string, size: number): Promise<Buffer> {
  const img = await loadImage(fs.readFileSync(brand(svgFile)));
  const c = createCanvas(size, size);
  c.getContext("2d").drawImage(img, 0, 0, size, size);
  return c.toBuffer("image/png");
}

/** ICO holding PNG images (supported by every browser and Windows Vista+). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const write = (file: string, data: Buffer | string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`  ${path.relative(root, file)}`);
};

console.log("Editor (apps/editor/public):");
write(path.join(pub, "favicon.svg"), fs.readFileSync(brand("logo-small.svg")));
write(path.join(pub, "logo-mark.svg"), fs.readFileSync(brand("logo-mark.svg")));
write(path.join(pub, "logo.svg"), fs.readFileSync(brand("logo.svg")));
write(path.join(pub, "favicon.ico"), ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png("logo-small.svg", size) })))));
write(path.join(pub, "apple-touch-icon.png"), await png("logo-maskable.svg", 180));
write(path.join(pub, "icon-192.png"), await png("logo.svg", 192));
write(path.join(pub, "icon-512.png"), await png("logo.svg", 512));
write(path.join(pub, "icon-maskable-512.png"), await png("logo-maskable.svg", 512));

console.log("Desktop:");
write(path.join(desktop, "icon-source.png"), await png("app-icon.svg", 1024));
if (!process.argv.includes("--no-tauri")) {
  execFileSync("pnpm", ["--filter", "@openbone/desktop", "tauri", "icon", "icon-source.png"], { cwd: root, stdio: "inherit" });
  // The desktop app has no mobile targets: drop the iOS and Android sets `tauri icon` also writes.
  for (const dir of ["ios", "android"]) fs.rmSync(path.join(desktop, "src-tauri/icons", dir), { recursive: true, force: true });
}
