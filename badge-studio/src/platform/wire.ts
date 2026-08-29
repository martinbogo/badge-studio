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
 * The "wang" encoder, in TypeScript, for the browser build.
 *
 * A second implementation of something that writes to hardware is a liability,
 * so this is a deliberate port of `src-tauri/src/protocol.rs` and `to_messages`
 * in `lib.rs` rather than a fresh reading of PROTOCOL.md, and `wire.test.ts`
 * holds it to the Rust encoder's own golden vectors. If you change one, change
 * both, and the test will tell you if you did not.
 */

import {
  ANIMATION_MAX_FRAMES,
  BADGE_HEIGHT,
  BADGE_WIDTH,
  FRAME_WIDTH,
  MAX_MESSAGES,
  type Frame,
  type Mode,
} from "../types";
import type { Firmware, MessageSpec } from "./types";

const MAGIC = [0x77, 0x61, 0x6e, 0x67]; // "wang"
export const HEADER_SIZE = 64;
const DEVICE_BUFFER = 8192;
export const MAX_BYTE_COLUMNS = Math.floor((DEVICE_BUFFER - HEADER_SIZE) / BADGE_HEIGHT);

/**
 * Wire values for the modes. Spelled out rather than taken from the order of
 * `MODES`, because these are a protocol, and reordering a UI list must not
 * silently change what the badge is told.
 */
const MODE_BITS: Record<Mode, number> = {
  scroll_left: 0,
  scroll_right: 1,
  scroll_up: 2,
  scroll_down: 3,
  fixed: 4,
  animation: 5,
  snowflake: 6,
  picture: 7,
  laser: 8,
};

/**
 * Header byte 5: a brightness level in the high nibble, 0 brightest.
 *
 * 25% is 0x30 and not 0x40, which is what every other client for these badges
 * sends. On a CH582 badge 0x40 does not dim the display, it corrupts it: the
 * value is a level index rather than a bitmask, the panel has four levels, and
 * 0x40 is index 4 of 0..3, so the firmware reads past the end of its own table.
 */
function brightnessBits(percent: number): number {
  switch (percent) {
    case 100: return 0x00;
    case 75: return 0x10;
    case 50: return 0x20;
    case 25: return 0x30;
    default: throw new Error(`brightness must be 25, 50, 75 or 100, got ${percent}`);
  }
}

/** Columns the firmware advances per animation frame. */
export function animationStride(fw: Firmware): number {
  return fw === "badge-magic" ? BADGE_WIDTH : FRAME_WIDTH;
}

/**
 * Pack a grid of booleans into the column-major badge layout, MSB leftmost.
 * Width is padded up to a multiple of 8.
 */
export function pixelsToBitmap(rows: Frame): { bitmap: Uint8Array; columns: number } {
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const columns = Math.ceil(width / 8);
  const bitmap = new Uint8Array(columns * BADGE_HEIGHT);
  let k = 0;
  for (let col = 0; col < columns; col++) {
    for (let row = 0; row < BADGE_HEIGHT; row++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = col * 8 + bit;
        if (rows[row]?.[x]) byte |= 1 << (7 - bit);
      }
      bitmap[k++] = byte;
    }
  }
  return { bitmap, columns };
}

/**
 * Concatenate animation frames horizontally into a single mode-5 filmstrip.
 *
 * The stride is the firmware's, not the display's: stock advances 48 columns
 * per frame even though only 44 light up, and badgemagic advances its real 44.
 * Pad to the wrong one and every frame after the first lands further sideways
 * than the last.
 */
export function framesToBitmap(
  frames: Frame[],
  stride: number
): { bitmap: Uint8Array; columns: number } {
  const strip: Frame = Array.from({ length: BADGE_HEIGHT }, () => [] as boolean[]);
  for (const f of frames) {
    for (let row = 0; row < BADGE_HEIGHT; row++) {
      for (let x = 0; x < stride; x++) strip[row].push(f[row]?.[x] ?? false);
    }
  }
  return pixelsToBitmap(strip);
}

interface Packed {
  bitmap: Uint8Array;
  columns: number;
  mode: Mode;
  speed: number;
  blink: boolean;
  ants: boolean;
}

/** Mirrors `to_messages` in lib.rs, including its error wording. */
export function toMessages(specs: MessageSpec[], fw: Firmware): Packed[] {
  if (!specs.length) throw new Error("Add at least one message before sending.");
  return specs.map((s) => {
    if (!s.frames.length) throw new Error("A message has no frames.");
    let out: { bitmap: Uint8Array; columns: number };
    if (s.mode === "animation") {
      if (s.frames.length > ANIMATION_MAX_FRAMES) {
        throw new Error(
          `${s.frames.length} animation frames in one slot, but a slot holds ` +
            `${ANIMATION_MAX_FRAMES}. Split the sequence across the 8 message slots ` +
            `instead: the badge cycles them, giving 64 frames in total.`
        );
      }
      out = framesToBitmap(s.frames, animationStride(fw));
    } else {
      out = pixelsToBitmap(s.frames[0]);
    }
    if (out.columns === 0) {
      throw new Error("A message is empty. Draw something or remove it.");
    }
    return { ...out, mode: s.mode, speed: s.speed, blink: s.blink, ants: s.ants };
  });
}

/** Serialize messages into the byte stream both transports carry. */
export function pack(messages: Packed[], brightness: number, now = new Date()): Uint8Array {
  if (!messages.length) throw new Error("need at least one message");
  if (messages.length > MAX_MESSAGES) {
    throw new Error(`at most ${MAX_MESSAGES} messages, got ${messages.length}`);
  }
  const bright = brightnessBits(brightness);
  for (const m of messages) {
    if (!(m.speed >= 1 && m.speed <= 8)) {
      throw new Error(`speed must be 1..=8, got ${m.speed}`);
    }
  }
  const total = messages.reduce((n, m) => n + m.columns, 0);
  if (total > MAX_BYTE_COLUMNS) {
    throw new Error(
      `payload is ${total} byte columns (${total * 8} px wide), device holds ` +
        `${MAX_BYTE_COLUMNS} (${MAX_BYTE_COLUMNS * 8} px)`
    );
  }

  const out = new Uint8Array(HEADER_SIZE + total * BADGE_HEIGHT);
  out.set(MAGIC, 0);
  out[5] = bright;
  messages.forEach((m, i) => {
    out[6] |= (m.blink ? 1 : 0) << i;
    out[7] |= (m.ants ? 1 : 0) << i;
    out[8 + i] = ((m.speed - 1) << 4) | MODE_BITS[m.mode];
    out[16 + 2 * i] = (m.columns >> 8) & 0xff;
    out[17 + 2 * i] = m.columns & 0xff;
  });
  // The badge stores the stamp but never displays it.
  out[38] = now.getFullYear() % 100;
  out[39] = now.getMonth() + 1;
  out[40] = now.getDate();
  out[41] = now.getHours();
  out[42] = now.getMinutes();
  out[43] = now.getSeconds();

  let off = HEADER_SIZE;
  for (const m of messages) {
    out.set(m.bitmap, off);
    off += m.bitmap.length;
  }
  return out;
}

/** Everything a transport needs, from the specs the editor hands over. */
export function encode(
  specs: MessageSpec[],
  brightness: number,
  fw: Firmware
): Uint8Array {
  return pack(toMessages(specs, fw), brightness);
}
