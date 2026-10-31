/**
 * QR rendering for the bind code.
 *
 * The iLink API hands back a 32-hex token plus a link to a JS-rendered page,
 * so the picture has to be produced here. The matrix comes from the MIT-licensed
 * encoder vendored under ./qr (Kazuhiko Arase's QRCode for JavaScript); this
 * module only turns that matrix into an SVG the browser can show directly.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("./qr/index.js");
const { L, M, Q, H } = require("./qr/QRErrorCorrectLevel.js");

const LEVELS = { L, M, Q, H };

/**
 * Render text as an SVG QR code.
 * @param {string} text - payload to encode.
 * @param {{ scale?: number, margin?: number, level?: "L"|"M"|"Q"|"H" }} [options]
 * @returns {string} standalone SVG markup.
 */
export function qrSvg(text, options = {}) {
  const scale = options.scale ?? 8;
  const margin = options.margin ?? 2;
  const level = LEVELS[options.level ?? "M"] ?? M;
  const qr = new QRCode(-1, level);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;
  const parts = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + margin) * scale;
      const y = (row + margin) * scale;
      parts.push(`M${x} ${y}h${scale}v${scale}h-${scale}z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`,
    ` viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="WeChat bind QR code">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${parts.join("")}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}
