'use strict';
// Reference parser for the Samsung Notes .sdocx layout documented in FORMAT.md.
// Every reader throws on a structural inconsistency, so "parsed without error" means
// sizes, offsets, counts and the whole hash chain were checked.
const zlib = require('zlib');
const crypto = require('crypto');

const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const identityHash = (id, time) => sha256(Buffer.from(String(id) + String(time), 'utf8'));
const hex = (n) => '0x' + n.toString(16);

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  need(n, what) {
    if (n < 0 || this.pos + n > this.end) throw new Error(`truncated ${what || 'read'}: need ${n} bytes at ${hex(this.pos)} (end ${hex(this.end)})`);
  }
  u8() { this.need(1); return this.buf[this.pos++]; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  bytes(n, what) { this.need(n, what); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  ascii(n) { return this.bytes(n).toString('latin1'); }
  str16() { const n = this.u16(); return this.bytes(n * 2, 'utf16 string').toString('utf16le'); }
  str32() { const n = this.u32(); return n === 0xFFFFFFFF ? null : this.bytes(n * 2, 'utf16 string').toString('utf16le'); }
  varMask() { const n = this.u8(); if (n > 4) throw new Error(`mask width ${n} at ${hex(this.pos - 1)}`); let v = 0; for (let i = 0; i < n; i++) v += this.u8() * 2 ** (8 * i); return { width: n, value: v }; }
}

function expect(cond, message) { if (!cond) throw new Error(message); }

// ---------------------------------------------------------------- ZIP container
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  expect(eocd >= 0, 'ZIP end-of-central-directory record not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLength = buf.readUInt16LE(eocd + 20);
  const entries = new Map();
  const order = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p) === 0x02014B50, `bad central directory entry at ${hex(p)}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    expect(buf.readUInt32LE(local) === 0x04034B50, `bad local header for ${name}`);
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const raw = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported ZIP method ${method} for ${name}`);
    expect(data.length === usize, `${name}: size ${data.length} != ${usize}`);
    expect(zlib.crc32(data) === crc, `${name}: CRC mismatch`);
    entries.set(name, data);
    order.push({ name, method, size: usize });
    p += 46 + nlen + xlen + clen;
  }
  expect(p === cdOffset + cdSize, 'central directory size mismatch');
  return { entries, order, trailer: buf.subarray(eocd + 22 + commentLength) };
}

// ---------------------------------------------------------------- note.note
const NOTE_FLAG_FIELDS = [
  // [bit, name, reader] in serialization order (FORMAT.md §3.3)
  [0x80, 'lastEditedPageIndex', (r) => r.i32()],
  [0x200, 'lastEditedPageImage', (r) => ({ imageId: r.i32(), time: r.u64() })],
  [0x400, 'stringIds', (r) => {
    const size = r.u32(); const end = r.pos + size; const count = r.u16(); const map = new Map();
    for (let i = 0; i < count; i++) { const id = r.i32(); map.set(id, r.str16()); }
    expect(r.pos === end, `string-id block size ${size} does not match its ${count} entries`);
    return map;
  }],
  [0x800, 'bodyTextFontSizeDelta', (r) => r.i32()],
  [0x8000, 'currentPenInfo', (r) => {
    const start = r.pos; const size = r.u32(); const penName = r.str16();
    const penSize = r.f32(); const color = r.u32();
    const rest = r.bytes(size - (r.pos - start), 'pen info');
    return { size, penName, penSize, color, rest };
  }],
  [0x40000, 'fixedTextDirection', (r) => r.i32()],
  [0x80000, 'fixedBackgroundTheme', (r) => r.i32()],
];
const NOTE_KNOWN_FLAGS = NOTE_FLAG_FIELDS.reduce((m, [bit]) => m | bit, 0);

