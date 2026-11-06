# Samsung Notes `.sdocx` — stroke format

Reverse-engineered from the three notes in this folder (`Notes_261106_225150`, `Notes_261106_225305`,
`Test_261106_205901`, saved by Samsung Notes with note format 4000 and 5500). The reference parser is
`tests/sdocx_parser.js`. It implements every layout below and throws on any size, offset, count, CRC or
hash mismatch. It decodes all 83 strokes (17,502 points) of the samples. Run it with:

```
node tests/sdocx_parser.js Notes_261106_225150.sdocx Notes_261106_225305.sdocx Test_261106_205901.sdocx
```

Fields marked *(unknown)* have the noted meaning unresolved. They are copied verbatim from the samples.

## 0. Conventions

| Notation | Meaning |
|---|---|
| `u8/u16/u32/u64`, `i32/i64` | little-endian integers |
| `f32/f64` | little-endian IEEE-754 |
| `str16` | `u16` character count, then UTF-16LE characters (no terminator) |
| `str32` | `u32` character count (`0xFFFFFFFF` = null), then UTF-16LE |
| `varmask` | `u8` byte width *n* (≤ 4), then an *n*-byte little-endian bit mask |
| time | `u64` microseconds since the Unix epoch, unless stated otherwise |
| id | 36-character time-based UUID (v1), e.g. `4194894c-da2c-11f1-a441-33709395d01c` |
| page unit | the page coordinate unit. A standard page is 720 × 1018 units |

## 1. Container

A `.sdocx` is a ZIP. The sample entries, in this order:

| Entry | Method | Content |
|---|---|---|
| `pageIdInfo.dat` | deflate | page list + hashes (§5) |
| `<pageId>.page` (one per page) | deflate | page: layers, stroke objects (§3) |
| `media/mediaInfo.dat` | deflate | media table (§6) |
| `media/<n>@page_<k>.spi` | stored | canvas cache bitmap per content page (§6) |
| `note.note` | deflate | note metadata, title, string table (§4) |
| `end_tag.bin` | deflate | document trailer (§7) |

After the ZIP end-of-central-directory record, Samsung appends a second copy of `end_tag.bin`
(148 bytes in all samples). It sits outside the ZIP. It is identical to the entry except
`displayCreatedTime`/`displayModifiedTime`, which are in **milliseconds** there and microseconds inside
the entry.

## 2. Hash chain

```
identityHash(id, t) = SHA-256( UTF-8( id + decimal(t) ) )

object hash = identityHash(object.base.id, object.base.createdTime)                    (§3.5)
layer hash  = SHA-256( objectHash_1 ‖ … ‖ objectHash_n ‖ identityHash(layerId, layerTime) )
page digest = SHA-256( layerHash_1 ‖ … ‖ layerHash_m   ‖ identityHash(pageId,  pageTime) )
note hash   = SHA-256( note.note[0 : len-32] )   — stored as the last 32 bytes of note.note
pageIdInfo  = note hash + (pageId, page digest) per page
```

Worked example (225150, stroke at page offset `0x5CF9`):
`SHA-256("4194894c-da2c-11f1-a441-33709395d01c" + "1794001910646912") = 09533149f5ff51b4…0dae57`,
which is the 32-byte hash stored after that object's payload. A layer with no objects hashes only
its identity hash. The chain covers ids and times but **not** geometry, so stroke data must be
validated separately (§3.6 round-trip: rect = bbox of the decoded points).

## 3. `<pageId>.page`

### 3.1 Header (fixed offsets, 36-character page id)

