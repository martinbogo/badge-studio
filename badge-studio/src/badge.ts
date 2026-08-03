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
 * Preview simulation of the badge's display modes.
 *
 * The per-mode stepping follows the behaviour of badgemagic-app (Apache-2.0).
 * Changed from that implementation: frame timing is recalibrated, because its
 * speed curve runs 2.76x fast on this hardware, and integer division is
 * explicitly truncating rather than flooring, which fixes an off-by-one column
 * shift in fixed mode on negative offsets.
 */

import {
  BADGE_HEIGHT,
  BADGE_WIDTH,
  FRAME_WIDTH,
  type Frame,
  type Message,
  type Mode,
} from "./types";

let idCounter = 0;
export function newId(): string {
  return `m${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export function blankFrame(width: number): Frame {
  return Array.from({ length: BADGE_HEIGHT }, () =>
    Array<boolean>(width).fill(false)
  );
}

export function cloneFrame(f: Frame): Frame {
  return f.map((row) => row.slice());
}

/** Grow or crop every row to `width`, preserving existing pixels. */
export function resizeFrame(f: Frame, width: number): Frame {
  return f.map((row) => {
    if (row.length === width) return row.slice();
    if (row.length > width) return row.slice(0, width);
    return row.concat(Array<boolean>(width - row.length).fill(false));
  });
}

export function isEmpty(f: Frame): boolean {
  return f.every((row) => row.every((p) => !p));
}

/** Animation mode requires exactly FRAME_WIDTH; other modes are free-width. */
export function widthForMode(mode: Mode, current: number): number {
  return mode === "animation" ? FRAME_WIDTH : current;
}

export function newMessage(mode: Mode = "scroll_left"): Message {
  const width = mode === "animation" ? FRAME_WIDTH : BADGE_WIDTH;
  return {
    id: newId(),
    name: "Untitled",
    mode,
    speed: 4,
    blink: false,
    ants: false,
    frames: [blankFrame(width)],
    width,
  };
}

/** Overlay a bitmap onto a frame at (ox, oy), growing the frame if needed. */
export function stamp(
  frame: Frame,
  rows: boolean[][],
  ox = 0,
  oy = 0,
  replace = false
): Frame {
  const needed = Math.max(frame[0]?.length ?? 0, ox + (rows[0]?.length ?? 0));
  const out = resizeFrame(frame, needed);
  for (let y = 0; y < rows.length; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= BADGE_HEIGHT) continue;
    for (let x = 0; x < rows[y].length; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= needed) continue;
      out[ty][tx] = replace ? rows[y][x] : out[ty][tx] || rows[y][x];
    }
  }
  return out;
}

// --- transforms -----------------------------------------------------------

export function shift(f: Frame, dx: number, dy: number, wrap = true): Frame {
  const w = f[0].length;
  const out = blankFrame(w);
  for (let y = 0; y < BADGE_HEIGHT; y++) {
    for (let x = 0; x < w; x++) {
      let sy = y - dy;
      let sx = x - dx;
      if (wrap) {
        sy = ((sy % BADGE_HEIGHT) + BADGE_HEIGHT) % BADGE_HEIGHT;
        sx = ((sx % w) + w) % w;
      } else if (sy < 0 || sy >= BADGE_HEIGHT || sx < 0 || sx >= w) {
        continue;
      }
      out[y][x] = f[sy][sx];
    }
  }
  return out;
}

export function flipH(f: Frame): Frame {
  return f.map((row) => row.slice().reverse());
}

export function flipV(f: Frame): Frame {
  return f.slice().reverse().map((row) => row.slice());
}

export function invert(f: Frame): Frame {
  return f.map((row) => row.map((p) => !p));
}

// --- preview simulation ---------------------------------------------------

// These are ported from the reference Badge Magic app's own simulations
// (lib/badge_animation/*.dart), not invented. Variable names are kept close to
// the Dart so the two can be diffed. Scroll-left and animation are confirmed
// against real hardware; the rest match the reference implementation but have
// not been checked against the firmware itself.

const HOLD_DURATION = 15;

/**
 * Dart's `~/` truncates toward zero; `Math.floor` rounds toward negative
 * infinity. They agree on positives and disagree on negative odd numerators,
 * which is exactly the case when a bitmap is wider than the display and the
 * centring offset goes negative. Using floor there shifted the bitmap one
 * column left and pushed its first column off the screen.
 */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

function blankView(): Frame {
  return Array.from({ length: BADGE_HEIGHT }, () =>
    Array<boolean>(BADGE_WIDTH).fill(false)
  );
}

/** Pages, offsets and local frame for the modes that chunk wide bitmaps. */
function paging(newWidth: number, step: number, pageDuration: number) {
  const isTextTooLong = newWidth > BADGE_WIDTH;
  const totalPages = isTextTooLong
    ? Math.max(1, Math.ceil(newWidth / BADGE_WIDTH))
    : 1;
  const currentPage = isTextTooLong ? idiv(step, pageDuration) % totalPages : 0;
  return {
    isTextTooLong,
    totalPages,
    startColOffset: currentPage * BADGE_WIDTH,
    horizontalOffset: isTextTooLong ? 0 : idiv(BADGE_WIDTH - newWidth, 2),
  };
}

/**
 * Render what the badge shows at a given step, as a BADGE_HEIGHT x BADGE_WIDTH
 * window.
 */
export function renderPreview(m: Message, step: number): Frame {
  const view = blankView();
  const grid = m.frames[0] ?? blankView();
  const newWidth = grid[0]?.length ?? BADGE_WIDTH;
  const newHeight = grid.length;

  const at = (row: number, col: number): boolean =>
    row >= 0 && row < newHeight && col >= 0 && col < newWidth
      ? grid[row][col]
      : false;

  switch (m.mode) {
    case "animation": {
      // Mode 5 pages through the bitmap. Our frames are already the pages.
      const f = m.frames[step % Math.max(1, m.frames.length)] ?? grid;
      for (let y = 0; y < BADGE_HEIGHT; y++) {
        for (let x = 0; x < BADGE_WIDTH; x++) {
          view[y][x] = !!f[y]?.[x];
        }
      }
      return view;
    }

    case "scroll_left": {
      const scrollOffset = step % (newWidth + BADGE_WIDTH);
      for (let i = 0; i < BADGE_HEIGHT; i++) {
        for (let j = 0; j < BADGE_WIDTH; j++) {
          const sourceCol = j + scrollOffset - BADGE_WIDTH;
          if (sourceCol >= 0 && sourceCol < newWidth) {
            view[i][j] = at(i % newHeight, sourceCol);
          }
        }
      }
      return view;
    }

    case "scroll_right": {
      const scrollOffset = step % (newWidth + BADGE_WIDTH);
      for (let i = 0; i < BADGE_HEIGHT; i++) {
        for (let j = 0; j < BADGE_WIDTH; j++) {
          const sourceCol = newWidth - scrollOffset + j;
          if (sourceCol >= 0 && sourceCol < newWidth) {
            view[i][j] = at(i % newHeight, sourceCol);
          }
        }
      }
      return view;
    }

    case "scroll_up":
    case "scroll_down": {
      const pageDuration = BADGE_HEIGHT * 2 + HOLD_DURATION;
      const { isTextTooLong, startColOffset, horizontalOffset } = paging(
        newWidth,
        step,
        pageDuration
      );
      const localFrame = step % pageDuration;

      // Scroll in, hold still, then scroll out. The hold is what makes this
      // readable on hardware, and is what my first version was missing.
      let verticalScrollOffset: number;
      if (localFrame < BADGE_HEIGHT) {
        verticalScrollOffset = BADGE_HEIGHT - localFrame;
      } else if (localFrame < BADGE_HEIGHT + HOLD_DURATION) {
        verticalScrollOffset = 0;
      } else {
        verticalScrollOffset = -(localFrame - BADGE_HEIGHT - HOLD_DURATION);
      }

      const sign = m.mode === "scroll_up" ? -1 : 1;
      for (let i = 0; i < BADGE_HEIGHT; i++) {
        const sourceRow = i + sign * verticalScrollOffset;
        for (let j = 0; j < BADGE_WIDTH; j++) {
          const sourceCol = isTextTooLong
            ? startColOffset + j
            : j - horizontalOffset;
          view[i][j] = at(sourceRow, sourceCol);
        }
      }
      return view;
    }

    case "fixed": {
      const horizontalOffset = idiv(BADGE_WIDTH - newWidth, 2);
      for (let i = 0; i < BADGE_HEIGHT; i++) {
        for (let j = 0; j < BADGE_WIDTH; j++) {
          view[i][j] = at(i, j - horizontalOffset);
        }
      }
      return view;
    }

    case "snowflake": {
      // Rows fall in from the top, staggered two steps apart, settle, then fall
      // out the bottom in the same stagger.
      const pageDuration = BADGE_HEIGHT * 8;
      const { isTextTooLong, startColOffset, horizontalOffset } = paging(
        newWidth,
        step,
        pageDuration
      );
      const localFrame = isTextTooLong
        ? step % pageDuration
        : step % (BADGE_HEIGHT * 16);
      const srcCol = (j: number) =>
        isTextTooLong ? startColOffset + j : j - horizontalOffset;

      if (localFrame < BADGE_HEIGHT * 4) {
        for (let row = BADGE_HEIGHT - 1; row >= 0; row--) {
          let fallPosition = localFrame - (BADGE_HEIGHT - 1 - row) * 2;
          if (fallPosition >= row) fallPosition = row;
          if (fallPosition >= 0 && fallPosition < BADGE_HEIGHT) {
            for (let col = 0; col < BADGE_WIDTH; col++) {
              view[fallPosition][col] = at(row, srcCol(col));
            }
          }
        }
      } else if (localFrame < BADGE_HEIGHT * 8) {
        for (let row = BADGE_HEIGHT - 1; row >= 0; row--) {
          const fallOutStart = (BADGE_HEIGHT - 1 - row) * 2;
          const fallOutPosition =
            row + (localFrame - BADGE_HEIGHT * 4 - fallOutStart);
          if (fallOutPosition < row) {
            for (let col = 0; col < BADGE_WIDTH; col++) {
              view[row][col] = at(row, srcCol(col));
            }
          }
          if (fallOutPosition >= row && fallOutPosition < BADGE_HEIGHT) {
            for (let col = 0; col < BADGE_WIDTH; col++) view[row][col] = false;
            for (let col = 0; col < BADGE_WIDTH; col++) {
              view[fallOutPosition][col] = at(row, srcCol(col));
            }
          }
        }
      }
      return view;
    }

    case "picture": {
      // Two lit columns start at the centre and travel outward. The bitmap
      // shows between them on the way out, and outside them coming back.
      const total = BADGE_WIDTH;
      const { isTextTooLong, startColOffset, horizontalOffset } = paging(
        newWidth,
        step,
        total
      );
      const verticalOffset = idiv(BADGE_HEIGHT - newHeight, 2);
      const frame = step % total;
      const firstHalf = frame < idiv(BADGE_WIDTH, 2);

      const leftCenterCol = idiv(BADGE_WIDTH, 2) - 1;
      const rightCenterCol = idiv(BADGE_WIDTH, 2);
      const maxDistance = leftCenterCol;
      const idx = step % (maxDistance + 1);
      let leftColPos = leftCenterCol - idx;
      let rightColPos = rightCenterCol + idx;
      if (leftColPos < 0) leftColPos += BADGE_WIDTH;
      if (rightColPos >= BADGE_WIDTH) rightColPos -= BADGE_WIDTH;

      for (let i = 0; i < BADGE_HEIGHT; i++) {
        for (let j = 0; j < BADGE_WIDTH; j++) {
          const sourceRow = i - verticalOffset;
          const sourceCol = isTextTooLong
            ? startColOffset + j
            : j - horizontalOffset;
          const lineShow = j === leftColPos || j === rightColPos;
          const inside = firstHalf && j > leftColPos && j < rightColPos;
          const outside = !firstHalf && (j < leftColPos || j > rightColPos);
          view[i][j] =
            lineShow || ((inside || outside) && at(sourceRow, sourceCol));
        }
      }
      return view;
    }

    case "laser": {
      // A column advances left to right; every lit pixel in it fires a beam to
      // the right edge, and the bitmap is left standing behind. The second half
      // erases the same way, from the left.
      const total = BADGE_WIDTH * 2;
      const framesCount = Math.max(1, Math.ceil(newWidth / BADGE_WIDTH));
      const currentFrame = idiv(step, BADGE_WIDTH) % framesCount;
      const startCol = currentFrame * BADGE_WIDTH;
      const horizontalOffset = idiv(
        Math.min(Math.max(BADGE_WIDTH - newWidth, 0), BADGE_WIDTH),
        2
      );
      const frame = step % total;
      const index = frame % BADGE_WIDTH;

      if (frame < BADGE_WIDTH) {
        if (index < newWidth) {
          for (let i = 0; i < newHeight; i++) {
            if (at(i, startCol + index)) {
              for (let x = index + horizontalOffset; x < BADGE_WIDTH; x++) {
                if (x >= 0) view[i][x] = true;
              }
            }
          }
        }
        for (let i = 0; i < index; i++) {
          const x = i + horizontalOffset;
          if (x < 0 || x >= BADGE_WIDTH) continue;
          for (let j = 0; j < BADGE_HEIGHT; j++) {
            view[j][x] = at(j, startCol + i);
          }
        }
      } else if (index < newWidth) {
        for (let i = 0; i < BADGE_HEIGHT; i++) {
          for (let x = 0; x < BADGE_WIDTH; x++) {
            view[i][x] = at(i, startCol + x - horizontalOffset);
          }
        }
        for (let i = 0; i < newHeight; i++) {
          const lit = at(i, startCol + index);
          for (let x = 0; x < index + horizontalOffset && x < BADGE_WIDTH; x++) {
            view[i][x] = lit;
          }
        }
      }
      return view;
    }
  }
  return view;
}

/** Number of distinct steps before the preview repeats. */
export function previewPeriod(m: Message): number {
  const w = m.frames[0]?.[0]?.length ?? BADGE_WIDTH;
  const pages = Math.max(1, Math.ceil(w / BADGE_WIDTH));
  switch (m.mode) {
    case "animation":
      return Math.max(1, m.frames.length);
    case "fixed":
      return 1;
    case "scroll_left":
    case "scroll_right":
      return w + BADGE_WIDTH;
    case "scroll_up":
    case "scroll_down":
      return (BADGE_HEIGHT * 2 + HOLD_DURATION) * pages;
    case "snowflake":
      return w > BADGE_WIDTH ? BADGE_HEIGHT * 8 * pages : BADGE_HEIGHT * 16;
    case "picture":
      return BADGE_WIDTH * pages;
    case "laser":
      return BADGE_WIDTH * 2 * pages;
  }
  return 1;
}

/**
 * Milliseconds per preview step for a badge speed of 1..8.
 *
 * The *shape* comes from the reference app's `calculateDuration`, which
 * interpolates linearly from 200ms at speed 1 to 25ms at speed 9. The *scale*
 * comes from the physical badge: an 8-frame animation at speed 6 was timed at
 * 5 rotations in 10 seconds, i.e. 2.0s per rotation, i.e. 250 ms per frame.
 * The reference's own numbers run 2.76x too fast on this hardware, which makes
 * sense given it targets a different badge family.
 *
 * Caveats, both worth respecting before touching this again:
 *  - Only ONE point is measured (speed 6). The linear shape either side of it
 *    is inherited, not verified. If a second measurement disagrees, refit the
 *    curve rather than rescaling it.
 *  - Only ANIMATION frames were measured. Scroll steps are assumed to tick at
 *    the same rate, which is unverified.
 */
const REFERENCE_BASE_US = 200_000;
const REFERENCE_MIN_US = 25_000;

/** Measured on hardware: 250 ms per animation frame at speed 6. */
const MEASURED_MS = 250;
const MEASURED_SPEED = 6;

function referenceMs(speed: number): number {
  const us =
    REFERENCE_BASE_US -
    Math.floor(((speed - 1) * (REFERENCE_BASE_US - REFERENCE_MIN_US)) / 8);
  return us / 1000;
}

const CALIBRATION = MEASURED_MS / referenceMs(MEASURED_SPEED);

export function stepDelay(speed: number): number {
  const s = Math.min(8, Math.max(1, Math.round(speed)));
  return referenceMs(s) * CALIBRATION;
}

// --- capacity -------------------------------------------------------------

export function byteColumns(m: Message): number {
  if (m.mode === "animation") {
    return (m.frames.length * FRAME_WIDTH) / 8;
  }
  return Math.ceil((m.frames[0]?.[0]?.length ?? 0) / 8);
}

export function totalByteColumns(messages: Message[]): number {
  return messages.reduce((n, m) => n + byteColumns(m), 0);
}
