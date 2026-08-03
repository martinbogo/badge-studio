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

import { afterEach, describe, expect, it } from "vitest";
import { __setFacesForTest, faceList, fitText, measureText } from "./font";

const face = (
  id: string,
  advances: [string, number][],
  pickable = true
) => ({ id, name: id, notice: "", pickable, advances });

/** A fixed 8px face, like the one that ships, and a proportional one. */
const FIXED = face("fixed", [..."ABCi ?"].map((c) => [c, 8] as [string, number]));
const PROP = face("prop", [
  ["A", 7],
  ["i", 3],
  [" ", 4],
  ["?", 6],
]);
/** Pictographs live in their own face, as the emoji set will. */
const PICTS = face("picts", [["★", 11]], false);

afterEach(() => __setFacesForTest([]));

describe("measureText", () => {
  it("sums advances for a fixed face", () => {
    __setFacesForTest([FIXED]);
    expect(measureText("ABC", "fixed")).toBe(24);
    expect(measureText("", "fixed")).toBe(0);
  });

  it("sums real widths rather than character count", () => {
    __setFacesForTest([PROP]);
    // 7 + 3 + 4 = 14 across three characters, not 3 x anything.
    expect(measureText("Ai ", "prop")).toBe(14);
  });

  it("measures the same string differently in different faces", () => {
    __setFacesForTest([FIXED, PROP]);
    expect(measureText("Ai", "fixed")).toBe(16);
    expect(measureText("Ai", "prop")).toBe(10);
  });

  it("borrows a glyph from another face at that face's width", () => {
    __setFacesForTest([FIXED, PICTS]);
    // The star is 11px wide in the face that owns it, not 8 in the chosen one.
    expect(measureText("★", "fixed")).toBe(11);
    expect(measureText("A★", "fixed")).toBe(19);
  });

  it("charges the fallback glyph when nothing can draw it", () => {
    __setFacesForTest([PROP]);
    expect(measureText("字", "prop")).toBe(6);
  });

  it("treats an astral character as one glyph, not two UTF-16 units", () => {
    __setFacesForTest([PROP]);
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    expect(measureText(emoji, "prop")).toBe(6);
  });

  it("gives a variation selector no width at all", () => {
    __setFacesForTest([FIXED, PICTS]);
    // A heart pasted from a phone is the pictograph plus U+FE0F. Charging the
    // selector the width of '?' makes the counter disagree with the renderer.
    expect(measureText("\u2764\ufe0f", "fixed")).toBe(measureText("\u2764", "fixed"));
    expect(measureText("\u200d", "fixed")).toBe(0);
    expect(measureText("\u{1F3FB}", "fixed")).toBe(0);
  });

  it("falls back to the first face for an unknown face id", () => {
    __setFacesForTest([FIXED, PROP]);
    expect(measureText("A", "no-such-face")).toBe(8);
  });

  it("assumes 8px per character before the tables arrive", () => {
    expect(measureText("ABC", "fixed")).toBe(24);
  });
});

describe("fitText", () => {
  it("keeps everything that fits", () => {
    __setFacesForTest([FIXED]);
    expect(fitText("ABC", 40, "fixed")).toBe("ABC");
    expect(fitText("ABC", 24, "fixed")).toBe("ABC");
  });

  it("stops on width, not on character count", () => {
    __setFacesForTest([PROP]);
    // Budget 13: A costs 7, leaving 6 for two 3px 'i's.
    expect(fitText("Aiii", 13, "prop")).toBe("Aii");
  });

  it("fits a different number of characters per face", () => {
    __setFacesForTest([FIXED, PROP]);
    expect(fitText("AAA", 21, "fixed")).toBe("AA");
    expect(fitText("AAA", 21, "prop")).toBe("AAA");
  });

  it("never returns something wider than the budget", () => {
    __setFacesForTest([FIXED, PROP, PICTS]);
    for (let budget = 0; budget <= 40; budget++) {
      const out = fitText("A★i ?", budget, "prop");
      expect(measureText(out, "prop")).toBeLessThanOrEqual(budget);
    }
  });

  it("drops a glyph it cannot afford rather than a partial one", () => {
    __setFacesForTest([PROP]);
    expect(fitText("AA", 13, "prop")).toBe("A");
  });

  it("returns nothing on an exhausted budget", () => {
    __setFacesForTest([FIXED]);
    expect(fitText("ABC", 0, "fixed")).toBe("");
  });
});

describe("faceList", () => {
  it("preserves the order the faces arrived in, which is fallback order", () => {
    __setFacesForTest([FIXED, PROP]);
    expect(faceList().map((f) => f.id)).toEqual(["fixed", "prop"]);
  });

  it("leaves a fallback-only face out of the picker but still measures with it", () => {
    __setFacesForTest([FIXED, PICTS]);
    expect(faceList().map((f) => f.id)).toEqual(["fixed"]);
    expect(measureText("★", "fixed")).toBe(11);
  });
});
