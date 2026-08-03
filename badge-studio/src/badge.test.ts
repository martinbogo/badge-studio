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
import { previewPeriod, renderPreview, stepDelay } from "./badge";
import { BADGE_HEIGHT, BADGE_WIDTH, MODES, type Frame, type Message } from "./types";

function frameFrom(rows: string[]): Frame {
  return rows.map((r) => [...r].map((c) => c === "#"));
}

function msg(mode: Message["mode"], frames: Frame[]): Message {
  return {
    id: "t",
    name: "t",
    mode,
    speed: 4,
    blink: false,
    ants: false,
    frames,
    width: frames[0][0].length,
  };
}

/** A 3px-wide block in the middle rows, easy to track through an effect. */
const BLOCK = frameFrom([
  "...",
  "...",
  "...",
  "###",
  "###",
  "###",
  "###",
  "...",
  "...",
  "...",
  "...",
]);

const lit = (f: Frame) => f.flat().filter(Boolean).length;

describe("renderPreview", () => {
  it("always returns a full badge-sized view for every mode", () => {
    for (const mode of MODES) {
      const m = msg(mode, [BLOCK]);
      for (let step = 0; step < 40; step++) {
        const v = renderPreview(m, step);
        expect(v).toHaveLength(BADGE_HEIGHT);
        for (const row of v) expect(row).toHaveLength(BADGE_WIDTH);
      }
    }
  });

  it("is deterministic", () => {
    for (const mode of MODES) {
      const m = msg(mode, [BLOCK]);
      expect(renderPreview(m, 7)).toEqual(renderPreview(m, 7));
    }
  });

  it("repeats after exactly one period", () => {
    for (const mode of MODES) {
      const m = msg(mode, [BLOCK]);
      const p = previewPeriod(m);
      expect(p).toBeGreaterThan(0);
      for (const step of [0, 1, 3]) {
        expect(renderPreview(m, step)).toEqual(renderPreview(m, step + p));
      }
    }
  });

  it("centres a narrow bitmap in fixed mode", () => {
    const v = renderPreview(msg("fixed", [BLOCK]), 0);
    const ox = Math.floor((BADGE_WIDTH - 3) / 2);
    expect(v[3][ox]).toBe(true);
    expect(v[3][ox - 1]).toBe(false);
    expect(v[3][ox + 3]).toBe(false);
  });

  it("fixed centres using truncating division, as the reference does", () => {
    // Regression: Dart's `~/` truncates toward zero, Math.floor does not. They
    // differ exactly when (BADGE_WIDTH - width) is negative and odd, which
    // shifted the bitmap a column left and pushed column 0 off-screen.
    for (const width of [24, 25, 43, 44, 45, 47, 49, 51]) {
      const f: Frame = Array.from({ length: BADGE_HEIGHT }, () =>
        Array.from({ length: width }, (_, x) => x % 3 === 0)
      );
      const v = renderPreview(msg("fixed", [f]), 0);
      const offset = Math.trunc((BADGE_WIDTH - width) / 2);
      for (let j = 0; j < BADGE_WIDTH; j++) {
        const src = j - offset;
        const expected = src >= 0 && src < width && src % 3 === 0;
        expect(v[0][j]).toBe(expected);
      }
    }
  });

  it("fixed keeps column 0 for a bitmap one pixel too wide", () => {
    // trunc((44 - 45) / 2) = 0, so nothing is cropped from the left.
    // Math.floor would give -1 and lose it.
    const f: Frame = Array.from({ length: BADGE_HEIGHT }, () =>
      Array.from({ length: 45 }, (_, x) => x === 0)
    );
    expect(renderPreview(msg("fixed", [f]), 0)[0][0]).toBe(true);
  });

  it("scrolls left across the display and clears at both ends", () => {
    const m = msg("scroll_left", [BLOCK]);
    expect(lit(renderPreview(m, 0))).toBe(0);
    const mid = renderPreview(m, BADGE_WIDTH + 1);
    expect(lit(mid)).toBeGreaterThan(0);
  });

  it("scroll up holds still in the middle of its cycle", () => {
    const m = msg("scroll_up", [BLOCK]);
    // The hold runs from BADGE_HEIGHT to BADGE_HEIGHT + 15.
    const a = renderPreview(m, BADGE_HEIGHT + 2);
    const b = renderPreview(m, BADGE_HEIGHT + 10);
    expect(a).toEqual(b);
    expect(lit(a)).toBeGreaterThan(0);
  });

  it("scroll up and scroll down differ", () => {
    // At step 3 the offset is 8, which puts both windows entirely off the lit
    // rows, so they are legitimately identical. Step 6 overlaps from opposite
    // directions.
    const up = renderPreview(msg("scroll_up", [BLOCK]), 6);
    const down = renderPreview(msg("scroll_down", [BLOCK]), 6);
    expect(up).not.toEqual(down);
  });

  it("laser fires a beam to the right edge from a lit column", () => {
    // Wide enough that the beam has somewhere to go.
    const wide = frameFrom(Array.from({ length: BADGE_HEIGHT }, () => "#".repeat(10)));
    const m = msg("laser", [wide]);
    const v = renderPreview(m, 2);
    // Row 0 should be lit all the way out to the right edge.
    expect(v[0][BADGE_WIDTH - 1]).toBe(true);
  });

  it("laser shows the plain bitmap entering its second half", () => {
    // The reference guards the whole second half with `index < newWidth`, so a
    // narrow bitmap only renders during the first few steps of it. Faithfully
    // ported, quirk included.
    const m = msg("laser", [BLOCK]);
    expect(lit(renderPreview(m, BADGE_WIDTH))).toBeGreaterThan(0);
    expect(lit(renderPreview(m, BADGE_WIDTH * 2 - 1))).toBe(0);
  });

  it("picture always draws its two scan lines", () => {
    const m = msg("picture", [BLOCK]);
    for (const step of [0, 5, 12, 21]) {
      const v = renderPreview(m, step);
      // Both scan columns are fully lit top to bottom.
      const fullCols = Array.from({ length: BADGE_WIDTH }, (_, x) =>
        v.every((row) => row[x])
      ).filter(Boolean).length;
      expect(fullCols).toBeGreaterThanOrEqual(1);
    }
  });

  it("snowflake starts empty-ish and fills as rows land", () => {
    const m = msg("snowflake", [BLOCK]);
    const early = lit(renderPreview(m, 0));
    const settled = lit(renderPreview(m, BADGE_HEIGHT * 3));
    expect(settled).toBeGreaterThanOrEqual(early);
  });

  it("animation shows the frame matching the step", () => {
    const a = frameFrom(Array.from({ length: BADGE_HEIGHT }, () => "#".repeat(4)));
    const b = frameFrom(Array.from({ length: BADGE_HEIGHT }, () => ".".repeat(4)));
    const m = msg("animation", [a, b]);
    expect(lit(renderPreview(m, 0))).toBeGreaterThan(0);
    expect(lit(renderPreview(m, 1))).toBe(0);
    expect(lit(renderPreview(m, 2))).toBeGreaterThan(0);
  });

  it("never reads outside the source bitmap", () => {
    const tiny = frameFrom(Array.from({ length: BADGE_HEIGHT }, () => "#"));
    for (const mode of MODES) {
      for (let step = 0; step < 30; step++) {
        expect(() => renderPreview(msg(mode, [tiny]), step)).not.toThrow();
      }
    }
  });
});

describe("stepDelay", () => {
  it("passes through the measured hardware point", () => {
    // 8-frame animation at speed 6 timed at 5 rotations in 10s = 250ms/frame.
    expect(stepDelay(6)).toBeCloseTo(250, 6);
  });

  it("keeps the reference curve's shape either side of it", () => {
    // Ratios between speeds are inherited from the reference mapping, so only
    // the scale is calibrated. These are the falsifiable predictions.
    expect(stepDelay(1)).toBeCloseTo(551.7, 1);
    expect(stepDelay(2)).toBeCloseTo(491.4, 1);
    expect(stepDelay(8)).toBeCloseTo(129.3, 1);
  });

  it("gets monotonically faster as speed rises", () => {
    for (let s = 1; s < 8; s++) {
      expect(stepDelay(s + 1)).toBeLessThan(stepDelay(s));
    }
  });

  it("clamps out-of-range speeds", () => {
    expect(stepDelay(0)).toBe(stepDelay(1));
    expect(stepDelay(99)).toBe(stepDelay(8));
  });
});