function parseNote(buf) {
  const r = new Reader(buf, 0, buf.length - 32);
  const n = { size: buf.length };
  n.optionalOffset = r.u32();
  expect(r.u8() === 4, 'note: header flag width != 4');
  n.headerFlags = r.u32();
  expect(r.u8() === 4, 'note: property flag width != 4');
  n.propertyFlags = r.u32();
  expect((n.propertyFlags & ~NOTE_KNOWN_FLAGS) === 0, `note: undocumented property flags ${hex(n.propertyFlags & ~NOTE_KNOWN_FLAGS)}`);
  n.formatVersion = r.u32();
  n.noteId = r.str16();
  n.fileRevision = r.u32();
  n.createdTime = r.u64();
  n.modifiedTime = r.u64();
  n.width = r.u32(); n.height = r.u32();
  n.horizontalPadding = r.u32(); n.verticalPadding = r.u32();
  n.minFormatVersion = r.u32();
  const titleSize = r.u32(); n.titleObject = parseTextObject(r.bytes(titleSize, 'title object'));
  const bodySize = r.u32(); n.bodyObject = parseTextObject(r.bytes(bodySize, 'body object'));
  if (n.headerFlags & 0x8) { n.pageWidth = r.u32(); n.pageHeight = r.u32(); }
  expect(r.pos === n.optionalOffset, `note: optional block offset ${hex(n.optionalOffset)} != ${hex(r.pos)}`);
  for (const [bit, name, read] of NOTE_FLAG_FIELDS) if (n.propertyFlags & bit) n[name] = read(r);
  expect(r.pos === buf.length - 32, `note: ${buf.length - 32 - r.pos} unparsed bytes before the hash`);
  n.hash = buf.subarray(buf.length - 32);
  expect(sha256(buf.subarray(0, buf.length - 32)).equals(n.hash), 'note: SHA-256 trailer mismatch');
  return n;
}

// Serialized text object (title/body in note.note): a chain of subrecords.
function parseTextObject(buf) {
  const subrecords = parseSubrecords(buf, 0, buf.length);
  const base = parseBaseRecord(buf, subrecords[0]);
  const shape = subrecords.find((s) => s.type === 7);
  let text = '';
  if (shape) {
    const r = new Reader(buf, shape.start + 6, shape.end);
    const own = r.u32();
    const rr = new Reader(buf, shape.start + own, shape.end);
    const commonSize = rr.u32();
    const tr = new Reader(buf, rr.pos, rr.pos + commonSize);
    text = tr.bytes(tr.u32() * 2).toString('utf16le');
  }
  return { size: buf.length, recordTypes: subrecords.map((s) => s.type), recordSizes: subrecords.map((s) => s.size), base, text };
}

// ---------------------------------------------------------------- pageIdInfo.dat / mediaInfo.dat / end_tag.bin
function parsePageIdInfo(buf) {
  const r = new Reader(buf);
  const fileHash = r.bytes(32);
  const count = r.u16();
  const pages = [];
  for (let i = 0; i < count; i++) pages.push({ id: r.str16(), hash: r.bytes(32) });
  expect(r.pos === buf.length, 'pageIdInfo: trailing bytes');
  return { fileHash, pages };
}

function parseMediaInfo(buf) {
  const r = new Reader(buf);
  const formatVersion = r.u32();
  const count = r.u16();
  const entries = [];
  for (let i = 0; i < count; i++) {
    const size = r.u32(); const end = r.pos + size;
    const e = { bindId: r.u32(), name: r.str16(), fileHash: r.ascii(64), refCount: r.u16(), time: r.u64(), attached: r.u8() };
    e.extra = r.bytes(end - r.pos, 'media entry');
    entries.push(e);
  }
  expect(r.ascii(4) === 'EOFX', 'mediaInfo: missing EOFX footer');
  expect(r.pos === buf.length, 'mediaInfo: trailing bytes');
  return { formatVersion, entries };
}

function parseEndTag(buf) {
  const r = new Reader(buf);
  const size = r.u16();
  expect(size === buf.length - 2, `end_tag: payload size ${size} != ${buf.length - 2}`);
  const t = {
    formatVersion: r.i32(), noteId: r.str16(), modifiedTime: r.u64(), propertyFlags: r.i32(), coverImage: r.str16(),
    width: r.i32(), height: r.f32(), title: r.str16(), thumbnailWidth: r.i32(), thumbnailHeight: r.i32(),
    appPatchName: r.str16(), minFormatVersion: r.i32(), createdTime: r.u64(), lastViewedPageIndex: r.i32(),
    pageMode: r.u16(), documentType: r.u16(), ownerId: r.str16(), reserved1: r.i32(), reserved2: r.i32(),
    displayCreatedTime: r.u64(), displayModifiedTime: r.u64(), lastRecognizedDataModifiedTime: r.u64(),
    fixedFont: r.str16(), fixedTextDirection: r.i32(), fixedBackgroundTheme: r.i32(), serverCheckpoint: r.i64(),
    newOrientation: r.i32(), minUnknownVersion: r.i32(), appCustomData: r.str32(),
  };
  t.footer = r.ascii(r.end - r.pos);
  expect(t.footer === 'Document for S-Pen SDK', 'end_tag: footer mismatch');
  return t;
}