| Offset | Type | Field | Samples |
|---|---|---|---|
| `0x00` | u32 | layerOffset — absolute offset of the layer section (§3.3) | `0xE3` (with cache), `0xAC` (without) |
| `0x04` | u32 | propertyOffset — absolute offset of the property block | `0x80` |
| `0x08` | u8 | 4 (width of the next field) | 4 |
| `0x09` | u32 | textOnly | 0 |
| `0x0D` | u8 | 4 (width of the next field) | 4 |
| `0x0E` | u32 | propertyMask (§3.2) | `0x471` content page, `0x70` blank page |
| `0x12` | u32 | orientation | 0 |
| `0x16` | u32 | width | 720 |
| `0x1A` | u32 | height | 1018 |
| `0x1E` | u32 | offsetX | 0 |
| `0x22` | u32 | offsetY | 0 |
| `0x26` | str16 | pageId (= entry name without `.page`) | 2 + 72 bytes |
| `0x70` | u64 | page time (enters the page digest) | |
| `0x78` | u32 | formatVersion | 4000 / 5500 |
| `0x7C` | u32 | minFormatVersion | 4000 / 5500 |
| `0x80` | — | property block (zero padding up to propertyOffset if the id were shorter) | |

### 3.2 Property block (at propertyOffset, fields in ascending bit order)

| Bit | Type | Field | Samples |
|---|---|---|---|
| `0x1` | 4 × f64 | drawnRect (left, top, right, bottom). Present when the page has strokes (§8) | |
| `0x2` | u16 n + n × str16 | tags | — |
| `0x4` | str16 | templateUri | — |
| `0x8` | u32 | background image id | — |
| `0x10` | u32 | bgImageMode | 2 |
| `0x20` | u32 | bgColor ARGB | `0xFFE6E6E6`, `0xFF010101` |
| `0x40` | u32 | bgWidth (= page width) | 720 |
| `0x80` | u32 | bgRotation | — |
| `0x200` | u32 | templateType | — |
| `0x400` | u32 count, u16 recordSize (49), records | canvas cache → `.spi` file (§6) | 1 record |
| `0x800` | u32 | importedDataHeight | — |

Canvas-cache record (49 bytes): `u32 key, u32 fileId (media bindId), u32 width, u32 height, u8 darkMode,
u32 bgColor`, then 28 bytes *(unknown)*. Blank pages carry no cache (mask `0x70`).

Sample content page 225150: drawnRect at `0x80`–`0x9F`, bgImageMode `0xA0`, bgColor `0xA4`,
bgWidth `0xA8`, cache count `0xAC`, recordSize `0xB0`, record `0xB2`–`0xE2`, layer section `0xE3`.

### 3.3 Layer section (at layerOffset)

| Rel. offset | Type | Field | Samples |
|---|---|---|---|
| +0 | u16 | layerCount | 1 |
| +2 | u16 | currentLayer | 0 |
| +4 | — | layer records | |

Layer record (offsets relative to the record start *L*):

| Offset | Type | Field | Samples |
|---|---|---|---|
| L+0 | u32 | headerSize (L+0 to the object count) | 98 |
| L+4 | u32 | metadataOffset — **absolute** offset of L+16 | e.g. `0xF7` |
| L+8 | varmask (1 byte) | flags1 *(unknown)* | `01 02` |
| L+10 | varmask (1 byte) | metadata mask: `0x1` transparency u32, `0x2` bgColor u32, `0x4` name str16, `0x8` id str16, `0x10` time u64, `0x20` thumbnail id u32 | `01 18` |
| L+12 | u32 | layer number | 0 |
| L+16 | str16 | layerId (mask `0x8`) | |
| L+90 | u64 | layer time (mask `0x10`) | |
| L+98 | u32 | objectCount | |
| L+102 | — | objects (§3.4), then 32-byte layer hash (§2) | |

### 3.4 Object record

| Offset | Type | Field |
|---|---|---|
| +0 | u8 | type: **1 = stroke** (all 83 sample objects) |
| +1 | u16 | childCount (0 for strokes). Child objects follow this object's hash |
| +3 | u32 | size = payload bytes + 32 |
| +7 | — | payload: subrecords, each `u32 size, u16 type, …` |
| +7+size−32 | 32 bytes | object hash (§2) |

A stroke payload is exactly two subrecords: the object base (type 0) and the stroke (type 1).

