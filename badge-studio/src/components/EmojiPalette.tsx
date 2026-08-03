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

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { measureText } from "../font";
import { ledPalette } from "../led";
import { BADGE_HEIGHT, type LedColor, type TextBitmap } from "../types";

interface Props {
  /** The pictographs on offer, in face order. */
  chars: string[];
  led: LedColor;
  onPick: (c: string) => void;
}

/** Pixels per LED. Big enough to read a 11x11 sprite, small enough to fit 42. */
const CELL = 2;

/**
 * The pictographs the badge can actually draw, shown as the badge will draw
 * them.
 *
 * Drawn from the font rather than as system emoji on purpose. The set is
 * deliberately small, so the useful question is not "what does this emoji look
 * like" but "is this one of the ones that works, and does it survive at 11px".
 * A colour glyph from the operating system answers neither, and would promise
 * detail the hardware cannot show.
 */
export default function EmojiPalette({ chars, led, onPick }: Props) {
  const [bitmap, setBitmap] = useState<TextBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One render for the whole set rather than one per glyph: they are stamped
  // from the same table with the same code path the Insert button uses, so
  // what is on show cannot drift from what gets stamped.
  useEffect(() => {
    let live = true;
    invoke<TextBitmap>("render_text", { text: chars.join("") })
      .then((b) => live && setBitmap(b))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [chars]);

  if (error) return <p className="warn small">Could not draw the emoji: {error}</p>;
  if (!bitmap) return null;

  // Where each glyph starts in that single strip.
  let pen = 0;
  const slices = chars.map((c) => {
    const w = measureText(c, "");
    const at = pen;
    pen += w;
    return { c, at, w };
  });

  return (
    <div className="emoji-palette" role="group" aria-label="Emoji">
      {slices.map(({ c, at, w }) => (
        <Sprite key={c} bitmap={bitmap} at={at} w={w} led={led} onPick={() => onPick(c)} char={c} />
      ))}
    </div>
  );
}

function Sprite({
  bitmap,
  at,
  w,
  led,
  char,
  onPick,
}: {
  bitmap: TextBitmap;
  at: number;
  w: number;
  led: LedColor;
  char: string;
  onPick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * CELL * dpr;
    cv.height = BADGE_HEIGHT * CELL * dpr;
    cv.style.width = `${w * CELL}px`;
    cv.style.height = `${BADGE_HEIGHT * CELL}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, w * CELL, BADGE_HEIGHT * CELL);
    ctx.fillStyle = ledPalette(led).on;
    for (let y = 0; y < BADGE_HEIGHT; y++) {
      for (let x = 0; x < w; x++) {
        if (bitmap.rows[y]?.[at + x]) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }, [bitmap, at, w, led]);

  return (
    <button
      type="button"
      className="emoji-swatch"
      onClick={onPick}
      // The system glyph is no use as a label at this size, but it is exactly
      // what a screen reader and a tooltip want.
      title={char}
      aria-label={char}
    >
      <canvas ref={ref} />
    </button>
  );
}
