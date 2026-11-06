# drawconvert

Turn line art into real, editable **Samsung Notes** pen strokes.

Drop in a PNG and download a `.sdocx` note. In Samsung Notes every line is a normal pen stroke: select it, move it, remove it with the stroke eraser, and draw over it, the same as importing line art in Ibis Paint X. Nothing is embedded as an image, and nothing is uploaded: the converter is a single HTML file that runs in your browser.

![The converter with a coloured sketch loaded and its stroke preview](docs/screenshot.png)

## Use it

1. Open `samsung_notes_converter.html` in Chrome or Edge, on a computer or on the phone. No install, works offline.
2. Drop a PNG on it, or click to pick one. A transparent background works best; drawings on plain white paper work too.
3. Check the **stroke preview**. It is what Samsung Notes will show.
   - **Detail**: left smooths the lines, right follows every wiggle.
   - **Page margin**, **page background** and **note name** work as you'd expect.
4. Click **Convert to .sdocx**, copy the file to the phone and open it in Samsung Notes (My Files, tap the file).

Images with a long side over 2048 px are scaled down before tracing.

## How it works

1. **Ink:** alpha for transparent images, distance from the paper colour for opaque ones.
2. **Centre lines:** distance transform, then thinning to one-pixel skeletons.
3. **One line = one stroke:** the skeleton becomes a graph, and at every crossing the straightest branches of the same colour are joined. A drawn line stays one stroke through the lines it crosses.
4. **Width and colour:** measured across the line. Even lines get one pen size; tapered lines keep their taper through pen pressure. The colour is the median of the line's own pixels, and semi-transparent ink keeps its alpha.
5. **Strokes:** smoothed, simplified (Ramer-Douglas-Peucker) and written as Samsung Notes *Pen* (InkPen2) strokes, with the checksums the app expects.

The `.sdocx` stroke format was reverse-engineered from real notes. [FORMAT.md](FORMAT.md) has the layout with byte offsets.

## Tests

You need Node.js 22 or newer. The browser test also needs Chrome or Chromium, and regenerating the fixtures needs Python 3 with pycairo.

```sh
node tests/run_tests.js            # full check: samples, fixtures, round trip, rendered comparison
node tests/browser_smoke.js        # drives the page in headless Chrome (CHROME=/path/to/chrome)
node tests/sdocx_parser.js *.sdocx # decodes any .sdocx and verifies its hash chain
python3 tests/make_fixtures.py     # redraws tests/fixtures/*.png
```

`run_tests.js` checks that:

- the parser decodes the three sample notes (`Notes_*.sdocx`, `Test_*.sdocx`), checksums included;
- every fixture converts to a `.sdocx` whose structure matches the real notes, with no image layer;
- every stroke round-trips (points, bounding box, colour, size, pressure);
- the strokes, rendered back, match the source PNG (IoU above 0.85);
- no stroke crosses bare paper;
- each drawn line becomes one stroke.

Converted notes, renders and diff images are written to `tests/out/`.

## Limits

- It is for line art: filled areas and shading come out as centre lines, not fills.
- A line gone over twice, with paper showing between the passes, can come out as several short strokes.
- Tracing runs on the page's main thread, so a 2048 px image pauses it for about a second.
- The pressure-to-width mapping for tapered lines was calibrated from sample notes. Report a mismatch if tapers look off.

## Credits and license

MIT, see [LICENSE](LICENSE). The note and page container code is adapted from [Dietrich](https://github.com/Downhillghost/Dietrich) (MIT, © 2026 Dietrich contributors).

Not affiliated with Samsung. Samsung Notes is a trademark of Samsung Electronics.