// ---------------------------------------------------------------- .page
const PAGE_FOOTER = 'Page for SAMSUNG S-Pen SDK';
const PAGE_PROPERTY_FIELDS = [
  [0x1, 'drawnRect', (r) => [r.f64(), r.f64(), r.f64(), r.f64()]],
  [0x2, 'tags', (r) => { const n = r.u16(); return Array.from({ length: n }, () => r.str16()); }],
  [0x4, 'templateUri', (r) => r.str16()],
  [0x8, 'bgImageId', (r) => r.u32()],
  [0x10, 'bgImageMode', (r) => r.u32()],
  [0x20, 'bgColor', (r) => r.u32()],
  [0x40, 'bgWidth', (r) => r.u32()],
  [0x80, 'bgRotation', (r) => r.u32()],
  [0x200, 'templateType', (r) => r.u32()],
  [0x400, 'canvasCache', (r) => {
    const count = r.u32(); const recordSize = r.u16(); const records = [];
    for (let i = 0; i < count; i++) {
      const rr = new Reader(r.buf, r.pos, r.pos + recordSize);
      records.push({ key: rr.u32(), fileId: rr.u32(), width: rr.u32(), height: rr.u32(), darkMode: rr.u8(), bgColor: rr.u32(), raw: r.buf.subarray(r.pos, r.pos + recordSize) });
      r.bytes(recordSize, 'canvas cache record');
    }
    return { recordSize, records };
  }],
  [0x800, 'importedDataHeight', (r) => r.u32()],
];
const PAGE_KNOWN_MASK = PAGE_PROPERTY_FIELDS.reduce((m, [bit]) => m | bit, 0);

function parsePage(buf, name) {
  expect(buf.length > 58 && buf.subarray(buf.length - 26).toString('latin1') === PAGE_FOOTER, `${name}: missing page footer`);
  const end = buf.length - 58;
  const r = new Reader(buf, 0, end);
  const p = { name, size: buf.length };
  p.layerOffset = r.u32();
  p.propertyOffset = r.u32();
  p.const08 = r.u8();
  p.textOnly = r.u32();
  p.const0D = r.u8();
  p.propertyMask = r.u32();
  expect((p.propertyMask & ~PAGE_KNOWN_MASK) === 0, `${name}: undocumented page property bits ${hex(p.propertyMask & ~PAGE_KNOWN_MASK)}`);
  p.orientation = r.u32();
  p.width = r.u32(); p.height = r.u32();
  p.offsetX = r.u32(); p.offsetY = r.u32();
  p.id = r.str16();
  p.modifiedTime = r.u64();
  p.formatVersion = r.u32(); p.minFormatVersion = r.u32();
  p.headerPadding = r.bytes(p.propertyOffset - r.pos, 'page header padding');
  expect(p.headerPadding.every((b) => b === 0), `${name}: non-zero bytes before property block`);
  p.properties = {};
  for (const [bit, key, read] of PAGE_PROPERTY_FIELDS) if (p.propertyMask & bit) p.properties[key] = read(r);
  expect(r.pos === p.layerOffset, `${name}: layer offset ${hex(p.layerOffset)} != end of property block ${hex(r.pos)}`);
  p.layerCount = r.u16();
  p.currentLayer = r.u16();
  p.layers = [];
  for (let i = 0; i < p.layerCount; i++) p.layers.push(parseLayer(buf, r));
  expect(r.pos === end, `${name}: ${end - r.pos} unparsed bytes after the layers`);
  p.hash = buf.subarray(end, end + 32);
  const expected = identityHash(p.id, p.modifiedTime);
  expect(sha256(...p.layers.map((l) => l.hash), expected).equals(p.hash), `${name}: page hash mismatch`);
  return p;
}

