#!/usr/bin/env python3
# Copyright 2026 Martin Bogomolni
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Give a face its own Cyrillic and accented Latin, derived from the letters it
already has.

    ./fonts/derive.py sans cartoon future

Drawing the alphabet by hand once per face is 46 glyphs a time and three
chances to get a stem weight wrong. Most of it does not need drawing at all:

  - A dozen letters are their Latin lookalike outright (А В Е К М Н О Р С Т У Х).
  - Several are a Latin letter reflected: И is a mirrored N, Я a mirrored R,
    Э a mirrored C with a bar.
  - The rest are stems and bars, which can be built from the face's own
    measurements.

Deriving them means a face's Cyrillic inherits its weight, width and cap height
automatically, and a later change to the Latin carries across rather than
leaving the two halves of the alphabet subtly mismatched.

The accented Latin works the same way and matters more in practice: without it
a French or Czech user typing in Sans gets serif accents in the middle of their
word. Every one of the 72 accented letters in the stock face is a base letter
plus a mark, so all of them compose.

Metrics are read off the face rather than configured: 'H' gives the cap band,
the full ink width and the stem width, and 'o' gives the x-height band. Run it
again after editing a face and the derived glyphs follow.
"""
import unicodedata
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROWS = 11

# Cyrillic letters that are simply their Latin lookalike in any of these faces.
SAME = {
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O",
    "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
}

# Letters that are a reflection of a Latin one. Cyrillic И really is a mirrored
# N and Я a mirrored R, so these are not approximations.
MIRROR = {"И": "N", "Й": "N", "Я": "R", "и": "n", "й": "n", "я": "r"}


# --- .face I/O -------------------------------------------------------------

MARKER = "; --- Cyrillic and accented Latin (fonts/derive.py) ---"


def hand_written(path):
    """The file with any previously generated section removed.

    Parsing the whole file would make a rerun see its own output as glyphs the
    face already had, skip regenerating them, and then drop them when it
    rewrote the section. The generated part has to be invisible to the
    generator.
    """
    text = path.read_text()
    for m in (MARKER, "; --- Cyrillic"):
        if m in text:
            return text[: text.index(m)].rstrip("\n")
    return text.rstrip("\n")


def read_face(text):
    """(header text, {char: [row strings]}) preserving the file's own order."""
    head, art, order, cur = [], {}, [], None
    for line in text.splitlines():
        if line.startswith(":"):
            tok = line[1:].split()[0]
            cur = chr(int(tok[2:], 16)) if tok.startswith("U+") else tok
            art[cur] = []
            order.append(cur)
        elif cur is None:
            head.append(line)
        elif not line.strip():
            continue
        elif not set(line) - set(".#"):
            art[cur].append(line)
    return "\n".join(head), art, order


def grid(art_rows):
    """Row strings to a mutable bool grid, dropping the bearing column."""
    w = len(art_rows[0]) - 1
    return [[c == "#" for c in r[:w]] for r in art_rows], w


def render(g, bearing=1):
    return ["".join("#" if c else "." for c in row) + "." * bearing for row in g]


def blank(w):
    return [[False] * w for _ in range(ROWS)]


# --- measuring the face ----------------------------------------------------

class Metrics:
    """What a face's own 'H' and 'o' say about how to draw in it."""

    def __init__(self, art):
        for c in ("H", "o", "C", "N", "R", "B", "L", "X", "O", "3"):
            if c not in art:
                raise SystemExit(f"face has no {c!r}; cannot derive Cyrillic")
        h, self.w = grid(art["H"])
        rows = [y for y in range(ROWS) if any(h[y])]
        self.cap_top, self.cap_bot = rows[0], rows[-1]
        # Stem width is the run of lit pixels at the left of a cap stem.
        row = h[self.cap_top]
        self.stem = 0
        while self.stem < self.w and row[self.stem]:
            self.stem += 1
        self.stem = max(1, self.stem)
        o, _ = grid(art["o"])
        rows = [y for y in range(ROWS) if any(o[y])]
        self.xh_top, self.xh_bot = rows[0], rows[-1]

    def band(self, upper):
        return (self.cap_top, self.cap_bot) if upper else (self.xh_top, self.xh_bot)


