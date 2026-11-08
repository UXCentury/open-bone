import { ByteWriter, crc32 } from "./bytes.ts";

/** A ZIP archive with stored (uncompressed) entries, e.g. a PNG sequence. Images are already compressed. */
export function createZip(entries: { name: string; data: Uint8Array }[], date = new Date()): Uint8Array {
  const w = new ByteWriter();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const enc = new TextEncoder();
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    central.push({ name, crc, size: e.data.length, offset: w.length });
    w.u32(0x04034b50, true).u16(20, true).u16(0x0800, true).u16(0, true).u16(dosTime, true).u16(dosDate, true);
    w.u32(crc, true).u32(e.data.length, true).u32(e.data.length, true).u16(name.length, true).u16(0, true);
    w.bytes(name).bytes(e.data);
  }
  const cdStart = w.length;
  for (const c of central) {
    w.u32(0x02014b50, true).u16(20, true).u16(20, true).u16(0x0800, true).u16(0, true).u16(dosTime, true).u16(dosDate, true);
    w.u32(c.crc, true).u32(c.size, true).u32(c.size, true).u16(c.name.length, true).u16(0, true).u16(0, true);
    w.u16(0, true).u16(0, true).u32(0, true).u32(c.offset, true).bytes(c.name);
  }
  const cdSize = w.length - cdStart;
  w.u32(0x06054b50, true).u16(0, true).u16(0, true).u16(central.length, true).u16(central.length, true);
  w.u32(cdSize, true).u32(cdStart, true).u16(0, true);
  return w.result();
}