const LAYER_META = [[0x1, 'transparency', (r) => r.u32()], [0x2, 'bgColor', (r) => r.u32()], [0x4, 'name', (r) => r.str16()],
  [0x8, 'id', (r) => r.str16()], [0x10, 'modifiedTime', (r) => r.u64()], [0x20, 'thumbnailId', (r) => r.u32()]];

function parseLayer(buf, r) {
  const start = r.pos;
  const L = { start };
  L.headerSize = r.u32();
  L.metadataOffset = r.u32();
  L.const8 = r.u8(); L.flags1 = r.u8(); L.constA = r.u8(); L.flags2 = r.u8();
  L.number = r.u32();
  expect(L.metadataOffset === r.pos, `layer @${hex(start)}: metadata offset ${hex(L.metadataOffset)} != ${hex(r.pos)}`);
  for (const [bit, key, read] of LAYER_META) if (L.flags2 & bit) L[key] = read(r);
  expect(r.pos === start + L.headerSize, `layer @${hex(start)}: header size mismatch`);
  L.objectCount = r.u32();
  L.objects = [];
  for (let i = 0; i < L.objectCount; i++) L.objects.push(parseObject(buf, r));
  L.hash = r.bytes(32);
  const expected = L.id !== undefined ? identityHash(L.id, L.modifiedTime) : Buffer.alloc(0);
  expect(sha256(...L.objects.map((o) => o.hash), expected).equals(L.hash), `layer @${hex(start)}: layer hash mismatch`);
  return L;
}

function parseSubrecords(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    expect(p + 6 <= end, `subrecord header truncated at ${hex(p)}`);
    const size = buf.readUInt32LE(p);
    const type = buf.readUInt16LE(p + 4);
    expect(size >= 6 && p + size <= end, `subrecord at ${hex(p)} size ${size} overruns object`);
    out.push({ start: p, end: p + size, size, type });
    p += size;
  }
  return out;
}

function parseObject(buf, r) {
  const start = r.pos;
  const o = { start, type: r.u8(), childCount: r.u16(), size: r.u32() };
  const payloadStart = r.pos;
  r.bytes(o.size - 32, 'object payload');
  o.hash = r.bytes(32);
  o.subrecords = parseSubrecords(buf, payloadStart, payloadStart + o.size - 32);
  expect(o.subrecords.length && o.subrecords[0].type === 0, `object @${hex(start)}: first subrecord is not an object base`);
  o.base = parseBaseRecord(buf, o.subrecords[0]);
  expect(identityHash(o.base.id, o.base.createdTime).equals(o.hash), `object @${hex(start)}: object hash mismatch`);
  const strokeRecord = o.subrecords.find((s) => s.type === 1);
  if (o.type === 1) {
    expect(strokeRecord, `stroke object @${hex(start)} has no stroke subrecord`);
    o.stroke = parseStrokeRecord(buf, strokeRecord);
  }
  o.children = [];
  for (let i = 0; i < o.childCount; i++) o.children.push(parseObject(buf, r));
  return o;
}

// Object base subrecord (type 0), FORMAT.md §4.4
function parseBaseRecord(buf, rec) {
  const r = new Reader(buf, rec.start, rec.end);
  r.u32(); r.u16();
  const b = { size: rec.size };
  b.flexOffset = r.u32();
  b.mask1 = r.varMask().value;
  b.flexMask = r.varMask().value;
  b.version = r.u32();
  const idLength = r.u16();
  b.id = r.ascii(idLength);
  b.createdTime = r.u64();
  b.rect = [r.f64(), r.f64(), r.f64(), r.f64()];
  b.reserved32 = r.u32();
  b.reserved8 = r.u8();
  if (b.flexMask) {
    expect(rec.start + b.flexOffset === r.pos, `base record @${hex(rec.start)}: flexible offset mismatch`);
    if (b.flexMask & 0x1) b.rotation = r.f32();
    if (b.flexMask & 0x20) {
      // Typed custom-data map, e.g. "extra_key_stroke_shape" -> 1 on auto-shape strokes.
      const kind = r.u8();
      expect(kind === 2, `base record @${hex(rec.start)}: custom-data kind ${kind}`);
      const count = r.u16();
      b.customData = {};
      for (let i = 0; i < count; i++) { const key = r.ascii(r.u16()).replace(/\0$/, ''); b.customData[key] = r.u32(); }
    }
    if (b.flexMask & 0x2000) b.modifiedTime = r.u64();
    if (b.flexMask & 0x4000) { b.pageWidth = r.u32(); b.pageHeight = r.u32(); }
    if (b.flexMask & 0x8000) b.flag8000 = r.u8();
    expect((b.flexMask & ~0xE021) === 0, `base record @${hex(rec.start)}: undocumented flexible bits ${hex(b.flexMask)}`);
  } else {
    expect(b.flexOffset === 0, `base record @${hex(rec.start)}: flexible offset without flexible mask`);
  }
  expect(r.pos === rec.end, `base record @${hex(rec.start)}: ${rec.end - r.pos} unparsed bytes`);
  return b;
}

