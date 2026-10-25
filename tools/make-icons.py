"""Gera os ícones da extensão (PNG) sem dependências: quadrado arredondado em degradê com seta de download."""
import math
import struct
import sys
import zlib
from pathlib import Path

C1 = (76, 110, 245)   # #4c6ef5
C2 = (112, 72, 232)   # #7048e8


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def inside_rounded(x, y, size, r):
    # x, y em [0, size]
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    return math.hypot(x - cx, y - cy) <= r


def render(size, ss=4):
    rows = []
    r = size * 0.24
    w = max(1.0, size * 0.085)  # espessura do traço
    # Desenho em coordenadas de 0..1
    strokes = [
        ((0.5, 0.22), (0.5, 0.60)),   # haste
        ((0.32, 0.44), (0.5, 0.62)),  # ponta esquerda
        ((0.68, 0.44), (0.5, 0.62)),  # ponta direita
        ((0.27, 0.78), (0.73, 0.78)),  # bandeja
    ]
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            bg = 0
            fg = 0
            for sj in range(ss):
                for si in range(ss):
                    x = i + (si + 0.5) / ss
                    y = j + (sj + 0.5) / ss
                    if inside_rounded(x, y, size, r):
                        bg += 1
                        u, v = x / size, y / size
                        d = min(seg_dist(u, v, a[0], a[1], b[0], b[1]) for a, b in strokes) * size
                        if d <= w / 2:
                            fg += 1
            n = ss * ss
            a = bg / n
            f = fg / max(1, bg)
            t = (i + j) / (2 * size)
            base = [C1[k] + (C2[k] - C1[k]) * t for k in range(3)]
            col = [int(round(base[k] * (1 - f) + 255 * f)) for k in range(3)]
            row += bytes(col + [int(round(a * 255))])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(sys.argv[1])
    for s in (16, 32, 48, 128):
        (out / f"icon-{s}.png").write_bytes(render(s))
        print("ok", s)
