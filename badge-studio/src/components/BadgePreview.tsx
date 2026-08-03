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
import { renderPreview } from "../badge";
import { ledPalette } from "../led";
import {
  BADGE_HEIGHT,
  BADGE_WIDTH,
  HARDWARE_VERIFIED,
  type Brightness,
  type LedColor,
  type Message,
} from "../types";

/** Padding around the LED grid, in CSS pixels. */
const PAD = 8;

interface Props {
  message: Message | null;
  /** Animation step, owned by the app so the transport bar can drive it. */
  step: number;
  brightness: Brightness;
  playing: boolean;
  /** Which LED colour the physical badge has. */
  led: LedColor;
  /** Upper bound on LED size, so the preview does not grow absurdly wide. */
  maxCell?: number;
}

/** Physical badge simulation, at the message's own speed. */
export default function BadgePreview({
  message,
  step,
  brightness,
  playing,
  led,
  maxCell = 14,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(6);

  // The badge's LEDs are mounted tilted, which makes the physical pixel pitch
  // essentially square. So the preview must scale both axes by the same factor;
  // letting CSS clamp the width alone would squash every pixel horizontally.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const avail = el.clientWidth - PAD * 2;
      setCell(Math.max(3, Math.min(maxCell, Math.floor(avail / BADGE_WIDTH))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxCell]);

  // The badge blinks the whole message; drive that off wall clock so it stays
  // independent of the animation step rate.
  const [blinkOn, setBlinkOn] = useState(true);
  useEffect(() => {
    if (!message?.blink || !playing) {
      setBlinkOn(true);
      return;
    }
    const t = setInterval(() => setBlinkOn((b) => !b), 400);
    return () => clearInterval(t);
  }, [message?.blink, playing]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const pad = PAD;
    const w = BADGE_WIDTH * cell + pad * 2;
    const h = BADGE_HEIGHT * cell + pad * 2;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#0a0c11";
    ctx.fillRect(0, 0, w, h);

    const view = message ? renderPreview(message, step) : null;
    const pal = ledPalette(led);
    const alpha = brightness / 100;
    const r = cell * 0.34;

    for (let y = 0; y < BADGE_HEIGHT; y++) {
      for (let x = 0; x < BADGE_WIDTH; x++) {
        const cx = pad + x * cell + cell / 2;
        const cy = pad + y * cell + cell / 2;
        const lit = !!view?.[y]?.[x] && blinkOn;
        if (lit) {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
          g.addColorStop(0, `rgba(${pal.rgb}, ${alpha})`);
          g.addColorStop(1, `rgba(${pal.rgb}, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = lit ? pal.core : "#1a1d26";
        ctx.globalAlpha = lit ? 0.55 + 0.45 * alpha : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (message?.ants) {
      // Animated border marches around the display edge.
      ctx.fillStyle = pal.on;
      const phase = step % 4;
      const dot = Math.max(2, Math.round(cell * 0.25));
      for (let x = 0; x < BADGE_WIDTH; x++) {
        if ((x + phase) % 4 === 0) {
          ctx.fillRect(pad + x * cell + cell / 2 - dot / 2, pad / 2 - dot / 2, dot, dot);
          ctx.fillRect(
            pad + x * cell + cell / 2 - dot / 2,
            h - pad / 2 - dot / 2,
            dot,
            dot
          );
        }
      }
    }
  }, [message, step, brightness, blinkOn, cell, led]);

  const unverified = message && !HARDWARE_VERIFIED.has(message.mode);

  return (
    <div className="preview" ref={wrapRef}>
      <canvas ref={canvasRef} className="preview-canvas" />
      <div className="preview-meta">
        {message ? (
          <>
            {unverified && (
              <span
                title="Ported from the reference app's own simulation of this effect, but not yet watched running on the physical badge."
              >
                not hardware-checked
              </span>
            )}
          </>
        ) : (
          <span>no message selected</span>
        )}
      </div>
    </div>
  );
}
