'use strict';
// Writes tests/out/calibration.sdocx: test strokes to open in Samsung Notes and screenshot, so the device rendering
// that FORMAT.md section 8 still marks unverified can be measured. Every line runs x 60 -> 660 at the row's y.
//   y  80  InkPen2 size 8, 0.5 units/ms: narrows to ~0.52 (measured; the converter now writes at 0.1, full width)
//   y 150  InkPen2 size 8, 0.1 units/ms         } fade with time, distance or speed?
//   y 220  InkPen2 size 8, 0.02 units/ms        }
//   y 290  InkPen2 size 8, 2 units/ms           }
//   y 360  InkPen2 size 8, 0.5 units/ms after a 400 ms pause at the first point
//   y 430  InkPen2 size 8, 0.5 units/ms, pressure 1 -> 0
//   y 500  InkPen2 size 8, 0.02 units/ms, pressure 1 -> 0
//   y 570  InkPen2 width 8 written as the converter writes lines (layoutStrokes pieces)
//   y 640  Pencil2 size 4, ten dashes at alpha 0.1 ... 1.0
//   y 710  Pencil2 size 8, pressure 1 -> 0
//   y 780  Pencil2 size 4 alpha 0.3, two dashes crossing; then InkPen2 size 4 alpha 0.5, two dashes crossing
// Usage: node tests/make_calibration.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
vm.runInThisContext(html.match(/<script id="sdocx-core">([\s\S]*?)<\/script>/)[1], { filename: 'index.html#sdocx-core' });
const core = globalThis.SdocxCore;

const BLACK = 0xFF000000;
// A straight stroke a -> b with points 2 units apart, drawn at `speed` units/ms after `pause` ms at the first point.
const seg = ([ax, ay], [bx, by], { speed = 0.5, pause = 0, pressure = () => 1, size = 8, color = BLACK, pen = 'pen' } = {}) => {
  const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 2) + 1), points = [], pressures = [], ms = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    pressures.push(pressure(t));
    if (i) ms.push(Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / (n - 1) / speed)) + (i === 1 ? pause : 0));
  }
  return { points, pressures, ms, size, color, pen };
};
const row = (y, options) => seg([60, y], [660, y], options);
const fadeOut = (t) => 1 - t;
const alpha = (a) => ((Math.round(a * 255) << 24) >>> 0);   // black at opacity a
const page = core.pageGeometry(720, 1018, 0);   // scale 1: image pixels are page units
const pieces = core.layoutStrokes({ strokes: [{ points: [[60, 570], [660, 570]], widths: [8, 8], color: BLACK, pen: 'pen' }] }, page);
const strokes = [
  row(80), row(150, { speed: 0.1 }), row(220, { speed: 0.02 }), row(290, { speed: 2 }),
  row(360, { pause: 400 }), row(430, { pressure: fadeOut }), row(500, { speed: 0.02, pressure: fadeOut }),
  ...pieces,
  ...Array.from({ length: 10 }, (_, i) => seg([60 + 60 * i, 640], [110 + 60 * i, 640], { pen: 'pencil', size: 4, color: alpha((i + 1) / 10) })),
  row(710, { pen: 'pencil', pressure: fadeOut }),
  seg([60, 780], [260, 780], { pen: 'pencil', size: 4, color: alpha(0.3) }), seg([160, 750], [160, 810], { pen: 'pencil', size: 4, color: alpha(0.3) }),
  seg([360, 780], [560, 780], { size: 4, color: alpha(0.5) }), seg([460, 750], [460, 810], { size: 4, color: alpha(0.5) }),
];
const built = core.buildSdocx({ title: 'Calibration', page, background: 0xFFFFFFFF, strokes, now: BigInt(Date.now()) * 1000n });
const out = path.join(__dirname, 'out', 'calibration.sdocx');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, built.bytes);
console.log(`${out}: ${strokes.length} strokes (${pieces.length} pieces in the y 570 row), ${built.bytes.length} bytes`);
