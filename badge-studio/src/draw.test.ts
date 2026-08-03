// Copyright 2026 Martin Bogomolni
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, expect, it } from "vitest";
import {
  applyPoints,
  brushOffsets,
  clearRect,
  ellipsePoints,
  expandBrush,
  extractRect,
  floodFillPoints,
  linePoints,
  normalizeRect,
  pasteBlock,
  rectPoints,
  type Point,
} from "./draw";
import { BADGE_HEIGHT, type Frame } from "./types";

function blank(width: number): Frame {
  return Array.from({ length: BADGE_HEIGHT }, () =>
    Array<boolean>(width).fill(false)
  );
}

/** Render a frame as text so failures are readable. */
function render(f: Frame): string {
  return f.map((row) => row.map((p) => (p ? "#" : ".")).join("")).join("\n");
}

function fromRows(rows: string[]): Frame {
  const f = blank(rows[0].length);
  rows.forEach((r, y) => {
    [...r].forEach((c, x) => {
      f[y][x] = c === "#";
    });
  });
  return f;
}

function key(p: Point) {
  return `${p.x},${p.y}`;
}

describe("linePoints", () => {
  it("includes both endpoints", () => {
    const pts = linePoints({ x: 2, y: 3 }, { x: 7, y: 3 });
    expect(pts[0]).toEqual({ x: 2, y: 3 });
    expect(pts[pts.length - 1]).toEqual({ x: 7, y: 3 });
  });

  it("draws a horizontal run with no gaps", () => {
    const pts = linePoints({ x: 0, y: 5 }, { x: 5, y: 5 });
    expect(pts.map((p) => p.x)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("draws a perfect diagonal", () => {
    const pts = linePoints({ x: 0, y: 0 }, { x: 4, y: 4 });
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ]);
  });

  it("produces the same pixels regardless of drag direction", () => {
    // Several slopes, including the exact-tie cases that trip plain Bresenham.
    const cases: [Point, Point][] = [
      [{ x: 1, y: 2 }, { x: 9, y: 7 }],
      [{ x: 0, y: 0 }, { x: 4, y: 2 }],
      [{ x: 0, y: 0 }, { x: 2, y: 4 }],
      [{ x: 3, y: 8 }, { x: 10, y: 1 }],
    ];
    for (const [p, q] of cases) {
      expect(linePoints(p, q).map(key).sort()).toEqual(
        linePoints(q, p).map(key).sort()
      );
    }
  });

  it("handles a single point", () => {
    expect(linePoints({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }]);
  });

  it("never leaves a diagonal gap", () => {
    const pts = linePoints({ x: 0, y: 0 }, { x: 10, y: 3 });
    for (let i = 1; i < pts.length; i++) {
      const dx = Math.abs(pts[i].x - pts[i - 1].x);
      const dy = Math.abs(pts[i].y - pts[i - 1].y);
      expect(Math.max(dx, dy)).toBe(1);
    }
  });
});

describe("rectPoints", () => {
  it("outlines without filling", () => {
    const f = applyPoints(
      blank(6),
      rectPoints({ x: 1, y: 1 }, { x: 4, y: 4 }, false),
      true
    );
    expect(render(f).split("\n").slice(0, 6)).toEqual([
      "......",
      ".####.",
      ".#..#.",
      ".#..#.",
      ".####.",
      "......",
    ]);
  });

  it("fills every cell when asked", () => {
    const pts = rectPoints({ x: 2, y: 2 }, { x: 5, y: 6 }, true);
    expect(pts).toHaveLength(4 * 5);
  });

  it("normalises a reversed drag", () => {
    const a = rectPoints({ x: 5, y: 6 }, { x: 2, y: 2 }, true).map(key).sort();
    const b = rectPoints({ x: 2, y: 2 }, { x: 5, y: 6 }, true).map(key).sort();
    expect(a).toEqual(b);
  });

  it("degenerates to a single pixel", () => {
    expect(rectPoints({ x: 3, y: 3 }, { x: 3, y: 3 }, false)).toEqual([
      { x: 3, y: 3 },
    ]);
  });

  it("treats a 1px-tall drag as a line", () => {
    const pts = rectPoints({ x: 0, y: 4 }, { x: 3, y: 4 }, false);
    expect(pts).toHaveLength(4);
  });
});

describe("ellipsePoints", () => {
  it("is hollow in the middle when not filled", () => {
    const outline = new Set(
      ellipsePoints({ x: 0, y: 0 }, { x: 8, y: 8 }, false).map(key)
    );
    expect(outline.has("4,4")).toBe(false);
    expect(outline.has("4,0")).toBe(true);
  });

  it("filled is a superset of the outline", () => {
    const outline = ellipsePoints({ x: 1, y: 1 }, { x: 9, y: 9 }, false).map(key);
    const filled = new Set(
      ellipsePoints({ x: 1, y: 1 }, { x: 9, y: 9 }, true).map(key)
    );
    for (const p of outline) expect(filled.has(p)).toBe(true);
  });

  it("stays inside the dragged bounding box", () => {
    for (const p of ellipsePoints({ x: 2, y: 1 }, { x: 12, y: 9 }, true)) {
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.x).toBeLessThanOrEqual(12);
      expect(p.y).toBeGreaterThanOrEqual(1);
      expect(p.y).toBeLessThanOrEqual(9);
    }
  });

  it("is horizontally symmetric", () => {
    const pts = ellipsePoints({ x: 0, y: 0 }, { x: 10, y: 6 }, false);
    const set = new Set(pts.map(key));
    for (const p of pts) {
      expect(set.has(`${10 - p.x},${p.y}`)).toBe(true);
    }
  });

  it("survives degenerate 1px drags", () => {
    expect(ellipsePoints({ x: 4, y: 4 }, { x: 4, y: 4 }, true)).toEqual([
      { x: 4, y: 4 },
    ]);
    expect(ellipsePoints({ x: 0, y: 5 }, { x: 6, y: 5 }, false).length).toBeGreaterThan(0);
  });
});