### 3.5 Object base subrecord (type 0) — 121 bytes on strokes

| Offset | Type | Field | Strokes |
|---|---|---|---|
| +0 | u32 | size | 121 |
| +4 | u16 | type | 0 |
| +6 | u32 | flexOffset (relative to the subrecord) | 105 |
| +10 | varmask | mask1 | `02 bf 01` → `0x01BF` |
| +13 | varmask | flexMask | `04 00 60 00 00` → `0x6000` |
| +18 | u32 | version | 4000 |
| +22 | u16 | id length | 36 |
| +24 | 36 × ASCII | object id (UUID v1) | |
| +60 | u64 | createdTime: save-time stamp (µs); enters the object hash | |
| +68 | 4 × f64 | rect: left, top, right, bottom = bounding box of the stroke points (unpadded) | |
| +100 | u32 | 0 *(unknown)* | 0 |
| +104 | u8 | 0 *(unknown)* | 0 |
| +105 | — | flexible fields, ascending bit order: | |
| | f32 | `0x1` rotation in degrees (rect is then the unrotated frame) | auto-shapes only |
| | map | `0x20` custom data: `u8 2, u16 count, count × (u16 len incl. NUL, key bytes, u32 value)`, e.g. `extra_key_stroke_shape = 1` | auto-shapes only |
| | u64 | `0x2000` pen-up time (µs) | all strokes |
| | 2 × u32 | `0x4000` page width, page height | 720, 1018 |
| | u8 | `0x8000` *(unknown)* | — |

rect vs. the decoded points: the largest difference in the samples is 0.016 (≤ 1/64, the delta rounding of
§3.6). The only exception is a rotated auto-shape (`rotation = 340.77`), whose rect is in the unrotated frame.

The text objects inside `note.note` use the same base with `flexOffset = 0`, `flexMask = 0`
(105 bytes, rect all zero).

### 3.6 Stroke subrecord (type 1)

| Offset | Type | Field | InkPen2 |
|---|---|---|---|
| +0 | u32 | size | |
| +4 | u16 | type | 1 |
| +6 | u32 | flexOffset (relative to the subrecord) | = 12·n + 42 |
| +10 | varmask | mask1: `0x1` compact geometry, `0x4` tilt + orientation arrays, others *(unknown, constant per pen)* | `02 25 04` → `0x0425` |
| +13 | varmask | flexMask (fields at flexOffset) | `04 8a 25 00 00` → `0x258A` or `0x258E` |
| +18 | u16 | n = point count | |
| +20 | — | geometry | |

**Compact geometry** (mask1 `0x1`, the only form in the samples):

| Field | Encoding |
|---|---|
| x₀, y₀ | f64, f64 (page units) |
| points 1…n−1 | (n−1) × `u16 dx, u16 dy` interleaved, packed deltas, unit 1/32 |
| pressure | f32 p₀, then (n−1) × u16 packed delta ÷ 128 → unit 1/4096 (0…1) |
| timestamps | i32 t₀ (0 in all samples), then (n−1) × u16 Δt in ms |
| tilt | (mask1 `0x4`) f32 + (n−1) × u16 packed delta ÷ 32 → unit 1/1024 rad |
| orientation | (mask1 `0x4`) f32 + (n−1) × u16 packed delta ÷ 32 |
| tail | u16 = 2 (all 83 strokes) |

**Packed delta** (u16): bit 15 = sign, bits 14…0 = magnitude in 1/32 units:
`value = (v & 0x7FFF) / 32 × (v & 0x8000 ? −1 : 1)`. Deltas are cumulative, and each decoded point stays within
1/64 of the original (Samsung rounds against the reconstructed position). Example: `1d 80` = −29/32 = −0.906.

Without mask1 `0x1` the parser reads the raw form: n × (f32 x, f32 y), n × f32 pressure, n × i32 time,
(mask1 `0x4`) n × f32 tilt, n × f32 orientation, u16 tail. It is not used by the samples.

**Flexible block** (at flexOffset, ascending bit order):

