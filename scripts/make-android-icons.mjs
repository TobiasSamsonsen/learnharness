// Regenerate the Android launcher icon layers from the same artwork as the desktop icon
// (build/icon-flat.svg, owner's Affinity export). The adaptive icon's background is the plain colour
// @color/ic_launcher_background; the foreground is the mark alone (the squircle is dropped), centred and scaled
// to sit inside the 66dp safe zone of the 108dp canvas, rendered at each density straight from the SVG.
//
//   android/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png   the mark in colour
//   android/app/src/main/res/mipmap-<density>/ic_launcher_monochrome.png   the mark in white (Android 13+ themed icon)
//
// Committed outputs; rerun only when the design changes: `node scripts/make-android-icons.mjs`.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const res = path.join(root, "android", "app", "src", "main", "res");
const source = readFileSync(path.join(root, "build", "icon-flat.svg"), "utf8");

// the mark's own shapes: everything inside the svg element except the squircle (the first path, drawn in rgb(20,20,20))
const inner = source.slice(source.indexOf(">", source.indexOf("<svg")) + 1, source.lastIndexOf("</svg>"));
const mark = inner.replace(/<path d="[^"]*" style="fill:rgb\(20,20,20\);"\/>/, "");
if (mark === inner) throw new Error("the squircle path was not found in build/icon-flat.svg");

const wrap = (body, size, transform = "") =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="fill-rule:evenodd;clip-rule:evenodd"><g transform="${transform}">${body}</g></svg>`;

// where the mark sits inside the 1024 canvas: the box of its painted pixels
const probe = new Resvg(wrap(mark, 1024), { fitTo: { mode: "width", value: 1024 } }).render();
const { width, pixels } = probe;
let [x0, y0, x1, y1] = [width, width, 0, 0];
for (let i = 3; i < pixels.length; i += 4) {
	if (pixels[i] === 0) continue;
	const p = (i - 3) / 4;
	const x = p % width;
	const y = Math.floor(p / width);
	x0 = Math.min(x0, x); x1 = Math.max(x1, x);
	y0 = Math.min(y0, y); y1 = Math.max(y1, y);
}
const [cx, cy] = [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2];
const diameter = Math.max(x1 - x0 + 1, y1 - y0 + 1);

const DP = 108; // the adaptive icon canvas
const MARK_DP = 54; // the mark's longest side; its two outer circles must stay inside the 66dp safe-zone circle
const k = MARK_DP / diameter;
const place = `translate(${DP / 2} ${DP / 2}) scale(${k}) translate(${-cx} ${-cy})`;

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const white = mark.replace(/fill:rgb\(\d+,\d+,\d+\)/g, "fill:rgb(255,255,255)").replace(/fill:white/g, "fill:rgb(255,255,255)");

for (const [name, scale] of Object.entries(DENSITIES)) {
	const px = DP * scale;
	const dir = path.join(res, `mipmap-${name}`);
	mkdirSync(dir, { recursive: true });
	for (const [file, body] of [["ic_launcher_foreground.png", mark], ["ic_launcher_monochrome.png", white]]) {
		const png = new Resvg(wrap(body, DP, place), { fitTo: { mode: "width", value: px } }).render().asPng();
		writeFileSync(path.join(dir, file), png);
	}
}
console.log(`mark ${diameter}px of 1024, scaled by ${k.toFixed(4)}; wrote ${Object.keys(DENSITIES).length * 2} PNGs`);
