#!/usr/bin/env python3
"""The PNG icons of the site's mark: a lowercase h and a red dot on a dark rounded square (components/Logo.tsx draws the same
in SVG, public/press/hakios-mark.svg is it as a file). Drawn here from the shapes, smoothed, with nothing to install; the favicon,
the Apple icon and the share image are SVG or made by Next itself (app/[locale]/icon.svg, apple-icon.tsx, opengraph-image.tsx).

usage: python3 scripts/brand.py          (from the repository's top; writes public/)
"""
import os
import struct
import zlib

INK, RED, WHITE = (0x16, 0x13, 0x12), (0xE8, 0x17, 0x0F), (255, 255, 255)
SS = 4


def mark(size):
    """[(r, g, b)] of the mark at SIZE x SIZE, drawn SS times larger and averaged."""
    n = size * SS
    u = n / 64                                       # the SVG's units
    px = [None] * (n * n)                            # None: transparent (outside the square)

    def inside_square(x, y):
        r = 16 * u
        cx = min(max(x, r), n - r)
        cy = min(max(y, r), n - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    for y in range(n):
        for x in range(n):
            if inside_square(x + .5, y + .5):
                px[y * n + x] = INK

    def disc(cx, cy, r, c):
        for y in range(int(cy - r) - 1, int(cy + r) + 2):
            for x in range(int(cx - r) - 1, int(cx + r) + 2):
                if 0 <= x < n and 0 <= y < n and (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r:
                    px[y * n + x] = c

    def stroke(points, width, c):
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            steps = int(max(abs(x1 - x0), abs(y1 - y0)) * u / 1.5) + 1
            for i in range(steps + 1):
                t = i / steps
                disc((x0 + (x1 - x0) * t) * u, (y0 + (y1 - y0) * t) * u, width * u / 2, c)

    def cubic(p0, p1, p2, p3, k=40):
        return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                      for a, b, c, d in zip(p0, p1, p2, p3)) for t in (i / k for i in range(k + 1))]

    stroke([(22, 14), (22, 50)], 7, WHITE)                                       # the stem
    arch = cubic((22, 33), (22, 27), (26.5, 23.5), (31.5, 23.5)) + cubic((31.5, 23.5), (36.5, 23.5), (41, 27), (41, 33))
    stroke(arch + [(41, 50)], 7, WHITE)                                          # the arch and the leg
    disc(45.5 * u, 16.5 * u, 4.5 * u, RED)                                       # the dot

    out = []
    for y in range(size):
        for x in range(size):
            acc, alpha = [0, 0, 0], 0
            for dy in range(SS):
                for dx in range(SS):
                    p = px[(y * SS + dy) * n + x * SS + dx]
                    if p is not None:
                        alpha += 1
                        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]
            out.append(tuple(v // alpha for v in acc) + (alpha * 255 // (SS * SS),) if alpha else (0, 0, 0, 0))
    return out


def png(path, size, pixels):
    raw = b"".join(b"\0" + b"".join(bytes(p) for p in pixels[y * size:(y + 1) * size]) for y in range(size))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data)
    print("brand: %s (%dx%d)" % (path, size, size))


if __name__ == "__main__":
    for size, path in ((192, "public/icon-192.png"), (512, "public/icon-512.png"), (1024, "public/press/hakios-mark.png")):
        png(path, size, mark(size))
