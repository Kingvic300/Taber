"""Generate Tabora PNG icons with only the standard library."""
import struct, zlib, os

BG = (67, 56, 202)       # indigo
FG = (255, 255, 255)
FG2 = (199, 196, 255)

def rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def color_at(u, v):
    # u, v in 0..1
    if not rrect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22):
        return None
    # three stacked tab bars, back ones lighter, joined into one stack
    if rrect(u, v, 0.30, 0.18, 0.84, 0.40, 0.06):
        return FG2
    if rrect(u, v, 0.23, 0.34, 0.77, 0.58, 0.06):
        return FG2
    if rrect(u, v, 0.16, 0.50, 0.70, 0.82, 0.07):
        return FG
    return BG

def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            if a:
                cov = acc[3] / 255
                row += bytes([round(acc[0] / cov), round(acc[1] / cov), round(acc[2] / cov), round(a)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f'icon-{s}.png'), 'wb') as f:
        f.write(render(s))
print('icons written')