// Packed u16 delta: bit15 sign, bits14..5 integer, bits4..0 1/32 fraction.
const unpackDelta = (v) => ((v & 0x7FFF) / 32) * (v & 0x8000 ? -1 : 1);

// Stroke subrecord (type 1), FORMAT.md §4.5
function parseStrokeRecord(buf, rec) {
  const r = new Reader(buf, rec.start, rec.end);
  r.u32(); r.u16();
  const s = { size: rec.size };
  s.flexOffset = r.u32();
  s.mask1 = r.varMask().value;
  s.flexMask = r.varMask().value;
  s.pointCount = r.u16();
  const n = s.pointCount;
  const geometryEnd = rec.start + s.flexOffset;
  const g = new Reader(buf, r.pos, geometryEnd);
  const compact = (s.mask1 & 0x1) !== 0;
  const axes = (s.mask1 & 0x4) !== 0;
  s.points = []; s.pressures = []; s.timestamps = []; s.tilts = []; s.orientations = [];
  const series = (out, scale) => {
    let v = g.f32(); out.push(v);
    for (let i = 1; i < n; i++) { v += unpackDelta(g.u16()) / scale; out.push(v); }
  };
  if (compact) {
    let x = g.f64(), y = g.f64();
    s.points.push([x, y]);
    for (let i = 1; i < n; i++) { x += unpackDelta(g.u16()); y += unpackDelta(g.u16()); s.points.push([x, y]); }
    series(s.pressures, 128);
    let t = g.i32(); s.timestamps.push(t);
    for (let i = 1; i < n; i++) { t += g.u16(); s.timestamps.push(t); }
    if (axes) { series(s.tilts, 32); series(s.orientations, 32); }
  } else {
    for (let i = 0; i < n; i++) s.points.push([g.f32(), g.f32()]);
    for (let i = 0; i < n; i++) s.pressures.push(g.f32());
    for (let i = 0; i < n; i++) s.timestamps.push(g.i32());
    if (axes) { for (let i = 0; i < n; i++) s.tilts.push(g.f32()); for (let i = 0; i < n; i++) s.orientations.push(g.f32()); }
  }
  s.tail = g.u16();
  expect(g.pos === geometryEnd, `stroke @${hex(rec.start)}: geometry ends at ${hex(g.pos)}, flexible block at ${hex(geometryEnd)}`);
  const f = new Reader(buf, geometryEnd, rec.end);
  const flex = {};
  if (s.flexMask & 0x0002) flex.advancedSettingId = f.u32();
  if (s.flexMask & 0x0004) flex.color = f.u32();
  if (s.flexMask & 0x0008) flex.penSize = f.f32();
  if (s.flexMask & 0x0010) flex.byte10 = f.u8();
  if (s.flexMask & 0x0080) flex.penNameId = f.u32();
  if (s.flexMask & 0x0100) flex.float100 = f.f32();
  if (s.flexMask & 0x0200) flex.int200 = f.u32();
  if (s.flexMask & 0x0400) flex.int400 = f.u32();
  if (s.flexMask & 0x0800) flex.int800 = f.u32();
  if (s.flexMask & 0x1000) flex.int1000 = f.u32();
  if (s.flexMask & 0x2000) flex.float2000 = f.f32();
  if (s.flexMask & 0x4000) flex.short4000 = f.u16();
  if (s.flexMask & 0x8000) flex.float8000 = f.f32();
  if (s.flexMask & 0x10000) flex.short10000 = f.u16();
  if (s.flexMask & 0x20000) flex.float20000 = f.f32();
  expect((s.flexMask & ~0x3FF9E) === 0, `stroke @${hex(rec.start)}: undocumented flexible bits ${hex(s.flexMask & ~0x3FF9E)}`);
  expect(f.pos === rec.end, `stroke @${hex(rec.start)}: ${rec.end - f.pos} unparsed flexible bytes`);
  s.flex = flex;
  return s;
}