| Bit | Type | Field |
|---|---|---|
| `0x2` | u32 | advanced-setting string id → note.note string table |
| `0x4` | u32 | colour ARGB. **Absent = opaque black** |
| `0x8` | f32 | pen size (page units) |
| `0x10` | u8 | *(unknown)* |
| `0x80` | u32 | pen name string id → note.note string table |
| `0x100` | f32 | copy of the pen size |
| `0x200` | u32 | *(unknown)*, 51 on Pencil2 |
| `0x400` | u32 | *(unknown)*, always 1 |
| `0x800` | u32 | *(unknown)* |
| `0x1000` | u32 | *(unknown)* |
| `0x2000` | f32 | pen parameter: InkPen2 0.33, BrushPen 2.6, ObliquePen 1.389, Marker3 2, Pencil2 0.47–2.41 |
| `0x4000` | u16 | *(unknown)*, Pencil2: 1/2 |
| `0x8000` | f32 | *(unknown)* |
| `0x10000` | u16 | *(unknown)* |
| `0x20000` | f32 | *(unknown)* |

### 3.7 Pens observed

| Pen (`com.samsung.android.sdk.pen.pen.preload.*`) | Strokes | mask1 | flexMask | Adv. setting | Sizes | Colours |
|---|---|---|---|---|---|---|
| `InkPen2` | 52 | `0x425` | `0x258A`, `0x258E` | `"9;"` | 1.009, 4.093, 11.866 | default black, `0xFFFCFCFC` |
| `BrushPen` | 4 | `0x425` | `0x258A` | `"10;"` | 7.174, 17.218 | default black |
| `Pencil2` | 24 | `0x425`, `0xC25` | `0x258E`, `0x678E` | `"15;"` | 3.426 | `0xBF252525`, `0x05252525` |
| `ObliquePen` | 1 | `0x425` | `0x258E` | `"4;"` | 6.404 | `0xFF252525` |
| `Marker3` | 2 | `0x465` | `0x248E` | `"5;"` | 7.786 | `0x54000000` |

Hand-drawn InkPen2 statistics: median point spacing 0.63 units, median Δt 2 ms, pressure 0…0.61,
tilt −0.15…1.46 rad, orientation −4.67…0.12 rad, t₀ = 0.

### 3.8 Page tail

`32-byte page digest (§2)` + ASCII `Page for SAMSUNG S-Pen SDK` (26 bytes). The digest starts at `len − 58`.

### 3.9 Annotated example (225150, 20-point InkPen2 stroke at page offset `0x5CF9`)

```
005cf9  01 0000 cb010000                 type 1 · 0 children · size 459
005d00  79000000 0000 69000000           base: size 121 · type 0 · flexOffset 105
005d0a  02 bf01 04 00600000 a00f0000     mask1 0x1BF · flexMask 0x6000 · version 4000
005d16  2400 "4194894c-da2c-11f1-a441-33709395d01c"
005d3c  8048 9c9e a25f 0600              createdTime 1794001910646912
005d44  4 × f64 rect                     230.340, 169.710, 235.738, 177.902
005d64  00000000 00                      reserved
005d69  5fee359ea25f0600 d0020000 fa030000   pen-up 1794001903939167 · 720 · 1018
005d79  32010000 0100 1a010000           stroke: size 306 · type 1 · flexOffset 282
005d83  02 2504 04 8a250000 1400         mask1 0x425 · flexMask 0x258A · n = 20
005d8d  0000 0000 a077 6d40 / …50c3 6540 x₀ 235.738, y₀ 174.104
005d9d  1d80 4e80 …                      dx −0.906, dy −2.438, …
        … pressure, Δt, tilt, orientation arrays … tail 0200
005e93  01000000 a223813f 00000000 a223813f 01000000 c3f5a83e
        adv "9;" · size 1.0089 · pen InkPen2 · copy 1.0089 · 1 · 0.33
005eab  0953 3149 … 0dae 57              object hash
```

## 4. `note.note`

