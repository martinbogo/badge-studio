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

import { BADGE_HEIGHT, type Frame } from "./types";

export interface Point {
  x: number;
  y: number;
}

/** Inclusive pixel rectangle, always normalised so x0 <= x1 and y0 <= y1. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

export function rectWidth(r: Rect): number {
  return r.x1 - r.x0 + 1;
}

export function rectHeight(r: Rect): number {
  return r.y1 - r.y0 + 1;
}

// --- primitives -----------------------------------------------------------

/**
 * Bresenham, including both endpoints.
 *
 * The endpoints are ordered canonically first. Plain Bresenham resolves an
 * exact error tie in favour of whichever end it started from, so dragging
 * right-to-left could produce a visibly different line from the same drag done
 * left-to-right. Sorting first makes a line depend only on its endpoints.
 */
export function linePoints(a: Point, b: Point): Point[] {
  const swap = b.x < a.x || (b.x === a.x && b.y < a.y);
  if (swap) [a, b] = [b, a];
  const out: Point[] = [];
  let { x: x0, y: y0 } = a;
  const { x: x1, y: y1 } = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    out.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

export function rectPoints(a: Point, b: Point, filled: boolean): Point[] {
  const r = normalizeRect(a, b);
  const out: Point[] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
      if (filled || edge) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Ellipse inscribed in the dragged bounding box.
 *
 * Tested by sampling pixel centres rather than a midpoint-tracing algorithm.
 * On an 11px-tall display most ellipses are only a few pixels across, and the
 * incremental algorithms degenerate badly at that size; brute force over the
 * bounding box is both correct and trivially cheap here.
 */
export function ellipsePoints(a: Point, b: Point, filled: boolean): Point[] {
  const r = normalizeRect(a, b);
  const w = rectWidth(r);
  const h = rectHeight(r);
  const cx = r.x0 + w / 2;
  const cy = r.y0 + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  const inside = (x: number, y: number): boolean => {
    const dx = (x + 0.5 - cx) / rx;
    const dy = (y + 0.5 - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };

  const out: Point[] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      if (!inside(x, y)) continue;
      if (filled) {
        out.push({ x, y });
        continue;
      }
      // Outline: keep pixels that touch the outside.
      const boundary =
        !inside(x - 1, y) ||
        !inside(x + 1, y) ||
        !inside(x, y - 1) ||
        !inside(x, y + 1);
      if (boundary) out.push({ x, y });
    }
  }
  return out;
}

/** 4-connected flood fill from a seed, over the contiguous same-valued region. */
export function floodFillPoints(frame: Frame, seed: Point): Point[] {
  const width = frame[0]?.length ?? 0;
  if (
    seed.y < 0 ||
    seed.y >= BADGE_HEIGHT ||
    seed.x < 0 ||
    seed.x >= width
  ) {
    return [];
  }
  const target = frame[seed.y][seed.x];
  const seen = new Set<number>();
  const out: Point[] = [];
  const stack: Point[] = [seed];

  while (stack.length) {
    const p = stack.pop()!;
    if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= BADGE_HEIGHT) continue;
    const key = p.y * width + p.x;
    if (seen.has(key)) continue;
    if (frame[p.y][p.x] !== target) continue;
    seen.add(key);
    out.push(p);
    stack.push({ x: p.x + 1, y: p.y });
    stack.push({ x: p.x - 1, y: p.y });
    stack.push({ x: p.x, y: p.y + 1 });
    stack.push({ x: p.x, y: p.y - 1 });
  }
  return out;
}

// --- brush ----------------------------------------------------------------

/** Offsets for an n-wide square brush, kept centred for odd sizes. */
export function brushOffsets(size: number): Point[] {
  const n = Math.max(1, Math.round(size));
  const lo = -Math.floor((n - 1) / 2);
  const out: Point[] = [];
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      out.push({ x: lo + dx, y: lo + dy });
    }
  }
  return out;
}

export function expandBrush(points: Point[], size: number): Point[] {
  if (size <= 1) return points;
  const offsets = brushOffsets(size);
  const seen = new Set<number>();
  const out: Point[] = [];
  for (const p of points) {
    for (const o of offsets) {
      const x = p.x + o.x;
      const y = p.y + o.y;
      const key = (y + 64) * 4096 + (x + 64);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, y });
    }
  }
  return out;
}

// --- application ----------------------------------------------------------

/** Set every listed point to `value`, ignoring anything off-canvas. */
export function applyPoints(
  frame: Frame,
  points: Point[],
  value: boolean
): Frame {
  const width = frame[0]?.length ?? 0;
  const out = frame.map((row) => row.slice());
  for (const p of points) {
    if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= BADGE_HEIGHT) continue;
    out[p.y][p.x] = value;
  }
  return out;
}

// --- selection ------------------------------------------------------------

export function extractRect(frame: Frame, r: Rect): boolean[][] {
  const width = frame[0]?.length ?? 0;
  const out: boolean[][] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    const row: boolean[] = [];
    for (let x = r.x0; x <= r.x1; x++) {
      const inBounds = x >= 0 && x < width && y >= 0 && y < BADGE_HEIGHT;
      row.push(inBounds ? frame[y][x] : false);
    }
    out.push(row);
  }
  return out;
}

export function clearRect(frame: Frame, r: Rect): Frame {
  return applyPoints(frame, rectPoints({ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y1 }, true), false);
}

/**
 * Draw a block at (ox, oy). `transparent` leaves unlit source pixels alone,
 * which is what you want when moving a shape over existing art; otherwise the
 * block replaces the destination wholesale.
 */
export function pasteBlock(
  frame: Frame,
  block: boolean[][],
  ox: number,
  oy: number,
  transparent: boolean
): Frame {
  const width = frame[0]?.length ?? 0;
  const out = frame.map((row) => row.slice());
  for (let y = 0; y < block.length; y++) {
    for (let x = 0; x < block[y].length; x++) {
      const tx = ox + x;
      const ty = oy + y;
      if (tx < 0 || tx >= width || ty < 0 || ty >= BADGE_HEIGHT) continue;
      if (transparent && !block[y][x]) continue;
      out[ty][tx] = block[y][x];
    }
  }
  return out;
}
