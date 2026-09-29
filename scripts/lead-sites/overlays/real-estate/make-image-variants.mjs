// PREVIEW TEMPLATE: renders every /_img/<width>/<path>.webp that out/ references, from public/.
import sharp from "sharp";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const out = join(process.cwd(), "out");
const files = readdirSync(out, { recursive: true }).map((p) => join(out, p)).filter((p) => statSync(p).isFile() && /\.(html|txt|js|css)$/.test(p));
const wanted = new Set();
for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\/_img\/(\d+)(\/[^"'\s)\,]+?)\.webp/g)) wanted.add(`${m[1]}|${m[2]}`);
let made = 0;
for (const key of wanted) {
  const [w, path] = key.split("|");
  const src = ["jpg", "jpeg", "png", "webp", "avif"].map((ext) => join(process.cwd(), "public", `${path}.${ext}`)).find((p) => existsSync(p));
  if (!src) { console.error(`missing source for ${path}`); process.exitCode = 1; continue; }
  const target = join(out, "_img", w, `${path}.webp`);
  mkdirSync(dirname(target), { recursive: true });
  await sharp(src).resize({ width: Number(w), withoutEnlargement: true }).webp({ quality: 72 }).toFile(target);
  made++;
}
console.log(made);