describe("floodFillPoints", () => {
  it("fills a bounded region without leaking", () => {
    const f = fromRows([
      "........",
      ".######.",
      ".#....#.",
      ".#....#.",
      ".######.",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
    ]);
    const pts = floodFillPoints(f, { x: 3, y: 2 });
    expect(pts).toHaveLength(8); // the 4x2 interior
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.x).toBeLessThanOrEqual(5);
    }
  });

  it("is 4-connected, so it does not slip through diagonal gaps", () => {
    const f = fromRows([
      "##......",
      "##......",
      "..##....",
      "..##....",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
    ]);
    const pts = floodFillPoints(f, { x: 0, y: 0 });
    expect(pts).toHaveLength(4);
  });

  it("fills the whole canvas from any seed when empty", () => {
    const pts = floodFillPoints(blank(10), { x: 5, y: 5 });
    expect(pts).toHaveLength(10 * BADGE_HEIGHT);
  });

  it("returns nothing for an out-of-bounds seed", () => {
    expect(floodFillPoints(blank(10), { x: -1, y: 0 })).toEqual([]);
    expect(floodFillPoints(blank(10), { x: 0, y: BADGE_HEIGHT })).toEqual([]);
  });
});

describe("brush", () => {
  it("size 1 is a single pixel", () => {
    expect(brushOffsets(1)).toEqual([{ x: 0, y: 0 }]);
  });

  it("size 3 is centred", () => {
    const o = brushOffsets(3);
    expect(o).toHaveLength(9);
    expect(o).toContainEqual({ x: -1, y: -1 });
    expect(o).toContainEqual({ x: 1, y: 1 });
  });

  it("expanding deduplicates overlapping stamps", () => {
    const pts = expandBrush([{ x: 5, y: 5 }, { x: 6, y: 5 }], 3);
    expect(new Set(pts.map(key)).size).toBe(pts.length);
  });
});

describe("applyPoints", () => {
  it("does not mutate the input frame", () => {
    const f = blank(8);
    const out = applyPoints(f, [{ x: 1, y: 1 }], true);
    expect(f[1][1]).toBe(false);
    expect(out[1][1]).toBe(true);
  });

  it("silently drops out-of-bounds points", () => {
    const out = applyPoints(blank(8), [
      { x: -1, y: 0 },
      { x: 99, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 99 },
      { x: 2, y: 2 },
    ], true);
    expect(out[2][2]).toBe(true);
  });
});

describe("selection", () => {
  const art = fromRows([
    "##......",
    "#.#.....",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
  ]);

  it("extracts the exact block", () => {
    const block = extractRect(art, { x0: 0, y0: 0, x1: 2, y1: 1 });
    expect(block).toEqual([
      [true, true, false],
      [true, false, true],
    ]);
  });

  it("clears only inside the rect", () => {
    const out = clearRect(art, { x0: 0, y0: 0, x1: 1, y1: 0 });
    expect(out[0][0]).toBe(false);
    expect(out[0][1]).toBe(false);
    expect(out[1][2]).toBe(true);
  });

  it("round-trips extract then paste", () => {
    const r = { x0: 0, y0: 0, x1: 2, y1: 1 };
    const block = extractRect(art, r);
    const cleared = clearRect(art, r);
    const restored = pasteBlock(cleared, block, 0, 0, false);
    expect(render(restored)).toBe(render(art));
  });

  it("transparent paste preserves what is underneath", () => {
    const base = fromRows([
      "....####",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
    ]);
    const block = [[true, false]];
    const out = pasteBlock(base, block, 4, 0, true);
    expect(out[0][4]).toBe(true);
    expect(out[0][5]).toBe(true); // untouched by the transparent pixel
  });

  it("opaque paste overwrites what is underneath", () => {
    const base = fromRows([
      "....####",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
    ]);
    const out = pasteBlock(base, [[true, false]], 4, 0, false);
    expect(out[0][4]).toBe(true);
    expect(out[0][5]).toBe(false);
  });

  it("clips a paste that runs off the edge", () => {
    const wide = [[true, true, true, true]];
    const out = pasteBlock(blank(6), wide, 4, 0, false);
    expect(out[0][4]).toBe(true);
    expect(out[0][5]).toBe(true);
    expect(out[0]).toHaveLength(6);
  });

  it("normalises a rect dragged up and to the left", () => {
    expect(normalizeRect({ x: 7, y: 9 }, { x: 2, y: 3 })).toEqual({
      x0: 2,
      y0: 3,
      x1: 7,
      y1: 9,
    });
  });
});