# --- drawing primitives ----------------------------------------------------

def vstem(g, x0, y0, y1, w):
    for y in range(y0, y1 + 1):
        for x in range(x0, min(x0 + w, len(g[0]))):
            g[y][x] = True


def hbar(g, y0, x0, x1, h):
    for y in range(y0, min(y0 + h, ROWS)):
        for x in range(x0, x1 + 1):
            g[y][x] = True


def bowl(g, y0, y1, x0, x1, s):
    """A closed shape: two side stems capped top and bottom."""
    hbar(g, y0, x0, x1, s)
    hbar(g, y1 - s + 1, x0, x1, s)
    vstem(g, x0, y0, y1, s)
    vstem(g, x1 - s + 1, y0, y1, s)


def diag(g, x0, y0, x1, y1, s):
    """A straight arm. Stepped rather than anti-aliased, which is all a 1-bit
    grid can carry anyway."""
    steps = max(abs(x1 - x0), abs(y1 - y0))
    if steps == 0:
        vstem(g, x0, y0, y0, s)
        return
    for i in range(steps + 1):
        x = round(x0 + (x1 - x0) * i / steps)
        y = round(y0 + (y1 - y0) * i / steps)
        vstem(g, max(0, min(len(g[0]) - s, x)), y, y, s)


def mirror(g):
    return [list(reversed(row)) for row in g]


def flip_band(g, y0, y1):
    out = [row[:] for row in g]
    for i, y in enumerate(range(y0, y1 + 1)):
        out[y] = g[y1 - i][:]
    return out


def overlay(a, b):
    return [[p or q for p, q in zip(ra, rb)] for ra, rb in zip(a, b)]


def clear(g, y0, y1, x0, x1):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            g[y][x] = False


# --- the letters -----------------------------------------------------------

def letter_width(ch, M):
    """How wide this letter needs to be in this face.

    Three two-pixel stems and the gaps between them do not fit in a seven-pixel
    body: Ш comes out a solid block. Cyrillic sets these letters wider than the
    rest anyway, and a proportional face can simply give them the room. On a
    one-pixel face the arithmetic already fits and nothing changes.
    """
    s, w = M.stem, M.w
    if ch in "ШЩЫЮЖ":
        return max(w, 3 * s + 2)      # three stems, two gaps
    if ch == "Ф":
        # Two walls, two gaps and the stem that runs through the middle of the
        # loop. Any narrower and the stem closes the bowl it is supposed to
        # pass through.
        return max(w, 3 * s + 2)
    return w