| Offset | Type | Field | Samples |
|---|---|---|---|
| `0x00` | u32 | optionalOffset — absolute offset of the optional block | `0x2ED` (empty title) |
| `0x04` | u8, u32 | 4, headerFlags | `0x8` (page size present) |
| `0x09` | u8, u32 | 4, propertyFlags | `0xC8E80` |
| `0x0E` | u32 | formatVersion | 4000 / 5500 |
| `0x12` | str16 | noteId | `""` |
| `0x14` | u32 | fileRevision | 1 |
| `0x18` | u64 | createdTime | |
| `0x20` | u64 | modifiedTime | |
| `0x28` | u32 | width = widest page | 720 |
| `0x2C` | u32 | height = sum of page heights + verticalPadding | 2052 |
| `0x30` | u32 | horizontalPadding | 0 |
| `0x34` | u32 | verticalPadding | 16 |
| `0x38` | u32 | minFormatVersion | 4000 / 5500 |
| `0x3C` | u32 + bytes | title text object | 291 bytes (empty), 321 (`"Test"`) |
| … | u32 + bytes | body text object | 382 bytes |
| … | u32, u32 | first page width, height (headerFlags `0x8`) | 720, 1018 |
| optionalOffset | — | fields per propertyFlags, ascending bits: | |
| | i32 | `0x80` lastEditedPageIndex | 0 |
| | i32, u64 | `0x200` lastEditedPageImage id, time | −1, 0 |
| | u32 size, u16 count, count × (i32 id, str16) | `0x400` **string table** | `(1,"9;") (0,"…InkPen2")` |
| | i32 | `0x800` bodyTextFontSizeDelta | 0 |
| | u32 size (incl. itself), str16 pen, f32 size, u32 ARGB, rest | `0x8000` current pen | 206 bytes, InkPen2 |
| | i32 | `0x40000` fixedTextDirection | 2 |
| | i32 | `0x80000` fixedBackgroundTheme | 2 |
| len−32 | 32 bytes | SHA-256 of all preceding bytes | |

Every stroke's pen-name id and advanced-setting id must resolve in the string table.
225305, with five pens, has ten entries, ids 9…0.

**Text object** (title/body): subrecords `0` base (105 bytes, §3.5), `6` shape base (66 bytes),
`7` shape text, and `2` (15 bytes).
- **Shape-text header.** Record 7 starts with a 62-byte header whose u32 at +6 (= 62) points to `u32 commonSize` and the TextCommon block.
- **TextCommon.** `u32 len, len × UTF-16, u32 0`. Then either a paragraph span `u32 1, u16 20, u32 6, u32 0, u32 1, u32 0, u32 0` for non-empty text or `u32 0` for empty text. Then margins `f32 0, 7.5, 0, 7.5`, `u8 0, u16 0, u32 0, u32 0`.
- **Record 7 size.** 105 bytes for an empty title, 105 + 2·len + 22 otherwise (135 for `"Test"`).
- **Body.** Record 7 is a constant 196 bytes.

## 5. `pageIdInfo.dat`

`32-byte note.note hash`, `u16 pageCount`, then per page `str16 pageId, 32-byte page digest`.
Page order is note order.

## 6. `media/mediaInfo.dat` and `.spi`

`u32 version (5500)`, `u16 count`, then per entry `u32 size, u32 bindId, str16 name,
64 × ASCII SHA-256 hex of the file, u16 refCount, u64 time, u8 attached, remaining bytes`, then
ASCII `EOFX`. With no media it is 10 bytes: `7c150000 0000 454f4658`.

The `.spi` files are the page **canvas cache**: a rendered bitmap of the strokes, referenced from the
page property `0x400`, with an entropy-coded payload that was not decoded. The strokes alone fully define
the drawing. The samples' blank pages carry no cache. The converter omits it on its drawing page as well and relies on Samsung Notes re-rendering the strokes, which is a device-test item.

## 7. `end_tag.bin`

