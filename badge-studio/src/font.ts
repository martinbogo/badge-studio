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
 * How wide a string will be, in pixels, once a face stamps it.
 *
 * Pixels rather than characters, and pixels rather than byte columns: faces are
 * proportional, a pictograph is wider than an 'i', and only the finished
 * message is rounded up to the protocol's 8px columns. Counting characters was
 * right for exactly one face and would have gone quietly wrong on the second.
 *
 * The widths come from the Rust tables at startup rather than being restated
 * here, so there is one source of truth. `measure_matches_layout` in
 * font/mod.rs holds the Rust side to the same answer, and the resolution order
 * below mirrors `font::resolve`.
 */

import { invoke } from "@tauri-apps/api/core";

export interface FaceInfo {
  id: string;
  name: string;
  notice: string;
  /** False for a face that only exists to be fallen back to, like the emoji. */
  pickable: boolean;
  advances: [string, number][];
}

interface Loaded {
  id: string;
  name: string;
  notice: string;
  pickable: boolean;
  advances: Map<string, number>;
}

/** In fallback order, as sent. */
let faces: Loaded[] = [];

/**
 * Assumed advance before the tables arrive, and for a face that cannot draw a
 * character at all. The shipped face is 8px fixed, so this is right until it
 * is replaced by a real answer a moment later.
 */
const ASSUMED = 8;

export async function loadFontMetrics(): Promise<void> {
  if (faces.length) return;
  const list = await invoke<FaceInfo[]>("font_metrics");
  faces = list.map((f) => ({ ...f, advances: new Map(f.advances) }));
}

/**
 * The faces to offer in the picker, in order.
 *
 * Not every loaded face is one you can choose: the emoji set has no letters to
 * typeset with, so it earns its place in the fallback chain rather than in the
 * menu. Measuring still walks the whole list.
 */
export function faceList(): { id: string; name: string; notice: string }[] {
  return faces
    .filter((f) => f.pickable)
    .map(({ id, name, notice }) => ({ id, name, notice }));
}

/**
 * Characters that neither draw nor take up room. Mirrors `font::is_ignorable`.
 *
 * A pasted emoji is rarely one code point: variation selectors, the zero-width
 * joiner and the skin-tone modifiers all arrive alongside the pictograph. None
 * of them is in any face, so without this they measure as the width of '?' and
 * the counter quietly disagrees with what the renderer will actually draw.
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

/**
 * Advance of `c` in `faceId`, falling back through the other faces the way the
 * renderer does, so an emoji typed in a Latin face measures as the emoji it
 * will actually draw as.
 */
function advance(c: string, faceId: string): number {
  if (isIgnorable(c)) return 0;
  if (!faces.length) return ASSUMED;
  const chosen = faces.find((f) => f.id === faceId) ?? faces[0];
  const own = chosen.advances.get(c);
  if (own !== undefined) return own;
  for (const f of faces) {
    const w = f.advances.get(c);
    if (w !== undefined) return w;
  }
  // Nothing can draw it, so it stamps as '?' and costs that.
  return chosen.advances.get("?") ?? ASSUMED;
}

/** Pixels `text` occupies once stamped in `faceId`. */
export function measureText(text: string, faceId: string): number {
  let n = 0;
  // Code points, not UTF-16 units: an emoji is one glyph, not two.
  for (const c of text) n += advance(c, faceId);
  return n;
}

/**
 * The longest leading part of `text` that fits in `budget` pixels.
 *
 * Trims by width rather than by character count, so a proportional face stops
 * in the right place instead of near it.
 */
export function fitText(text: string, budget: number, faceId: string): string {
  let n = 0;
  let out = "";
  for (const c of text) {
    const w = advance(c, faceId);
    if (n + w > budget) break;
    n += w;
    out += c;
  }
  return out;
}

/** Test seam: pretend these are the installed faces. */
export function __setFacesForTest(list: FaceInfo[]): void {
  faces = list.map((f) => ({ ...f, advances: new Map(f.advances) }));
}