def build(ch, M, art, upper):
    """Draw one Cyrillic letter, or None if it is handled by copy/mirror."""
    y0, y1 = M.band(upper)
    s = M.stem
    w = letter_width(ch, M)
    right = w - s          # x of the right-hand stem
    mid = (w - s) // 2     # x of a centred stem
    half = (y0 + y1) // 2  # where a middle bar or a bowl starts
    g = blank(w)

    def latin(name):
        base, bw = grid(art[name])
        rows = [row[:] for row in base]
        # Pad a borrowed Latin glyph out to this letter's width, so Ж can be
        # wider than the X it is built on. Centred, or the stem added on top of
        # it would not line up with the middle of the shape.
        if bw < w:
            left = (w - bw) // 2
            rows = [[False] * left + row + [False] * (w - bw - left) for row in rows]
        return rows

    if ch == "Н":
        vstem(g, 0, y0, y1, s)
        vstem(g, right, y0, y1, s)
        hbar(g, half, 0, w - 1, s)
    elif ch == "Т":
        hbar(g, y0, 0, w - 1, s)
        vstem(g, mid, y0, y1, s)
    elif ch == "В":
        vstem(g, 0, y0, y1, s)
        bowl(g, y0, half, 0, w - 1, s)
        bowl(g, half - s + 1, y1, 0, w - 1, s)
    elif ch == "К":
        vstem(g, 0, y0, y1, s)
        diag(g, right, y0, s, half, s)
        diag(g, s, half, right, y1, s)
    elif ch == "М":
        vstem(g, 0, y0, y1, s)
        vstem(g, right, y0, y1, s)
        diag(g, 0, y0, mid, half, s)
        diag(g, right, y0, mid, half, s)
    elif ch == "Г":
        vstem(g, 0, y0, y1, s)
        hbar(g, y0, 0, w - 1, s)
    elif ch == "П":
        vstem(g, 0, y0, y1, s)
        vstem(g, right, y0, y1, s)
        hbar(g, y0, 0, w - 1, s)
    elif ch == "Ц":
        vstem(g, 0, y0, y1, s)
        vstem(g, right, y0, y1, s)
        hbar(g, y1 - s + 1, 0, w - 1, s)
        # The tail hangs below the baseline, which is what distinguishes it.
        vstem(g, right, y1 + 1, min(y1 + s, ROWS - 1), s)
    elif ch in ("Ш", "Щ"):
        vstem(g, 0, y0, y1, s)
        vstem(g, mid, y0, y1, s)
        vstem(g, right, y0, y1, s)
        hbar(g, y1 - s + 1, 0, w - 1, s)
        if ch == "Щ":
            vstem(g, right, y1 + 1, min(y1 + s, ROWS - 1), s)
    elif ch == "Ч":
        vstem(g, 0, y0, half, s)
        vstem(g, right, y0, y1, s)
        hbar(g, half - s + 1, 0, w - 1, s)
    elif ch == "Ь":
        vstem(g, 0, y0, y1, s)
        bowl(g, half - s + 1, y1, 0, w - 2, s)
    elif ch == "Ъ":
        vstem(g, 1, y0, y1, s)
        hbar(g, y0, 0, s, s)
        bowl(g, half - s + 1, y1, 1, w - 1, s)
    elif ch == "Ы":
        vstem(g, 0, y0, y1, s)
        bowl(g, half - s + 1, y1, 0, right - s - 1, s)
        vstem(g, right, y0, y1, s)
    elif ch == "Б":
        vstem(g, 0, y0, y1, s)
        hbar(g, y0, 0, w - 1, s)
        bowl(g, half - s + 1, y1, 0, w - 1, s)
    elif ch == "Ю":
        vstem(g, 0, y0, y1, s)
        hbar(g, half, 0, mid, s)
        bowl(g, y0, y1, mid, w - 1, s)
    elif ch == "Ж":
        g = latin("X")
        vstem(g, mid, y0, y1, s)
    elif ch == "Ф":
        bowl(g, y0 + 1, y1 - 1, 0, w - 1, s)
        vstem(g, mid, y0, y1, s)
    elif ch == "З":
        g = latin("3")
    elif ch == "Э":
        g = mirror(latin("C"))
        hbar(g, half, mid, w - s - 1, s)
    elif ch == "Д":
        # A trapezoid on legs. The legs are what make it a Д rather than a Л.
        vstem(g, mid - s, y0, y1 - s, s)
        hbar(g, y0, mid - s, w - 1, s)
        vstem(g, right, y0, y1 - s, s)
        for i, y in enumerate(range(y1 - s, y0, -1)):
            x = max(0, mid - s - 1 - i // 2)
            vstem(g, x, y, y, s)
        hbar(g, y1 - s + 1, 0, w - 1, s)
        vstem(g, 0, y1 + 1, min(y1 + s, ROWS - 1), s)
        vstem(g, right, y1 + 1, min(y1 + s, ROWS - 1), s)
    elif ch == "Л":
        vstem(g, mid - s, y0, y1, s)
        hbar(g, y0, mid - s, w - 1, s)
        vstem(g, right, y0, y1, s)
        for i, y in enumerate(range(y1, y0, -1)):
            x = max(0, mid - s - 1 - i // 2)
            vstem(g, x, y, y, s)
    else:
        return None
    return g


def accent(g, y0, w, s, kind):
    """A breve for Й, a diaeresis for Ё, in whatever room is above the letter."""
    if y0 < 1:
        return g
    g = [row[:] for row in g]
    mid = (w - s) // 2
    if kind == "breve":
        for x in range(max(0, mid - s), min(w, mid + 2 * s)):
            g[y0 - 1][x] = True
    else:
        for x in (max(0, mid - s), min(w - 1, mid + s)):
            g[y0 - 1][x] = True
    return g


# Combining marks, as two rows of (dx, dy) offsets from the mark's own top-left.
# Two rows where there is room for two; the lower row alone otherwise, which is
# all an accented capital gets on an 11-row body.
#
# At this size a grave and an acute cannot lean. They are told apart by which
# side of centre they sit on, which is the usual convention for tiny type.
MARKS = {
    "\u0300": [[(-2, 0), (-1, 0)], [(-1, 1), (0, 1)]],            # grave
    "\u0301": [[(1, 0), (2, 0)], [(0, 1), (1, 1)]],               # acute
    "\u0302": [[(0, 0)], [(-1, 1), (1, 1)]],                      # circumflex
    "\u030C": [[(-1, 0), (1, 0)], [(0, 1)]],                      # caron
    "\u0308": [[(-1, 0), (1, 0)], [(-1, 1), (1, 1)]],             # diaeresis
    "\u0303": [[(-1, 0), (2, 0)], [(-2, 1), (0, 1), (1, 1)]],     # tilde
    # A ring degrades to a heavy dot. Drawn as a hollow one it is a circumflex.
    "\u030A": [[(-1, 0), (0, 0)], [(-1, 1), (0, 1)]],              # ring
    "\u030B": [[(0, 0), (2, 0)], [(-1, 1), (1, 1)]],              # double acute
}
# Drawn below the letter rather than above it.
BELOW = {"\u0327": [[(0, 0)], [(-1, 1)]]}                          # cedilla


def ink_rows(g):
    rows = [y for y in range(ROWS) if any(g[y])]
    return (rows[0], rows[-1]) if rows else (0, ROWS - 1)


def compress(g, n, top, bot):
    """Shorten a letter by `n` rows without changing its shape or its baseline.

    A capital on an 11-row body leaves one row of headroom, and one row cannot
    tell a circumflex from a diaeresis. The way out is the one the stock face
    uses: drop rows that are identical to the row above them. A stem two pixels
    tall instead of three is not something anyone will notice; an accent that
    could be either of two accents is.

    Returns None when the letter has no repeated rows to give up.
    """
    w = len(g[0])
    band = [g[y][:] for y in range(top, bot + 1)]
    i = len(band) - 1
    while n > 0 and i > 0:
        if band[i] == band[i - 1]:
            del band[i]
            n -= 1
        i -= 1
    if n > 0:
        return None
    out = [[False] * w for _ in range(ROWS)]
    start = bot - len(band) + 1
    for k, row in enumerate(band):
        out[start + k] = row
    return out


def add_mark(base, mark):
    """Put a combining mark on a glyph, shifting the letter down if it has to."""
    g = [row[:] for row in base]
    w = len(g[0])
    top, bot = ink_rows(g)
    cx = w // 2

    if mark in BELOW:
        rows = BELOW[mark]
        y = bot + 1
        for dy, row in enumerate(rows):
            for dx, _ in row:
                if y + dy < ROWS and 0 <= cx + dx < w:
                    g[y + dy][cx + dx] = True
        return g

    rows = MARKS[mark]
    if top >= len(rows):
        start = top - len(rows)
    else:
        shorter = compress(g, len(rows) - top, top, bot)
        if shorter is not None:
            g, start = shorter, 0
        elif top >= 1:
            # Nothing to give up. The lower row of the mark alone, rather than
            # dropping the letter: an accented capital sitting a pixel below
            # its neighbours is far more obvious than a grave missing a row.
            rows, start = rows[-1:], top - 1
        else:
            return g

    for dy, row in enumerate(rows):
        for dx, _ in row:
            if 0 <= start + dy < ROWS and 0 <= cx + dx < w:
                g[start + dy][cx + dx] = True
    return g


def derive_accents(art, have):
    """Every precomposed letter whose base this face can already draw."""
    out = {}
    for cp in list(range(0x00C0, 0x0180)):
        ch = chr(cp)
        d = unicodedata.decomposition(ch)
        if not d or d.startswith("<"):
            continue
        parts = d.split()
        if len(parts) != 2:
            continue
        base, mark = chr(int(parts[0], 16)), chr(int(parts[1], 16))
        if mark not in MARKS and mark not in BELOW:
            continue
        # Leave alone anything the face already draws by hand.
        if ch in art:
            continue
        src = have.get(base) or (grid(art[base])[0] if base in art else None)
        if src is None:
            continue
        out[ch] = add_mark(src, mark)
    return out


def derive(art, M):
    out = {}
    for ch, latin in SAME.items():
        if latin in art:
            out[ch] = [r[:] for r in grid(art[latin])[0]]

    for upper, letters in (
        (True, "БГДЖЗЛПФЦЧШЩЪЫЬЭЮ"),
        (False, "бвгджзклмнптфцчшщъыьэюя"),
    ):
        for ch in letters:
            key = ch.upper() if not upper else ch
            g = build(key, M, art, upper)
            if g is None:
                continue
            out[ch] = g

    # Reflections of Latin letters.
    for ch, latin in MIRROR.items():
        if latin in art:
            out[ch] = mirror(grid(art[latin])[0])

    # Accented forms, once their base exists.
    for ch, base, kind in (
        ("Й", "И", "breve"), ("й", "и", "breve"),
        ("Ё", "Е", "diaeresis"), ("ё", "е", "diaeresis"),
    ):
        if base in out:
            upper = ch.isupper()
            y0, _ = M.band(upper)
            out[ch] = accent(out[base], y0, M.w, M.stem, kind)

    return out


def main():
    targets = sys.argv[1:]
    if not targets:
        raise SystemExit(__doc__.strip().splitlines()[2].strip())
    for name in targets:
        path = HERE / f"{name}.face"
        body = hand_written(path)
        head, art, _ = read_face(body)
        M = Metrics(art)
        derived = derive(art, M)

        # 'б' is the one letter with no Latin ancestor and no stem-and-bar
        # description: an ascender with a bowl and a flag off the top.
        if "б" in derived:
            g = blank(M.w)
            y0, y1 = M.band(True)
            half = (y0 + y1) // 2
            s, w = M.stem, M.w
            vstem(g, 0, y0, y1, s)
            hbar(g, y0, 0, w - 1, s)
            bowl(g, half - s + 1, y1, 0, w - 1, s)
            derived["б"] = g

        derived.update(derive_accents(art, derived))

        blocks = []
        for ch in sorted(derived):
            rows = render(derived[ch])
            if len(rows) != ROWS:
                raise SystemExit(f"{name}: {ch!r} produced {len(rows)} rows")
            blocks.append(f":{ch}\n" + "\n".join(rows) + "\n")

        path.write_text(
            body
            + "\n\n" + MARKER + "\n"
            + ";\n; Derived from this face's own Latin, so it carries the same\n"
            "; stem weight and cap height. Rerun after editing the letters above.\n\n"
            + "\n".join(blocks)
        )
        print(f"{name}: {len(derived)} derived glyphs "
              f"(cap {M.cap_top}-{M.cap_bot}, x {M.xh_top}-{M.xh_bot}, "
              f"w {M.w}, stem {M.stem})")


if __name__ == "__main__":
    main()