`u16 payloadSize (146)`, then, with empty strings at these offsets:

| Offset | Type | Field | Samples |
|---|---|---|---|
| `0x02` | i32 | formatVersion | 4000 / 5500 |
| `0x06` | str16 | noteId | `""` |
| `0x08` | u64 | modifiedTime (= note.note) | |
| `0x10` | i32 | propertyFlags | 0 |
| `0x14` | str16 | coverImage | `""` |
| `0x16` | i32 | width | 720 |
| `0x1A` | f32 | height | 2052.0 |
| `0x1E` | str16 | title | `""` |
| `0x20` | i32, i32 | thumbnail width, height | −1, −1 |
| `0x28` | str16 | appPatchName | `""` |
| `0x2A` | i32 | minFormatVersion | 4000 / 5500 |
| `0x2E` | u64 | createdTime (= note.note) | |
| `0x36` | i32 | lastViewedPageIndex | 0 |
| `0x3A` | u16, u16 | pageMode, documentType | 0, 0 |
| `0x3E` | str16 | ownerId | `""` |
| `0x40` | i32, i32 | reserved | 0, 0 |
| `0x48` | u64 | displayCreatedTime (µs here, ms in the copy after the ZIP) | |
| `0x50` | u64 | displayModifiedTime (same) | |
| `0x58` | u64 | lastRecognizedDataModifiedTime | 0 |
| `0x60` | str16 | fixedFont | `""` |
| `0x62` | i32, i32 | fixedTextDirection, fixedBackgroundTheme | 2, 2 |
| `0x6A` | i64 | serverCheckpoint | −1 |
| `0x72` | i32, i32 | newOrientation, minUnknownVersion | 0, 0 |
| `0x7A` | str32 | appCustomData | `""` |
| `0x7E` | ASCII | `Document for S-Pen SDK` | |

## 8. Rendering facts used by the converter

- **drawnRect.** drawnRect = union over InkPen2 strokes of `rect ± (penSize/2 + 4)`. Of the sample sides it decides, all are matched exactly (±1e-3): 4/4 on 225150, plus every side dominated by an unrotated InkPen2 stroke on the other two. BrushPen pads `penSize + 4`. `tests/run_tests.js` re-checks this on every run.
- **Width calibration.** The pad shows the widest possible InkPen2 line is `penSize` (half-width `penSize/2`), independent of the pressures actually drawn.
- **Pressure.** The converter treats InkPen2 width as `penSize × pressure` and holds pressure at 1.0 on even-width lines, so only tapered lines depend on the mapping. *Inferred, not verified.* The samples carry pressure but no rendered widths, so the mapping must be checked on the device.

## 9. What `samsung_notes_converter.html` writes

- **ZIP.** Entries in sample order without `.spi` files: `pageIdInfo.dat`, the drawing page, a blank page (as Samsung writes it), `media/mediaInfo.dat` (0 entries), `note.note`, `end_tag.bin`, then the trailing end-tag copy (display times in ms). Entries are stored, not deflated.
- **Pages.** mask `0x71` (drawnRect, bgImageMode 2, bgColor, bgWidth; no canvas cache), 720 × 1018 (1018 × 720 for landscape images), one layer, header bytes as in §3.1/§3.3.
- **Strokes.** One `InkPen2` object per traced line:
  - base `0x1BF`/`0x6000`, rect = bbox of the decoded points;
  - mask1 `0x425`, flexMask `0x258E` with advanced setting `"9;"`, colour ARGB from the source pixels, pen size = measured line width, size copy, 1, 0.33;
  - pressure 1.0, or `width / penSize` on tapered lines;
  - tilt 0.506 and orientation −1.571 (typical sample values);
  - Δt from point spacing at 0.5 units/ms, points at most 2 units apart, tail 2.
- **note.note.** The sample layout with the user's title, page size field, string table `(1,"9;") (0,"…InkPen2")`, InkPen2 current-pen block and SHA-256.
- **Hashes.** All hashes and ids are recomputed as in §2.
