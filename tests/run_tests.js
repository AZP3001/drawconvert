'use strict';
// End-to-end verification of index.html.
//  1. The FORMAT.md parser (sdocx_parser.js) decodes the three Samsung Notes samples, hash chain included.
//  2. Each fixture PNG is traced and written by the converter's own <script id="sdocx-core">.
//  3. The generated .sdocx is re-parsed: structure must match the samples, every stroke must round-trip,
//     and no image layer (media file, canvas cache, image object) may remain.
//  4. The decoded strokes are rendered back to PNG and compared with the source (IoU of inked pixels),
//     and no stroke may run across bare paper.
// Usage: node tests/run_tests.js        Outputs for inspection go to tests/out/.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { parseSdocx, strokesOf } = require('./sdocx_parser.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const HTML = path.join(ROOT, 'index.html');
const SAMPLES = ['Notes_261106_225150.sdocx', 'Notes_261106_225305.sdocx', 'Test_261106_205901.sdocx'];
const rgb = (r, g, b, a = 1) => [r, g, b, a].map((v) => Math.round(v * 255));
const onWhite = (r, g, b, a) => rgb(r * a + 1 - a, g * a + 1 - a, b * a + 1 - a);   // translucent ink as the page shows it
// Drawn lines per fixture (null: passes gone over twice have no single right count) and the colours used in make_fixtures.py.
const FIXTURES = [
  { name: 'simple_lines', lines: 11, palette: [rgb(0, 0, 0)] },
  { name: 'thick_brush', lines: 6, palette: [rgb(0.09, 0.09, 0.11)] },
  { name: 'color_sketch', lines: 16, palette: [rgb(0.90, 0.22, 0.21), rgb(0.98, 0.55, 0.0), onWhite(0.12, 0.53, 0.90, 0.8),
    onWhite(0.26, 0.63, 0.28, 0.6), rgb(0.43, 0.30, 0.16), onWhite(0.56, 0.14, 0.67, 0.7), rgb(0.26, 0.63, 0.28)] },
  { name: 'sketchy', lines: null, palette: [rgb(0, 0, 0)] },
  // 0.8-2 px lines: in this pixel-centre comparison a sub-pixel shift flips whole line pixels, so IoU caps lower.
  { name: 'thin_lines', lines: 13, palette: [rgb(0, 0, 0)], iouTarget: 0.8 },
  // Shading is hatched with Pencil2 (tone = alpha, RGB = the ink behind it); lines stay InkPen2.
  { name: 'shading', lines: 6, palette: [rgb(0.1, 0.1, 0.1)], pencil: [rgb(0, 0, 0)], toneTarget: 0.03, iouTarget: 0.8, fades: true },
  // Quarter-size copies, rendered at and scored against the full-size drawing (lines a pixel wide or less).
  { name: 'simple_lines_q', truth: 'simple_lines', lines: 11, palette: [rgb(0, 0, 0)], iouTarget: 0.85 },
  { name: 'thick_brush_q', truth: 'thick_brush', lines: 6, palette: [rgb(0.09, 0.09, 0.11)] },
  { name: 'color_sketch_q', truth: 'color_sketch', lines: null, palette: null, iouTarget: 0.6 },
  { name: 'shading_q', truth: 'shading', lines: null, palette: null, pencil: [rgb(0, 0, 0)], toneTarget: 0.03, iouTarget: 0.6 },
];
const DEFAULT_DETAIL = 100;   // matches the slider's default in the HTML
const MARGIN_PERCENT = 2;    // matches the margin slider's default
const IOU_TARGET = 0.85;
const INKPEN2 = 'com.samsung.android.sdk.pen.pen.preload.InkPen2';
const PENCIL2 = 'com.samsung.android.sdk.pen.pen.preload.Pencil2';
const PENCIL_SETTING = '15;';  // Pencil2's advanced-setting string in the samples
const NOW = 1794001910647890n;  // fixed save time (µs) so outputs are reproducible apart from random UUID bits

let failures = 0;
function check(condition, message) {
  if (!condition) { failures++; console.log(`    FAIL ${message}`); }
  return condition;
}
const same = (a, b) => JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

// ---------------------------------------------------------------- PNG in/out (8-bit, non-interlaced)
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not a PNG file');
  let p = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const length = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    p += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (depth !== 8 || interlace !== 0 || !channels) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, pixels = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      const grey = channels <= 2;
      pixels[d] = cur[s]; pixels[d + 1] = grey ? cur[s] : cur[s + 1]; pixels[d + 2] = grey ? cur[s] : cur[s + 2];
      pixels[d + 3] = channels === 4 ? cur[s + 3] : channels === 2 ? cur[s + 1] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, pixels };
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- inked pixels of the source image
// Ink coverage = alpha on transparent images, otherwise distance from the paper colour (border median).
// A pixel is inked when at least half covered relative to the strongest ink nearby (keeps
// semi-transparent strokes at their drawn width).
function sourceMask({ width: W, height: H, pixels: px }, minCoverage = 0.1, relative = 0.5) {
  let transparent = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { transparent = true; break; }
  const paper = [0, 1, 2].map((c) => {
    const values = [];
    for (let x = 0; x < W; x++) values.push(px[x * 4 + c], px[((H - 1) * W + x) * 4 + c]);
    for (let y = 0; y < H; y++) values.push(px[y * W * 4 + c], px[(y * W + W - 1) * 4 + c]);
    return values.sort((a, b) => a - b)[values.length >> 1];
  });
  const cov = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    cov[i] = transparent ? px[i * 4 + 3] / 255
      : Math.max(Math.abs(px[i * 4] - paper[0]), Math.abs(px[i * 4 + 1] - paper[1]), Math.abs(px[i * 4 + 2] - paper[2])) / 255;
  }
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let peak = 0;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) peak = Math.max(peak, cov[yy * W + xx]);
      const c = cov[y * W + x];
      mask[y * W + x] = c >= minCoverage && c >= relative * peak ? 1 : 0;
    }
  }
  return mask;
}

