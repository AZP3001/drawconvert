#!/usr/bin/env python3
"""Draws the test PNGs in tests/fixtures/ with Cairo, a rasterizer independent of the converter.

simple_lines.png  transparent, black 2.5-6 px pen lines: straight, crossing (X), T-junction, circle, curves
thick_brush.png   opaque white paper, dark 10-36 px brush strokes with tapered ends and pressure swells
color_sketch.png  transparent, coloured and semi-transparent (alpha 0.6-1) pen sketch with crossings
sketchy.png       transparent mesh of curves each gone over twice: thin paper slivers between the passes
                  put many junctions close together (the case that once merged a whole drawing into one point)
"""
import math
import os

import cairo

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def canvas(width, height, paper=None):
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, width, height)
    ctx = cairo.Context(surface)
    if paper:
        ctx.set_source_rgb(*paper)
        ctx.paint()
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    return surface, ctx


def pen(ctx, points, width, rgba, closed=False):
    ctx.set_source_rgba(*rgba)
    ctx.set_line_width(width)
    ctx.move_to(*points[0])
    for p in points[1:]:
        ctx.line_to(*p)
    if closed:
        ctx.close_path()
    ctx.stroke()


def bezier(p0, p1, p2, p3, n=240):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def circle(cx, cy, r, n=360, start=0.0, turns=1.0):
    return [(cx + r * math.cos(start + 2 * math.pi * turns * i / n), cy + r * math.sin(start + 2 * math.pi * turns * i / n)) for i in range(n + 1)]


def brush(ctx, points, radius, rgba):
    """Variable-width stroke: union of discs every 0.4 px, filled once so edges are antialiased exactly once."""
    lengths = [0.0]
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        lengths.append(lengths[-1] + math.hypot(bx - ax, by - ay))
    total = lengths[-1]
    ctx.set_source_rgba(*rgba)
    ctx.set_fill_rule(cairo.FILL_RULE_WINDING)
    seg, s = 0, 0.0
    while s <= total:
        while seg < len(points) - 2 and lengths[seg + 1] < s:
            seg += 1
        span = lengths[seg + 1] - lengths[seg] or 1.0
        t = (s - lengths[seg]) / span
        x = points[seg][0] + (points[seg + 1][0] - points[seg][0]) * t
        y = points[seg][1] + (points[seg + 1][1] - points[seg][1]) * t
        ctx.new_sub_path()
        ctx.arc(x, y, max(0.3, radius(s / total)), 0, 2 * math.pi)
        s += 0.4
    ctx.fill()


def taper(peak, floor=0.12):
    return lambda u: peak * max(floor, math.sin(math.pi * u) ** 0.7)


def simple_lines():
    surface, ctx = canvas(900, 1200)
    black = (0, 0, 0, 1)
    pen(ctx, [(100, 100), (800, 100)], 4, black)
    pen(ctx, [(100, 190), (400, 470)], 3, black)
    pen(ctx, [(500, 190), (800, 470)], 4, black)                       # X crossing
    pen(ctx, [(800, 190), (500, 470)], 4, black)
    pen(ctx, [(100, 570), (400, 570)], 5, black)                       # T junction
    pen(ctx, [(250, 570), (250, 820)], 5, black)
    pen(ctx, circle(650, 690, 130), 4, black, closed=True)
    pen(ctx, bezier((100, 900), (330, 780), (170, 1150), (420, 1100)), 4, black)
    pen(ctx, [(500 + i, 960 + 45 * math.sin(i / 40)) for i in range(0, 321, 2)], 3, black)
    pen(ctx, [(500, 1080), (820, 1120)], 2.5, black)
    pen(ctx, [(480, 1160), (820, 1160)], 6, black)
    return surface


