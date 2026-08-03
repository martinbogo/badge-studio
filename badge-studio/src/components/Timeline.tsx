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

import { useEffect, useRef } from "react";
import { ledPalette } from "../led";
import { BADGE_HEIGHT, type Frame, type LedColor } from "../types";

interface Props {
  frames: Frame[];
  current: number;
  /** Thumbnails are previews of the badge, so they follow the LED colour. */
  led: LedColor;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onDuplicate: (i: number) => void;
  onDelete: (i: number) => void;
  onMove: (from: number, to: number) => void;
  maxFrames: number;
  onion: boolean;
  onOnion: (v: boolean) => void;
}

function Thumb({ frame, led }: { frame: Frame; led: LedColor }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const w = frame[0]?.length ?? 48;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = BADGE_HEIGHT * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${BADGE_HEIGHT}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, w, BADGE_HEIGHT);
    ctx.fillStyle = ledPalette(led).on;
    for (let y = 0; y < BADGE_HEIGHT; y++) {
      for (let x = 0; x < w; x++) {
        if (frame[y]?.[x]) ctx.fillRect(x, y, 1, 1);
      }
    }
  }, [frame, led]);
  return <canvas ref={ref} className="thumb-canvas" />;
}

export default function Timeline({
  frames,
  current,
  led,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
  onMove,
  maxFrames,
  onion,
  onOnion,
}: Props) {
  const dragFrom = useRef<number | null>(null);
  const full = frames.length >= maxFrames;

  return (
    <div className="timeline">
      {/* Everything that acts on frames lives on the frame strip. */}
      <div className="timeline-head">
        <span className="group-tag">
          Frames {frames.length}/{maxFrames}
        </span>
        <label className="check small">
          <input
            type="checkbox"
            checked={onion}
            onChange={(e) => onOnion(e.target.checked)}
          />
          Onion skin
        </label>
        <span className="sep" />
        <button
          onClick={() => onDuplicate(current)}
          disabled={full}
          title={full ? `A slot holds ${maxFrames} frames` : "Duplicate this frame"}
        >
          Duplicate
        </button>
        <button
          onClick={() => onDelete(current)}
          disabled={frames.length <= 1}
          title="Delete this frame"
        >
          Delete
        </button>
      </div>

      <div className="timeline-strip">
        {frames.map((f, i) => (
          <div
            key={i}
            className={`frame-chip${i === current ? " active" : ""}`}
            onClick={() => onSelect(i)}
            draggable
            onDragStart={() => (dragFrom.current = i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom.current !== null && dragFrom.current !== i) {
                onMove(dragFrom.current, i);
              }
              dragFrom.current = null;
            }}
            title={`Frame ${i + 1}, drag to reorder`}
          >
            <Thumb frame={f} led={led} />
            <span className="frame-num">{i + 1}</span>
          </div>
        ))}
        <button
          className="frame-add"
          onClick={onAdd}
          disabled={full}
          title={full ? `A slot holds ${maxFrames} frames` : "Add a blank frame"}
        >
          +
        </button>
      </div>
    </div>
  );
}
