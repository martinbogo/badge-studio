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

import { BADGE_HEIGHT, FRAME_WIDTH, type Frame } from "./types";

export interface ImportOptions {
  /** Luminance above this counts as a lit pixel, 0..255. */
  threshold: number;
  /** Split the image into fixed-width frames instead of one wide bitmap. */
  asFrames: boolean;
}

export interface ImportResult {
  frames: Frame[];
  /** Width of each returned frame, in pixels. */
  width: number;
  /** Set when the source height was not 11 and had to be scaled. */
  scaledFrom?: number;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode that image."));
    img.src = dataUrl;
  });
}

/**
 * Convert an image into badge frames.
 *
 * Images that are not 11px tall are scaled to fit, preserving aspect ratio.
 * In frame mode the image is cut into FRAME_WIDTH-wide slices, which is the
 * filmstrip convention the badge firmware expects for mode 5.
 */
export async function importImage(
  dataUrl: string,
  opts: ImportOptions
): Promise<ImportResult> {
  const img = await loadImage(dataUrl);
  if (!img.width || !img.height) {
    throw new Error("That image has no pixels.");
  }

  const scaledFrom = img.height === BADGE_HEIGHT ? undefined : img.height;
  const scale = BADGE_HEIGHT / img.height;
  const width = Math.max(1, Math.round(img.width * scale));

  const cv = document.createElement("canvas");
  cv.width = width;
  cv.height = BADGE_HEIGHT;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get a 2D canvas context.");
  // Nearest-neighbour keeps pixel art crisp; smoothing turns it to mush at 11px.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, width, BADGE_HEIGHT);

  const { data } = ctx.getImageData(0, 0, width, BADGE_HEIGHT);
  const lit = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4;
    const a = data[i + 3];
    if (a < 128) return false;
    // Rec. 601 luma, which tracks perceived brightness better than a mean.
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return l > opts.threshold;
  };

  if (!opts.asFrames) {
    const frame: Frame = Array.from({ length: BADGE_HEIGHT }, (_, y) =>
      Array.from({ length: width }, (_, x) => lit(x, y))
    );
    return { frames: [frame], width, scaledFrom };
  }

  const count = Math.max(1, Math.ceil(width / FRAME_WIDTH));
  const frames: Frame[] = [];
  for (let f = 0; f < count; f++) {
    frames.push(
      Array.from({ length: BADGE_HEIGHT }, (_, y) =>
        Array.from({ length: FRAME_WIDTH }, (_, x) => {
          const sx = f * FRAME_WIDTH + x;
          return sx < width ? lit(sx, y) : false;
        })
      )
    );
  }
  return { frames, width: FRAME_WIDTH, scaledFrom };
}
