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
 * Holds the browser encoder to the Rust one, byte for byte.
 *
 * There are now two implementations of something that writes to hardware, so
 * "it looked right on screen" is not evidence. These vectors were printed by
 * protocol.rs itself and pasted here. If one of them fails, the two encoders
 * have diverged and the badge is told different things depending on which
 * build the user happens to be running.
 *
 * To regenerate: add a test to protocol.rs that prints pack(...) as hex with a
 * Stamp::default(), run it, and paste the output. The stamp is zeroed here
 * because it is wall-clock, and the badge stores it without ever showing it.
 */

import { describe, expect, it } from "vitest";
import { BADGE_HEIGHT } from "./types";
import { encode } from "./platform/wire";
import { layout } from "./platform/webfont";
import type { MessageSpec } from "./platform/types";

/** The same filler the Rust side generated its vectors from. */
const synth = (w: number, seed: number): boolean[][] =>
  Array.from({ length: BADGE_HEIGHT }, (_, r) =>
    Array.from({ length: w }, (_, c) => (r + c + seed) % 3 === 0)
  );

/** Wall-clock bytes, zeroed to match Stamp::default(). */
function hex(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes);
  copy.fill(0, 38, 44);
  return Array.from(copy, (b) => b.toString(16).padStart(2, "0")).join("");
}

const RUST_V1 = "77616e6700000000400000000000000000050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c6c6c6c6fec6c6c6c60000fe66626878686266fe0000f060606060606266fe0000f060606060606266fe00007cc6c6c6c6c6c6c67c00";
const RUST_V2 = "77616e67000000002500000000000000001200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922040902040902040902040244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244090204090204090204090499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499020409020409020409020";
const RUST_V3 = "77616e6700000000250000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000092244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992224499224499224499224449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449922449499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499224499020409020409020409020";
const RUST_V4 = "77616e6700300102047800000000000000020003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000092244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992244992";

describe("the browser encoder agrees with the Rust one", () => {
  it("stamps text through the shared glyph table", () => {
    const spec: MessageSpec = {
      frames: [layout("HELLO", "serif").rows],
      mode: "scroll_left",
      speed: 5,
      blink: false,
      ants: false,
    };
    expect(hex(encode([spec], 100, "stock"))).toBe(RUST_V1);
  });

  const frames = [synth(44, 0), synth(44, 1), synth(44, 2)];
  const animation: MessageSpec = {
    frames,
    mode: "animation",
    speed: 3,
    blink: false,
    ants: false,
  };

  it("pads animation frames to the stock 48-column stride", () => {
    expect(hex(encode([animation], 100, "stock"))).toBe(RUST_V2);
  });

  it("pads animation frames to badgemagic's 44-column stride", () => {
    expect(hex(encode([animation], 100, "badge-magic"))).toBe(RUST_V3);
  });

  it("differs between the two strides, or the firmware check is pointless", () => {
    expect(RUST_V2).not.toBe(RUST_V3);
  });

  it("packs blink, border, speed and two messages at 25 per cent", () => {
    const specs: MessageSpec[] = [
      { frames: [synth(16, 0)], mode: "fixed", speed: 1, blink: true, ants: false },
      { frames: [synth(24, 1)], mode: "laser", speed: 8, blink: false, ants: true },
    ];
    expect(hex(encode(specs, 25, "stock"))).toBe(RUST_V4);
  });

  it("sends 0x30 for 25 per cent, not the 0x40 every other client sends", () => {
    // 0x40 does not dim a CH582 panel, it corrupts it: the value is a level
    // index into a table of four, so 4 reads off the end.
    const spec: MessageSpec = {
      frames: [synth(8, 0)],
      mode: "fixed",
      speed: 1,
      blink: false,
      ants: false,
    };
    expect(encode([spec], 25, "stock")[5]).toBe(0x30);
    expect(encode([spec], 100, "stock")[5]).toBe(0x00);
  });
});
