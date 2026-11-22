// Draws the app icon (dark rounded square, lime ◈) as a 1024 px PNG for `cargo tauri icon`.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const N = 1024, px = Buffer.alloc(N * N * 4);
const bg = [23, 30, 38], lime = [182, 229, 118];
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4, r = 180, m = 40;
  // rounded square mask with 1 px antialiasing
  const dx = Math.max(m + r - x, 0, x - (N - m - r)), dy = Math.max(m + r - y, 0, y - (N - m - r));
  const a = Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5));
  const d = Math.abs(x - N / 2) + Math.abs(y - N / 2); // diamond distance
  const ring = d > 250 && d < 330, core = d < 150;
  const c = ring || core ? lime : bg;
  px.set([c[0], c[1], c[2], Math.round(a * 255)], i);
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr.set([8, 6, 0, 0, 0], 8);
writeFileSync(process.argv[2] || "icon-source.png", Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
