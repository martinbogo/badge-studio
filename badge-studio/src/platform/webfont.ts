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

/**
 * The glyph renderer for the browser build: a port of `src-tauri/src/font/mod.rs`.
 *
 * The glyph table itself is not restated here. `fonts/webfont.py` generates
 * `web/fonts.json` from the same `fonts/*.face` pixel art that `build.py` turns
 * into the Rust tables, and CI regenerates both and fails on a diff, so the two
 * builds cannot disagree about what a letter looks like. What is restated is
 * the *layout*, which is the part with rules in it: fallback order, jitter, and
 * which characters take up no room.
 */

import fontsRaw from "../../../web/fonts.json?raw";
import { BADGE_HEIGHT, type TextBitmap } from "../types";
import type { FaceInfo } from "./types";

/** Glyph rows are 16 bits wide, bit 15 leftmost, whatever the art's width. */
const GLYPH_FIELD = 16;

interface Face {
  id: string;
  name: string;
  notice: string;
  jitter: number[];
  pickable: boolean;
  /** char -> [advance, ...11 row bitmaps] */
  glyphs: Record<string, number[]>;
}

/**
 * In fallback order, as generated.
 *
 * Imported as raw text and parsed, not as a JSON module: importing it as a
 * module makes TypeScript infer a literal type with a member per glyph, which
 * is 1174 of them and slows every typecheck for no benefit.
 */
const FACES: Face[] = (JSON.parse(fontsRaw) as { faces: Face[] }).faces;

export const DEFAULT_FACE = "serif";

/**
 * Characters that must not draw or take up room.
 *
 * A pasted emoji is rarely one code point. Variation selectors, the zero-width
 * joiner and the skin-tone modifiers all arrive alongside the pictograph, and
 * rendering them as '?' turns one heart into two glyphs, one a question mark.
 */
function isIgnorable(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (
    cp === 0x200d ||
    cp === 0xfe0e ||
    cp === 0xfe0f ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff)
  );
}

const faceById = (id?: string) => FACES.find((f) => f.id === id) ?? FACES[0];

/**
 * The face that will actually draw `c`, and its glyph.
 *
 * Resolution is shared by measuring and drawing, or the editor budgets against
 * one width and stamps another.
 */
function resolve(chosen: Face, c: string): [Face, number[]] | null {
  const own = chosen.glyphs[c];
  if (own) return [chosen, own];
  for (const f of FACES) {
    const g = f.glyphs[c];
    if (g) return [f, g];
  }
  return null;
}

/** Pixels `c` occupies, drawn in `chosen` or whichever face stands in. */
function advance(chosen: Face, c: string): number {
  if (isIgnorable(c)) return 0;
  const hit = resolve(chosen, c);
  if (hit) return hit[1][0];
  return chosen.glyphs["?"]?.[0] ?? 0;
}

function measure(chosen: Face, text: string): number {
  let n = 0;
  for (const c of text) n += advance(chosen, c);
  return n;
}

/** Draw `text` into a pixel grid. Mirrors `font::layout`. */
export function layout(text: string, faceId?: string): TextBitmap {
  const chosen = faceById(faceId);
  const width = measure(chosen, text);
  const rows: boolean[][] = Array.from({ length: BADGE_HEIGHT }, () =>
    new Array<boolean>(width).fill(false)
  );
  const missing: string[] = [];
  let pen = 0;
  let i = 0;

  for (const c of text) {
    const at = i++;
    if (isIgnorable(c)) continue;
    let drawn: Face;
    let glyph: number[] | undefined;
    const hit = resolve(chosen, c);
    if (hit) {
      [drawn, glyph] = hit;
    } else {
      if (!missing.includes(c)) missing.push(c);
      drawn = chosen;
      glyph = chosen.glyphs["?"];
      if (!glyph) continue;
    }

    // Jitter belongs to the face actually drawing the glyph, so a bouncy face
    // stays bouncy even where it borrows a pictograph from another. Keyed on
    // position in the string rather than on the character, or every 'l' in
    // "hello" would bounce to the same height and it would read as a fault.
    const dy = drawn.jitter.length ? drawn.jitter[at % drawn.jitter.length] : 0;
    for (let r = 0; r < BADGE_HEIGHT; r++) {
      const y = r + dy;
      if (y < 0 || y >= BADGE_HEIGHT) continue;
      const bits = glyph[1 + r];
      for (let x = 0; x < GLYPH_FIELD; x++) {
        if (bits & (1 << (GLYPH_FIELD - 1 - x))) {
          const px = pen + x;
          if (px < width) rows[y][px] = true;
        }
      }
    }
    pen += glyph[0];
  }

  return { rows, width, columns: Math.ceil(width / 8), missing };
}

/**
 * The faces as the editor needs to know them, in fallback order.
 *
 * Every face is sent, not just the pickable ones, because measuring has to
 * follow the same fallback chain the renderer does.
 */
export function fontMetrics(): FaceInfo[] {
  return FACES.map((f) => ({
    id: f.id,
    name: f.name,
    notice: f.notice,
    pickable: f.pickable,
    advances: Object.entries(f.glyphs).map(([c, g]) => [c, g[0]] as [string, number]),
  }));
}
