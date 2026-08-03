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

import { LED_COLORS, type LedColor } from "./types";

export interface LedPalette {
  /** Lit LED in the editor canvas. */
  on: string;
  /** Bright core of a lit LED in the badge preview. */
  core: string;
  /** `r,g,b` for the preview's glow gradient. */
  rgb: string;
  /** Onion-skinned pixel from the neighbouring frame. */
  onion: string;
}

function parse(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: [number, number, number], b: [number, number, number], t: number) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const WHITE: [number, number, number] = [255, 255, 255];
/** The canvas background, so onion pixels fade toward it rather than to grey. */
const CANVAS_BG: [number, number, number] = [20, 24, 33];

export function ledPalette(color: LedColor): LedPalette {
  const base = parse(LED_COLORS[color]);
  return {
    on: LED_COLORS[color],
    // A lit LED reads as a white-hot core with the colour in the halo, which
    // is what the physical diodes actually look like at brightness.
    core: mix(base, WHITE, 0.45),
    rgb: `${base[0]}, ${base[1]}, ${base[2]}`,
    onion: mix(base, CANVAS_BG, 0.72),
  };
}