const clampInt = (v, n) => Math.min(n - 1, Math.max(0, Math.round(v)));

// Chessboard distance (px) from every pixel to the nearest inked pixel (multi-source BFS).
function inkDistance(mask, W, H) {
  const dist = new Int32Array(W * H).fill(-1), queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++], x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, j = Y * W + X;
      if (X >= 0 && Y >= 0 && X < W && Y < H && dist[j] < 0) { dist[j] = dist[i] + 1; queue[tail++] = j; }
    }
  }
  return dist;
}

// ---------------------------------------------------------------- decoded strokes -> image pixels
// Each stroke is a chain of round-capped segments whose radius follows the width the device draws
// (deviceWidths). A pixel is inked when its centre is inside a stroke.
function renderStrokes(decoded, W, H, toImageX, toImageY, scale) {
  const mask = new Uint8Array(W * H);
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  for (const s of decoded) {
    const pts = s.points.map(([x, y]) => [toImageX(x), toImageY(y)]);
    const radii = s.widths.map((w) => w / 2 / scale);
    const alpha = s.alpha ?? ((s.color >>> 24) & 255) / 255, color = [(s.color >>> 16) & 255, (s.color >>> 8) & 255, s.color & 255];
    const painted = new Uint8Array(W * H);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], ra = radii[i], rb = radii[i + 1];
      const reach = Math.max(ra, rb) + 1;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      for (let y = Math.max(0, Math.floor(Math.min(ay, by) - reach)); y <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + reach)); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - reach)); x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + reach)); x++) {
          const cx = x + 0.5 - ax, cy = y + 0.5 - ay;
          const t = len2 > 0 ? Math.min(1, Math.max(0, (cx * dx + cy * dy) / len2)) : 0;
          if (Math.hypot(cx - t * dx, cy - t * dy) > ra + (rb - ra) * t) continue;
          const i4 = y * W + x;
          mask[i4] = 1;
          if (painted[i4]) continue;
          painted[i4] = 1;
          for (let c = 0; c < 3; c++) rgba[i4 * 4 + c] = Math.round(rgba[i4 * 4 + c] * (1 - alpha) + color[c] * alpha);
        }
      }
    }
  }
  return { mask, rgba };
}

