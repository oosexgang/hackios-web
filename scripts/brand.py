#!/usr/bin/env python3
"""The site's pictures in HakiOS's brand: the icons, the share image, the press kit. The same emblem and wordmark as the UEFI's
boot logo (hakios-uefi: branding/banner.py), drawn here at any size, smoothed, as PNG, with nothing to install.

usage: python3 scripts/brand.py          (from the repository's top; writes public/ and app/[locale]/)
"""
import os
import struct
import zlib

INK, RED, PAPER, MUTED = (10, 9, 9), (0xE8, 0x17, 0x0F), (0xEF, 0xE9, 0xE6), (0x8C, 0x81, 0x7E)
FONT = {
    "A": [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    "D": ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
    "E": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
    "H": ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    "I": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "#####"],
    "K": ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
    "L": ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
    "N": ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
    "O": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "P": ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
    "R": ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
    "S": [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
    "W": ["#   #", "#   #", "#   #", "# # #", "# # #", "## ##", "#   #"],
    "X": ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
    "U": ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "G": [" ####", "#    ", "#    ", "#  ##", "#   #", "#   #", " ### "],
    "M": ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
    "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
    " ": ["     "] * 7,
}
SS = 4                                      # drawn this many times larger, then averaged: smooth edges


class Canvas:
    def __init__(self, w, h, bg=INK):
        self.w, self.h = w * SS, h * SS
        self.px = [bg] * (self.w * self.h)

    def dot(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y * self.w + x] = c

    def rect(self, x0, y0, w, h, c):
        for y in range(int(y0), int(y0 + h)):
            for x in range(int(x0), int(x0 + w)):
                self.dot(x, y, c)

    def disc(self, cx, cy, r, c):
        for y in range(int(cy - r), int(cy + r) + 2):
            for x in range(int(cx - r), int(cx + r) + 2):
                if (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r:
                    self.dot(x, y, c)

    def line(self, x0, y0, x1, y1, width, c):
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) / 2) + 1
        for i in range(steps + 1):
            t = i / steps
            self.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, c)

    def emblem(self, cx, top, u):
        """The emblem, in the logo's own units (40x40 in the site's SVG), U output pixels to one."""
        cx, top, u = cx * SS, top * SS, u * SS
        for side in (-1, 1):
            self.line(cx + side * 9.5 * u, top + 9 * u, cx + side * 13 * u, top, 2.2 * u, RED)
            self.disc(cx + side * 13 * u, top, 2.4 * u, RED)
        self.disc(cx, top + 18.5 * u, 13 * u, RED)
        for x0 in (cx - 6.5 * u, cx + 1.5 * u):
            r = 2.5 * u
            self.rect(x0, top + 14.5 * u + r, 5 * u, 7 * u - 2 * r, INK)
            self.disc(x0 + r, top + 14.5 * u + r, r, INK)
            self.disc(x0 + r, top + 21.5 * u - r, r, INK)

    def text(self, s, cx, y, scale, colours):
        scale *= SS
        width = len(s) * 6 * scale - scale
        x = cx * SS - width / 2
        for i, ch in enumerate(s):
            c = colours[i] if isinstance(colours, list) else colours
            for row, bits in enumerate(FONT[ch]):
                for col, bit in enumerate(bits):
                    if bit == "#":
                        self.rect(x + col * scale, y * SS + row * scale, scale, scale, c)
            x += 6 * scale

    def png(self, path):
        w, h = self.w // SS, self.h // SS
        raw = bytearray()
        for y in range(h):
            raw.append(0)
            for x in range(w):
                acc = [0, 0, 0]
                for dy in range(SS):
                    base = (y * SS + dy) * self.w + x * SS
                    for dx in range(SS):
                        p = self.px[base + dx]
                        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]
                raw += bytes(v // (SS * SS) for v in acc)
        chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(data)
        print("brand: %s (%dx%d)" % (path, w, h))


WORD = [PAPER, PAPER, PAPER, PAPER, RED, RED]       # HAKI in paper, OS in red


def icon(size, path):
    c = Canvas(size, size)
    c.emblem(size / 2, size * 0.16, size / 40 * 0.92)
    c.png(path)


def share(path):
    c = Canvas(1200, 630)
    c.emblem(600, 70, 6.2)
    c.text("HAKIOS", 600, 330, 16, WORD)
    c.text("DARWIN ON ANDROID PHONES", 600, 500, 5, MUTED)
    c.png(path)


def main():
    for size, path in ((192, "public/icon-192.png"), (512, "public/icon-512.png"), (512, "app/[locale]/icon.png"),
                       (180, "app/[locale]/apple-icon.png"), (1024, "public/press/hakios-emblem.png")):
        icon(size, path)
    share("app/[locale]/opengraph-image.png")
    share("app/[locale]/twitter-image.png")
    share("public/press/hakios-share.png")
    word = Canvas(1500, 500)
    word.emblem(250, 95, 7)
    word.text("HAKIOS", 900, 190, 20, WORD)
    word.png("public/press/hakios-header.png")


if __name__ == "__main__":
    main()