// ---------------------------------------------------------------- whole package
function parseSdocx(buf) {
  const zip = readZip(Buffer.from(buf));
  const get = (name) => { const v = zip.entries.get(name); expect(v, `missing ${name}`); return v; };
  const doc = { zip };
  doc.note = parseNote(get('note.note'));
  doc.pageIdInfo = parsePageIdInfo(get('pageIdInfo.dat'));
  doc.mediaInfo = parseMediaInfo(get('media/mediaInfo.dat'));
  doc.endTag = parseEndTag(get('end_tag.bin'));
  expect(zip.trailer.length === 0 || zip.trailer.length === get('end_tag.bin').length, 'bytes after ZIP end record are not an end tag copy');
  if (zip.trailer.length) doc.trailerEndTag = parseEndTag(zip.trailer);
  expect(doc.pageIdInfo.fileHash.equals(doc.note.hash), 'pageIdInfo file hash != note.note hash');
  doc.pages = doc.pageIdInfo.pages.map((entry) => {
    const page = parsePage(get(entry.id + '.page'), entry.id + '.page');
    expect(page.id === entry.id, `${entry.id}.page: embedded id ${page.id}`);
    expect(page.hash.equals(entry.hash), `${entry.id}.page: hash differs from pageIdInfo`);
    return page;
  });
  const pageFiles = [...zip.entries.keys()].filter((k) => k.endsWith('.page'));
  expect(pageFiles.length === doc.pages.length, 'page files and pageIdInfo entries differ');
  const mediaFiles = [...zip.entries.keys()].filter((k) => k.startsWith('media/') && k !== 'media/mediaInfo.dat');
  expect(mediaFiles.length === doc.mediaInfo.entries.length, 'media files and mediaInfo entries differ');
  for (const e of doc.mediaInfo.entries) {
    const data = get('media/' + e.name);
    expect(sha256(data).toString('hex') === e.fileHash, `media ${e.name}: hash mismatch`);
  }
  const strings = doc.note.stringIds || new Map();
  for (const s of strokesOf(doc)) {
    for (const key of ['penNameId', 'advancedSettingId']) {
      if (s.stroke.flex[key] !== undefined) expect(strings.has(s.stroke.flex[key]), `stroke ${s.base.id}: ${key} ${s.stroke.flex[key]} not in note.note string table`);
    }
  }
  return doc;
}

function* walkObjects(objects) { for (const o of objects) { yield o; yield* walkObjects(o.children); } }

function strokesOf(doc) {
  const out = [];
  for (const page of doc.pages) for (const layer of page.layers) for (const o of walkObjects(layer.objects)) if (o.stroke) out.push(Object.assign(o, { page }));
  return out;
}

module.exports = { parseSdocx, strokesOf, readZip, parseNote, parsePage, unpackDelta, sha256, identityHash };

if (require.main === module) {
  const fs = require('fs');
  let failed = false;
  for (const file of process.argv.slice(2)) {
    try {
      const doc = parseSdocx(fs.readFileSync(file));
      const strings = doc.note.stringIds || new Map();
      const strokes = strokesOf(doc);
      console.log(`${file}: OK — ${doc.pages.length} pages, ${strokes.length} strokes, ${doc.mediaInfo.entries.length} media entries, note format ${doc.note.formatVersion}`);
      for (const s of strokes) {
        const f = s.stroke.flex;
        const pen = (strings.get(f.penNameId) || '?').replace('com.samsung.android.sdk.pen.pen.preload.', '');
        console.log(`  ${s.base.id} pts=${String(s.stroke.pointCount).padStart(4)} mask1=${hex(s.stroke.mask1)} flex=${hex(s.stroke.flexMask)} pen=${pen} adv=${JSON.stringify(strings.get(f.advancedSettingId))} size=${f.penSize?.toFixed(3)} color=${f.color === undefined ? '-' : hex(f.color)} rect=[${s.base.rect.map((v) => v.toFixed(1)).join(',')}]`);
      }
    } catch (error) {
      failed = true;
      console.log(`${file}: FAILED — ${error.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