def thick_brush():
    surface, ctx = canvas(1000, 1000, paper=(1, 1, 1))
    ink = (0.09, 0.09, 0.11, 1)
    brush(ctx, bezier((110, 230), (380, 30), (620, 430), (890, 170)), taper(18), ink)
    brush(ctx, [(150, 430), (480, 860)], taper(13), ink)               # brush X
    brush(ctx, [(480, 430), (150, 860)], taper(13), ink)
    brush(ctx, [(590, 470), (900, 470)], lambda u: 12, ink)           # uniform 24 px
    brush(ctx, circle(760, 760, 125, start=-math.pi / 2), lambda u: 7 + 6 * math.sin(math.pi * u), ink)
    brush(ctx, bezier((80, 920), (120, 900), (170, 930), (210, 975)), taper(9), ink)
    return surface


def color_sketch():
    surface, ctx = canvas(1200, 900)
    red, orange, blue = (0.90, 0.22, 0.21, 1), (0.98, 0.55, 0.0, 1), (0.12, 0.53, 0.90, 0.8)
    green, brown, purple = (0.26, 0.63, 0.28, 0.6), (0.43, 0.30, 0.16, 1), (0.56, 0.14, 0.67, 0.7)
    pen(ctx, [(200, 420), (500, 420), (500, 760), (200, 760)], 5, red, closed=True)   # house
    pen(ctx, [(165, 480), (350, 295), (535, 480)], 6, orange)                          # roof crosses both walls
    pen(ctx, [(310, 760), (310, 600), (390, 600), (390, 760)], 4, blue)                # door
    pen(ctx, circle(960, 190, 80), 6, orange, closed=True)                             # sun
    for k in range(8):
        a = k * math.pi / 4 + 0.2
        pen(ctx, [(960 + 105 * math.cos(a), 190 + 105 * math.sin(a)), (960 + 150 * math.cos(a), 190 + 150 * math.sin(a))], 4, orange)
    pen(ctx, [(850, 500), (850, 800)], 8, brown)                                      # tree trunk through the crown
    pen(ctx, circle(850, 440, 95), 5, green, closed=True)
    pen(ctx, [(40 + 10 * i, 845 - 22 * abs(math.sin(i * 0.9))) for i in range(112)], 3, (0.26, 0.63, 0.28, 1))
    pen(ctx, [(600 + (12 + 26 * t) * math.cos(t * 2.1), 200 + (12 + 26 * t) * math.sin(t * 2.1)) for t in [i / 40 for i in range(0, 130)]], 3, purple)
    return surface


def offset(points, amount):
    """Shift a polyline sideways by amount(u) px, u = 0..1 along it."""
    out = []
    for i, (x, y) in enumerate(points):
        (ax, ay), (bx, by) = points[max(0, i - 1)], points[min(len(points) - 1, i + 1)]
        n = math.hypot(bx - ax, by - ay) or 1.0
        d = amount(i / (len(points) - 1))
        out.append((x - (by - ay) / n * d, y + (bx - ax) / n * d))
    return out


def sketchy():
    surface, ctx = canvas(1000, 1000)
    ink = (0, 0, 0, 1)
    curves = [bezier((60, 120 + 190 * k), (330, 40 + 190 * k), (640, 260 + 190 * k), (940, 150 + 190 * k)) for k in range(5)]
    curves += [bezier((110 + 200 * k, 60), (40 + 200 * k, 360), (220 + 200 * k, 640), (120 + 200 * k, 940)) for k in range(5)]
    for pts in curves:
        brush(ctx, pts, taper(4, 0.3), ink)
        # second pass drifts up to 8 px off the first and back, 3.5 times along the curve
        brush(ctx, offset(pts, lambda u: 4 + 4 * math.sin(7 * math.pi * u)), taper(3.4, 0.3), ink)
    return surface


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, build in [("simple_lines", simple_lines), ("thick_brush", thick_brush), ("color_sketch", color_sketch), ("sketchy", sketchy)]:
        path = os.path.join(OUT, name + ".png")
        build().write_to_png(path)
        print("wrote", path)


if __name__ == "__main__":
    main()