function loadCore() {
  const html = fs.readFileSync(HTML, 'utf8');
  const match = html.match(/<script id="sdocx-core">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('<script id="sdocx-core"> not found in index.html');
  vm.runInThisContext(match[1], { filename: 'index.html#sdocx-core' });
  return { core: globalThis.SdocxCore, html };
}

// ---------------------------------------------------------------- 1. samples
function loadSamples() {
  console.log('Samples (FORMAT.md parser):');
  const docs = [];
  for (const file of SAMPLES) {
    try {
      const doc = parseSdocx(fs.readFileSync(path.join(ROOT, file)));
      const strokes = strokesOf(doc);
      const points = strokes.reduce((n, s) => n + s.stroke.pointCount, 0);
      console.log(`  ${file}: OK — ${doc.pages.length} pages, ${strokes.length} strokes, ${points} points decoded`);
      docs.push(doc);
    } catch (error) {
      check(false, `${file}: ${error.message}`);
    }
  }
  return docs;
}

// Reference values every generated stroke must share with real strokes of the same pen.
function sampleProfile(docs, penName = INKPEN2) {
  const ink = [];
  for (const doc of docs) {
    for (const o of strokesOf(doc)) if (doc.note.stringIds.get(o.stroke.flex.penNameId) === penName && o.base.rotation === undefined) ink.push({ o, doc });
  }
  const set = (fn) => new Set(ink.map(fn));
  const all = (fn) => ink.flatMap(fn);
  const tilts = all(({ o }) => o.stroke.tilts), orientations = all(({ o }) => o.stroke.orientations);
  return {
    strokeCount: ink.length,
    strokeMask1: set(({ o }) => o.stroke.mask1),
    strokeFlexMask: set(({ o }) => o.stroke.flexMask),
    tail: set(({ o }) => o.stroke.tail),
    t0: set(({ o }) => o.stroke.timestamps[0]),
    int400: set(({ o }) => o.stroke.flex.int400),
    float2000: set(({ o }) => o.stroke.flex.float2000),
    advanced: set(({ o, doc }) => doc.note.stringIds.get(o.stroke.flex.advancedSettingId)),
    base: set(({ o }) => JSON.stringify([o.type, o.childCount, o.base.size, o.base.flexOffset, o.base.mask1, o.base.flexMask, o.base.version, o.base.reserved32, o.base.reserved8])),
    tilt: [Math.min(...tilts), Math.max(...tilts)],
    orientation: [Math.min(...orientations), Math.max(...orientations)],
  };
}

// drawnRect = union of every stroke rect grown by a pad: half the pen size plus 4 for InkPen2 (verified on the
// samples); the converter gives Pencil2 the pen size plus 4 (no sample stroke sets a side, so unverified).
const inkPad = (o) => o.stroke.flex.penSize / 2 + 4;
function inkDrawnRect(objects, padOf) {
  let r = null;
  for (const o of objects) {
    const pad = padOf(o), b = o.base.rect;
    const g = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    r = r ? [Math.min(r[0], g[0]), Math.min(r[1], g[1]), Math.max(r[2], g[2]), Math.max(r[3], g[3])] : g;
  }
  return r;
}

function checkDrawnRectFormula(docs) {
  for (const doc of docs) {
    const page = doc.pages[0], drawn = page.properties.drawnRect;
    const ink = strokesOf(doc).filter((o) => o.page === page && doc.note.stringIds.get(o.stroke.flex.penNameId) === INKPEN2 && o.base.rotation === undefined);
    const others = strokesOf(doc).filter((o) => o.page === page).length - ink.length;
    const predicted = inkDrawnRect(ink, inkPad);
    const matched = [0, 1, 2, 3].filter((k) => Math.abs(predicted[k] - drawn[k]) < 1e-3).length;
    const inside = [0, 1].every((k) => predicted[k] >= drawn[k] - 1e-3) && [2, 3].every((k) => predicted[k] <= drawn[k] + 1e-3);
    // Pages holding only plain InkPen2 strokes must match exactly; others only where InkPen2 dominates.
    check(inside && (others ? matched >= 1 : matched === 4), `drawnRect formula vs sample page ${page.id}: ${matched}/4 sides match`);
    console.log(`  drawnRect formula on ${page.id.slice(0, 8)}…: ${matched}/4 sides exact (${others} non-InkPen2/rotated strokes on page)`);
  }
}

// ---------------------------------------------------------------- 2-4. one fixture
function runFixture(core, fixture, ref, profiles, options) {
  const { detail, save } = options;
  const image = decodePng(fs.readFileSync(path.join(__dirname, 'fixtures', fixture.name + '.png')));
  const truth = fixture.truth ? decodePng(fs.readFileSync(path.join(__dirname, 'fixtures', fixture.truth + '.png'))) : image;
  const f = truth.width / image.width;   // truth pixels per input pixel
  const started = Date.now();
  const traced = core.vectorize(image.pixels, image.width, image.height, { detail });
  const traceMs = Date.now() - started;
  const geometry = core.pageGeometry(image.width, image.height, MARGIN_PERCENT);
  const input = core.layoutStrokes(traced, geometry);
  const title = fixture.name;
  const built = core.buildSdocx({ title, page: geometry, background: 0xFFFFFFFF, strokes: input, now: NOW });
  const label = `${fixture.name} @detail ${detail}`;
  let doc;
  try {
    doc = parseSdocx(Buffer.from(built.bytes));
  } catch (error) {
    check(false, `${label}: generated .sdocx does not parse: ${error.message}`);
    return null;
  }
  if (save) fs.writeFileSync(path.join(OUT, `${fixture.name}.sdocx`), built.bytes);

  // --- container: same entry layout as the samples, minus the canvas-cache image files
  const shape = (d) => d.zip.order.map((e) => e.name.replace(/^[0-9a-f-]{36}\.page$/, '<page>'));
  check(same(shape(doc), shape(ref).filter((n) => !/^media\/.+\.spi$/.test(n))), `${label}: ZIP entries ${shape(doc)}`);
  check(doc.mediaInfo.entries.length === 0 && ![...doc.zip.entries.keys()].some((n) => n.startsWith('media/') && n !== 'media/mediaInfo.dat'), `${label}: image/media files remain`);
  check(doc.mediaInfo.formatVersion === ref.mediaInfo.formatVersion, `${label}: mediaInfo version ${doc.mediaInfo.formatVersion}`);

  // --- note.note vs sample
  const n = doc.note, rn = ref.note;
  for (const key of ['headerFlags', 'propertyFlags', 'formatVersion', 'noteId', 'fileRevision', 'horizontalPadding', 'verticalPadding', 'minFormatVersion', 'lastEditedPageIndex', 'lastEditedPageImage', 'fixedTextDirection', 'fixedBackgroundTheme']) {
    check(same(n[key], rn[key]), `${label}: note.${key} ${n[key]} != sample ${rn[key]}`);
  }
  check(n.width === Math.max(...doc.pages.map((p) => p.width)) && n.height === doc.pages.reduce((s, p) => s + p.height, 0) + rn.verticalPadding, `${label}: note size ${n.width}x${n.height}`);
  check(rn.height === ref.pages.reduce((s, p) => s + p.height, 0) + rn.verticalPadding, 'sample note height formula');
  check(n.pageWidth === doc.pages[0].width && n.pageHeight === doc.pages[0].height, `${label}: note page size ${n.pageWidth}x${n.pageHeight}`);
  check(same(n.bodyObject.recordTypes, rn.bodyObject.recordTypes) && same(n.bodyObject.recordSizes, rn.bodyObject.recordSizes), `${label}: body object layout`);
  check(same(n.titleObject.recordTypes, rn.titleObject.recordTypes), `${label}: title object records`);
  check(n.titleObject.text === title, `${label}: title "${n.titleObject.text}"`);
  check(n.titleObject.recordSizes[2] === options.titleRecordSize(title), `${label}: title text record ${n.titleObject.recordSizes[2]} bytes, samples imply ${options.titleRecordSize(title)}`);
  // Pencil2 joins the table only when used, in the samples' order: descending ids, setting id = name id + 1.
  const pencils = input.filter((s) => s.pen === 'pencil').length;
  const wantIds = [...(pencils ? [[3, PENCIL_SETTING], [2, PENCIL2]] : []), ...rn.stringIds];
  check(same([...n.stringIds], wantIds), `${label}: string table ${[...n.stringIds]}`);
  check(n.currentPenInfo.penName === INKPEN2 && n.currentPenInfo.size === rn.currentPenInfo.size && n.currentPenInfo.rest.equals(rn.currentPenInfo.rest), `${label}: current pen info`);

  // --- end_tag.bin and its copy after the ZIP
  const timeFields = ['modifiedTime', 'createdTime', 'displayCreatedTime', 'displayModifiedTime'];
  for (const [key, value] of Object.entries(ref.endTag)) {
    if (timeFields.includes(key)) continue;
    const want = key === 'width' ? n.width : key === 'height' ? n.height : value;
    check(same(doc.endTag[key], want), `${label}: end_tag.${key} ${doc.endTag[key]} != ${want}`);
  }
  check(doc.endTag.modifiedTime === n.modifiedTime && doc.endTag.createdTime === n.createdTime, `${label}: end_tag times differ from note.note`);
  check(doc.trailerEndTag && same({ ...doc.trailerEndTag, displayCreatedTime: 0, displayModifiedTime: 0 }, { ...doc.endTag, displayCreatedTime: 0, displayModifiedTime: 0 }), `${label}: trailing end tag differs`);
  for (const key of ['displayCreatedTime', 'displayModifiedTime']) {
    // inside: microseconds; trailing copy: milliseconds (as in every sample)
    const sampleRatio = Number(ref.endTag[key]) / Number(ref.trailerEndTag[key]);
    const ratio = Number(doc.endTag[key]) / Number(doc.trailerEndTag[key]);
    check(Math.abs(ratio - 1000) < 1 && Math.abs(sampleRatio - 1000) < 1, `${label}: ${key} units (ratio ${ratio}, sample ${sampleRatio})`);
  }

  // --- pages vs sample (main page has strokes, second page is the blank page the app keeps)
  check(doc.pages.length === ref.pages.length, `${label}: ${doc.pages.length} pages`);
  doc.pages.forEach((page, i) => {
    const rp = ref.pages[i];
    for (const key of ['const08', 'textOnly', 'const0D', 'propertyOffset', 'orientation', 'offsetX', 'offsetY', 'formatVersion', 'minFormatVersion', 'layerCount', 'currentLayer']) {
      check(page[key] === rp[key], `${label}: page ${i} ${key} ${page[key]} != sample ${rp[key]}`);
    }
    check(page.propertyMask === (rp.propertyMask & ~0x400), `${label}: page ${i} property mask 0x${page.propertyMask.toString(16)} (sample 0x${rp.propertyMask.toString(16)} without canvas cache)`);
    check(page.properties.canvasCache === undefined && page.properties.bgImageId === undefined, `${label}: page ${i} still references an image`);
    check(page.properties.bgImageMode === rp.properties.bgImageMode && page.properties.bgWidth === page.width, `${label}: page ${i} background fields`);
    const L = page.layers[0], RL = rp.layers[0];
    for (const key of ['headerSize', 'const8', 'flags1', 'constA', 'flags2', 'number']) check(L[key] === RL[key], `${label}: page ${i} layer ${key} ${L[key]} != ${RL[key]}`);
  });
  check(same([doc.pages[0].width, doc.pages[0].height], [geometry.width, geometry.height]), `${label}: page size`);
  check(doc.pages[1].layers[0].objectCount === 0, `${label}: blank page has objects`);

  // --- stroke objects: native InkPen2 strokes shaped exactly like the samples'
  const decoded = strokesOf(doc);
  const objects = doc.pages[0].layers[0].objects;
  check(objects.length === decoded.length && objects.every((o) => o.type === 1 && o.childCount === 0), `${label}: non-stroke objects on the page`);
  check(new Set(decoded.map((o) => o.base.id)).size === decoded.length && decoded.every((o) => /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(o.base.id)), `${label}: object ids not unique v1 UUIDs`);
  let roundTripErrors = 0;
  const strokeErr = (msg) => { if (roundTripErrors++ < 5) check(false, `${label}: ${msg}`); else failures++; };
  check(decoded.length === input.length, `${label}: ${decoded.length} strokes decoded, ${input.length} written`);
  decoded.forEach((o, i) => {
    const s = o.stroke, f = s.flex, want = input[i];
    if (!want) return;
    const penName = doc.note.stringIds.get(f.penNameId), profile = profiles.get(penName);
    if (penName !== (want.pen === 'pencil' ? PENCIL2 : INKPEN2) || !profile) { strokeErr(`stroke ${i} pen ${penName} for ${want.pen}`); return; }
    const base = JSON.stringify([o.type, o.childCount, o.base.size, o.base.flexOffset, o.base.mask1, o.base.flexMask, o.base.version, o.base.reserved32, o.base.reserved8]);
    if (!profile.base.has(base)) strokeErr(`stroke ${i} base record ${base} unlike samples`);
    if (o.base.pageWidth !== doc.pages[0].width || o.base.pageHeight !== doc.pages[0].height) strokeErr(`stroke ${i} base page size ${o.base.pageWidth}x${o.base.pageHeight}`);
    if (!(o.base.modifiedTime > 0n)) strokeErr(`stroke ${i} has no pen-up time`);
    if (!profile.strokeMask1.has(s.mask1) || !profile.strokeFlexMask.has(s.flexMask) || !profile.tail.has(s.tail)) strokeErr(`stroke ${i} masks 0x${s.mask1.toString(16)}/0x${s.flexMask.toString(16)} tail ${s.tail}`);
    if (!profile.advanced.has(doc.note.stringIds.get(f.advancedSettingId))) strokeErr(`stroke ${i} pen setting`);
    if (f.float100 !== f.penSize || !profile.int400.has(f.int400) || !profile.float2000.has(f.float2000)) strokeErr(`stroke ${i} pen fields`);
    if (s.tilts.some((v) => v < profile.tilt[0] || v > profile.tilt[1]) || s.orientations.some((v) => v < profile.orientation[0] || v > profile.orientation[1])) strokeErr(`stroke ${i} tilt/orientation outside sample range`);
    if (!profile.t0.has(s.timestamps[0]) || s.timestamps.some((t, k) => k && t <= s.timestamps[k - 1])) strokeErr(`stroke ${i} timestamps`);
    // round trip: point count, coordinates, bbox, colour, size, pressure
    if (s.pointCount !== want.points.length) strokeErr(`stroke ${i} has ${s.pointCount} points, wrote ${want.points.length}`);
    const pointErr = Math.max(...s.points.map(([x, y], k) => Math.max(Math.abs(x - want.points[k][0]), Math.abs(y - want.points[k][1]))));
    if (!(pointErr <= 1 / 64 + 1e-9)) strokeErr(`stroke ${i} point error ${pointErr}`);
    const xs = s.points.map((q) => q[0]), ys = s.points.map((q) => q[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const wx = want.points.map((q) => q[0]), wy = want.points.map((q) => q[1]);
    const wantBox = [Math.min(...wx), Math.min(...wy), Math.max(...wx), Math.max(...wy)];
    if (!bbox.every((v, k) => Math.abs(v - o.base.rect[k]) < 1e-9 && Math.abs(v - wantBox[k]) <= 1 / 64 + 1e-9)) strokeErr(`stroke ${i} bbox ${o.base.rect} vs ${wantBox}`);
    if (f.color !== want.color) strokeErr(`stroke ${i} colour 0x${f.color?.toString(16)} != 0x${want.color.toString(16)}`);
    if (f.penSize !== Math.fround(want.size)) strokeErr(`stroke ${i} size ${f.penSize} != ${want.size}`);
    const pressureErr = Math.max(...s.pressures.map((p, k) => Math.abs(p - want.pressures[k])));
    // one 1/4096 step: deltas round to nearest except where they are held inside [0, 1]
    if (!(pressureErr <= 1 / 4096 + 1e-6) || s.pressures.some((p) => p < 0 || p > 1)) strokeErr(`stroke ${i} pressure error ${pressureErr}`);
  });
  const predicted = inkDrawnRect(decoded, (o) => (doc.note.stringIds.get(o.stroke.flex.penNameId) === PENCIL2 ? o.stroke.flex.penSize + 4 : inkPad(o)));
  check(predicted.every((v, k) => Math.abs(v - doc.pages[0].properties.drawnRect[k]) < 1e-6), `${label}: drawnRect ${doc.pages[0].properties.drawnRect} != formula ${predicted}`);

  // --- render decoded strokes back onto the source image grid and compare inked pixels
  const page = doc.pages[0];
  const margin = Math.round(Math.min(page.width, page.height) * MARGIN_PERCENT / 100);
  const scale = Math.min((page.width - 2 * margin) / image.width, (page.height - 2 * margin) / image.height);
  const left = (page.width - image.width * scale) / 2, top = (page.height - image.height * scale) / 2;
  const TW = truth.width, TH = truth.height;
  // As the device draws them (FORMAT.md section 8): InkPen2 written slowly keeps its pen size and ignores pressure;
  // Pencil2 lays down the tone its grain gives its alpha.
  const isPen = (o) => doc.note.stringIds.get(o.stroke.flex.penNameId) === INKPEN2;
  const deviceWidths = (o) => isPen(o) ? o.stroke.points.map(() => o.stroke.flex.penSize) : o.stroke.pressures.map((p) => o.stroke.flex.penSize * p);
  const rendered = renderStrokes(decoded.map((o) => ({ points: o.stroke.points, widths: deviceWidths(o), color: o.stroke.flex.color ?? 0xFF000000,
    alpha: isPen(o) ? undefined : core.pencilTone(((o.stroke.flex.color ?? 0xFF000000) >>> 24) / 255) })),
    TW, TH, (x) => (x - left) / scale * f, (y) => (y - top) / scale * f, scale / f);
  const source = sourceMask(truth);
  let both = 0, either = 0;
  const diff = new Uint8ClampedArray(TW * TH * 4);
  for (let i = 0; i < source.length; i++) {
    const a = source[i], b = rendered.mask[i];
    if (a && b) both++;
    if (a || b) either++;
    const c = a && b ? [40, 40, 40] : a ? [230, 40, 40] : b ? [40, 90, 230] : [255, 255, 255];
    diff.set([...c, 255], i * 4);
  }
  const iou = either ? both / either : 0;
  // Every stroke centre line must stay on the drawing: within half its width + 2 input px of any visible ink.
  const toInk = inkDistance(sourceMask(truth, 0.03, 0), TW, TH);
  let offInk = 0, worstOff = 0;
  for (const o of decoded) {
    const s = o.stroke, pts = s.points.map(([x, y]) => [(x - left) / scale * f, (y - top) / scale * f]), ws = deviceWidths(o);
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[Math.max(0, i - 1)], [bx, by] = pts[i], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, x = clampInt(ax + (bx - ax) * t, TW), y = clampInt(ay + (by - ay) * t, TH);
        const width = (ws[Math.max(0, i - 1)] + (ws[i] - ws[Math.max(0, i - 1)]) * t) / scale * f;
        const over = toInk[y * TW + x] - (2 * f + width / 2);
        if (over > 0) { offInk++; worstOff = Math.max(worstOff, over); }
      }
    }
  }
  if (save) {
    fs.writeFileSync(path.join(OUT, `${fixture.name}.strokes.png`), encodePng(TW, TH, rendered.rgba));
    fs.writeFileSync(path.join(OUT, `${fixture.name}.diff.png`), encodePng(TW, TH, diff));
  }
  // Tone: mean difference of darkness (source composited on white vs. the composited strokes), both box-blurred
  // over a few pixels so hatching is compared as the tone it lays down.
  let toneErr = 0;
  if (fixture.toneTarget) {
    const darkness = (px, alpha) => { const d = new Float32Array(TW * TH); for (let i = 0; i < TW * TH; i++) { const a = alpha ? px[i * 4 + 3] / 255 : 1; d[i] = Math.max(...[0, 1, 2].map((c) => 255 - (px[i * 4 + c] * a + 255 * (1 - a)))) / 255; } return d; };
    const blur = (src, r) => { const out = new Float32Array(src.length); for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { let sum = 0, n = 0; for (let yy = Math.max(0, y - r); yy <= Math.min(TH - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(TW - 1, x + r); xx++) { sum += src[yy * TW + xx]; n++; } out[y * TW + x] = sum / n; } return out; };
    const r = Math.max(2, Math.round(3 * f));
    const a = blur(darkness(truth.pixels, true), r), b = blur(darkness(rendered.rgba, false), r);
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > 0.03 || b[i] > 0.03) { toneErr += Math.abs(a[i] - b[i]); n++; }
    toneErr = n ? toneErr / n : 0;
  }

  // --- quality: IoU, one drawn line = one traced line (written as pieces), colours from the source pixels
  const points = decoded.reduce((sum, o) => sum + o.stroke.pointCount, 0);
  const isPencil = (o) => doc.note.stringIds.get(o.stroke.flex.penNameId) === PENCIL2;
  const pens = decoded.filter((o) => !isPencil(o)), pencilCount = decoded.length - pens.length;
  const penLines = traced.strokes.filter((s) => s.pen !== 'pencil').length;
  console.log(`  ${label}: ${penLines} pen lines in ${pens.length} strokes + ${pencilCount} pencil strokes, ${points} points, IoU ${iou.toFixed(4)}${fixture.toneTarget ? `, tone error ${toneErr.toFixed(4)}` : ''}, traced in ${traceMs} ms, ${built.bytes.length} bytes`);
  {
    const iouTarget = fixture.iouTarget ?? IOU_TARGET;
    check(iou > iouTarget, `${label}: IoU ${iou.toFixed(4)} <= ${iouTarget}`);
    check(offInk === 0, `${label}: ${offInk} stroke samples off the ink (worst ${worstOff.toFixed(1)} px beyond the line)`);
    if (fixture.lines !== null) check(penLines === fixture.lines, `${label}: ${penLines} pen lines for ${fixture.lines} drawn lines`);
    // Line art stays all pen; shading must come out as pencil and match the source tone.
    check(fixture.pencil ? pencilCount > 0 : pencilCount === 0, `${label}: ${pencilCount} pencil strokes`);
    if (fixture.toneTarget) check(toneErr < fixture.toneTarget, `${label}: tone error ${toneErr.toFixed(4)} >= ${fixture.toneTarget}`);
    const inPalette = (palette, argb, alphaToo) => palette.findIndex((p) => Math.max(Math.abs(p[0] - argb[0]), Math.abs(p[1] - argb[1]), Math.abs(p[2] - argb[2])) <= 12 && (!alphaToo || Math.abs(p[3] - argb[3]) <= 26));
    const used = new Set();
    for (const o of decoded) {
      const c = o.stroke.flex.color ?? 0xFF000000;
      const argb = [(c >>> 16) & 255, (c >>> 8) & 255, c & 255, c >>> 24];
      if (isPencil(o)) { if (fixture.pencil) check(inPalette(fixture.pencil, argb, false) >= 0 && argb[3] > 0, `${label}: pencil colour ${argb} not the shading ink`); continue; }
      if (!fixture.palette) continue;
      const k = inPalette(fixture.palette, argb, true);
      // A fading line is drawn in its colour composited over the white page, at the opacity under each piece.
      const over = (a) => fixture.palette.map((p) => p.map((v, ch) => (ch < 3 ? v * a + 255 * (1 - a) : 255)));
      const faded = fixture.fades && k < 0 && Array.from({ length: 100 }, (_, i) => i / 100).some((a) => inPalette(over(a), argb, true) >= 0);
      if (check(k >= 0 || faded, `${label}: stroke colour ${argb} not in the drawing's palette`) && k >= 0) used.add(k);
    }
    if (fixture.palette) check(used.size === fixture.palette.length, `${label}: ${fixture.palette.length - used.size} drawing colours missing`);
  }
  return { iou, strokes: decoded.length };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { core, html } = loadCore();
  const unfinished = new RegExp(`\\b(${['TO' + 'DO', 'FIX' + 'ME', 'X' + 'XX', 'st' + 'ub'].join('|')})\\b`, 'i');  // built in pieces so this line does not match itself
  for (const file of [HTML, __filename, path.join(__dirname, 'sdocx_parser.js'), path.join(__dirname, 'make_fixtures.py')]) {
    check(!unfinished.test(fs.readFileSync(file, 'utf8')), `${path.basename(file)} contains an unfinished-work marker`);
  }
  check(/id="preview-img"/.test(html) && /id="stroke-canvas"/.test(html), 'image preview or stroke preview canvas missing');
  check(/id="detail"/.test(html) && /id="margin"/.test(html) && /id="background"/.test(html) && /id="note-name"/.test(html), 'UI controls missing');

  const docs = loadSamples();
  if (docs.length !== SAMPLES.length) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
  checkDrawnRectFormula(docs);
  const ref = docs[0];
  const titled = docs[2];
  const profile = sampleProfile(docs), pencilProfile = sampleProfile(docs, PENCIL2);
  const profiles = new Map([[INKPEN2, profile], [PENCIL2, pencilProfile]]);
  check(pencilProfile.strokeCount > 0 && pencilProfile.advanced.has(PENCIL_SETTING), `Pencil2 sample strokes: ${pencilProfile.strokeCount}, settings ${[...pencilProfile.advanced]}`);
  console.log(`  Pencil2 profile from ${pencilProfile.strokeCount} sample strokes: mask1 ${[...pencilProfile.strokeMask1].map((v) => '0x' + v.toString(16))}, flex ${[...pencilProfile.strokeFlexMask].map((v) => '0x' + v.toString(16))}, float2000 ${[...pencilProfile.float2000].map((v) => v.toFixed(4))}`);
  console.log(`  InkPen2 profile from ${profile.strokeCount} sample strokes: mask1 ${[...profile.strokeMask1].map((v) => '0x' + v.toString(16))}, flex ${[...profile.strokeFlexMask].map((v) => '0x' + v.toString(16))}, tilt ${profile.tilt.map((v) => v.toFixed(3))}, orientation ${profile.orientation.map((v) => v.toFixed(3))}`);
  // Title text record: 105 bytes empty; samples show +2 bytes per character plus one paragraph span block.
  const spanBytes = titled.note.titleObject.recordSizes[2] - ref.note.titleObject.recordSizes[2] - 2 * titled.note.titleObject.text.length;
  const titleRecordSize = (title) => ref.note.titleObject.recordSizes[2] + (title.length ? 2 * title.length + spanBytes : 0);

  console.log('Fixtures (generated .sdocx re-parsed, rendered back, compared):');
  for (const fixture of FIXTURES) {
    try {
      for (const detail of [DEFAULT_DETAIL, 0, 60]) runFixture(core, fixture, ref, profiles, { detail, save: detail === DEFAULT_DETAIL, titleRecordSize });
    } catch (error) {
      check(false, `${fixture.name}: ${error.stack}`);
    }
  }
  runEdgeCases(core);
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------- inputs the file picker can deliver
function runEdgeCases(core) {
  console.log('Edge cases:');
  const image = (w, h, ink) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(x, y)) px.set([0, 0, 0, 255], (y * w + x) * 4);
    return px;
  };
  const cases = [
    ['empty transparent image', 64, 64, () => false, 0],
    ['single opaque pixel (all paper)', 1, 1, () => true, 0],
    ['hard-edged 1 px lines', 200, 200, (x, y) => (x === 50 && y > 10 && y < 190) || (y === 100 && x > 10 && x < 190) || (x === y && x > 120), 3],
    // 64 + 64 crossing lines at the UI's 2048 px cap; the two along the top and left edge meet in one L.
    ['2048 px line grid', 2048, 2048, (x, y) => x % 32 < 3 || y % 32 < 3, 127],
  ];
  for (const [name, w, h, ink, expected] of cases) {
    const started = Date.now();
    const traced = core.vectorize(image(w, h, ink), w, h, { detail: DEFAULT_DETAIL });
    let parsed = 0, written = 0;
    if (traced.strokes.length) {
      const geometry = core.pageGeometry(w, h, MARGIN_PERCENT);
      const layout = core.layoutStrokes(traced, geometry);
      const built = core.buildSdocx({ title: name, page: geometry, background: 0xFFFFFFFF, strokes: layout, now: NOW });
      parsed = strokesOf(parseSdocx(Buffer.from(built.bytes))).length; written = layout.length;
    }
    check(traced.strokes.length === expected && parsed === written, `${name}: ${traced.strokes.length} lines traced (expected ${expected}), ${parsed} of ${written} strokes parsed`);
    console.log(`  ${name}: ${traced.strokes.length} strokes in ${Date.now() - started} ms`);
  }
  // A photographed page: warm paper lit from the top left (255 -> ~170 at the far corner) with one dark line.
  {
    const w = 300, h = 200, px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const light = 1 - 0.33 * Math.hypot(x / w, y / h) / Math.SQRT2, line = Math.abs(y - 100) < 2 && x > 30 && x < 270;
      px.set([255 * light, 240 * light, 220 * light].map((v) => (line ? v * 0.15 : v)).concat(255), (y * w + x) * 4);
    }
    const flat = core.flattenPaper(px, w, h), at = (x, y) => flat[(y * w + x) * 4 + 1];
    check(flat !== px && [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)].every((v) => v >= 245) && at(150, 100) < 60,
      `paper flattening: corners ${[at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)]}, line ${at(150, 100)}`);
    const even = image(64, 64, (x, y) => x === y);
    for (let i = 0; i < even.length; i += 4) if (!even[i + 3]) even.set([255, 255, 255, 255], i);
    check(core.flattenPaper(even, 64, 64) === even, 'paper flattening changed an evenly lit image');
    console.log(`  photographed paper: corners ${[at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)].join('/')} after flattening, line ${at(150, 100)}`);
  }
  // Light colours on white paper read as low coverage; they must still be Pen strokes in their own colour, not pencil.
  // A thick light line (12 px) must not pass for shading and be hatched.
  for (const [rgbIn, lw] of [[[255, 170, 200], 4], [[150, 200, 255], 4], [[255, 230, 0], 4], [[90, 190, 240], 4], [[90, 190, 240], 12], [[180, 215, 245], 12]]) {
    const w = 120, h = 60, px = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 30 - lw / 2; y < 30 + lw / 2; y++) for (let x = 10; x < 110; x++) px.set(rgbIn, (y * w + x) * 4);
    const s = core.vectorize(px, w, h, { detail: DEFAULT_DETAIL }).strokes, want = (0xFF000000 | (rgbIn[0] << 16) | (rgbIn[1] << 8) | rgbIn[2]) >>> 0;
    check(s.length === 1 && s[0].pen === 'pen' && s[0].color === want, `light colour ${rgbIn} ${lw} px: ${s.map((q) => `${q.pen} ${q.color.toString(16)}`)}`);
  }
  // Other paper colours: ink keeps its exact colour and stays one Pen stroke (paper flattening must not touch them).
  for (const [paper, ink] of [[[0, 0, 0], [255, 255, 255]], [[0, 0, 0], [230, 40, 40]], [[60, 60, 64], [0, 0, 0]], [[60, 60, 64], [90, 190, 240]],
    [[255, 248, 220], [90, 190, 240]], [[250, 240, 200], [255, 255, 255]]]) {
    const w = 120, h = 60, px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([...paper, 255], 4 * i);
    for (let y = 24; y < 36; y++) for (let x = 10; x < 110; x++) px.set(ink, (y * w + x) * 4);
    const flat = core.flattenPaper(px, w, h), s = core.vectorize(flat, w, h, { detail: DEFAULT_DETAIL }).strokes;
    const want = (0xFF000000 | (ink[0] << 16) | (ink[1] << 8) | ink[2]) >>> 0;
    check(flat === px && s.length === 1 && s[0].pen === 'pen' && s[0].color === want, `${ink} on ${paper}: ${s.map((q) => `${q.pen} ${q.color.toString(16)}`)}`);
  }
  // Letterbox bars (black, left and right) are cut off, so the cream paper is the paper and only the line is traced.
  {
    const w = 200, h = 120, px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(x < 20 || x >= 180 ? [0, 0, 0, 255] : [250, 245, 225, 255], (y * w + x) * 4);
    for (let y = 58; y < 62; y++) for (let x = 40; x < 160; x++) px.set([0, 150, 170, 255], (y * w + x) * 4);
    const cut = core.trimFrame(px, w, h), s = core.vectorize(cut.rgba, cut.width, cut.height, { detail: DEFAULT_DETAIL }).strokes;
    check(cut.width === 156 && cut.height === h && s.length === 1 && s[0].color === 0xFF0096AA, `frame trim: ${cut.width}x${cut.height}, ${s.map((q) => `${q.pen} ${q.color.toString(16)}`)}`);
    console.log(`  letterboxed picture: cut to ${cut.width}x${cut.height}, ${s.length} stroke`);
  }
  const refuses = (build, pattern) => { try { build(); return false; } catch (error) { return pattern.test(error.message); } };
  const page = core.pageGeometry(100, 100, 0);
  const line = { points: [[10, 10], [20, 20]], pressures: [1, 1], size: 2, color: 0xFF000000 };
  check(refuses(() => core.buildSdocx({ title: 't', page, background: 0xFFFFFFFF, strokes: [] }), /No lines/), 'empty stroke list accepted');
  check(refuses(() => core.buildSdocx({ title: 't', page, background: 0xFFFFFFFF, strokes: new Array(core.MAX_STROKES + 1).fill(line) }), /too many/), 'stroke cap not enforced');
}

main();
