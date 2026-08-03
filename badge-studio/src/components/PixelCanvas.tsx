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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyPoints,
  clearRect,
  ellipsePoints,
  expandBrush,
  extractRect,
  floodFillPoints,
  linePoints,
  normalizeRect,
  pasteBlock,
  rectContains,
  rectPoints,
  type Point,
  type Rect,
} from "../draw";
import { ledPalette } from "../led";
import {
  BADGE_HEIGHT,
  BADGE_WIDTH,
  type Frame,
  type LedColor,
  type Tool,
} from "../types";

interface Props {
  frame: Frame;
  /** Drawn faintly underneath, to line up successive animation frames. */
  onionFrame?: Frame | null;
  tool: Tool;
  brushSize: number;
  filled: boolean;
  selection: Rect | null;
  onSelectionChange: (r: Rect | null) => void;
  /** `history: false` folds this change into the previous undo entry. */
  onChange: (next: Frame, history: boolean) => void;
  /** Pixels beyond this are off the physical display. */
  showViewport?: boolean;
  /** Upper bound on cell size. 11 rows tall gets tall fast at large cells. */
  maxCell?: number;
  /** Which LED colour the physical badge has. */
  led: LedColor;
}

const OFF = "#141821";
const GRID = "#232936";
const VIEWPORT = "#3d7dff";
const PREVIEW = "#ffb020";
const SELECT = "#3d7dff";

type DragMode = "freehand" | "shape" | "select" | "move";

interface DragState {
  mode: DragMode;
  start: Point;
  current: Point;
  /** true paints, false erases. */
  value: boolean;
  /** Frame as it was when the drag began, for shape and move previews. */
  base: Frame;
  /** Content lifted off the canvas while moving a selection. */
  lifted?: boolean[][];
  liftedFrom?: Rect;
}

export default function PixelCanvas({
  frame,
  onionFrame,
  tool,
  brushSize,
  filled,
  selection,
  onSelectionChange,
  onChange,
  showViewport = true,
  maxCell = 26,
  led,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(16);
  const drag = useRef<DragState | null>(null);
  const lastCell = useRef<string>("");
  // Bumped on every pointer move so the preview redraws mid-drag.
  //
  // The drag lives in a ref, so mutating it changes no dependency and the
  // redraw effect would never re-run on its own. `tick` is what actually gets
  // it into that effect's dependency list. Discarding the value here silently
  // costs every live preview: shapes, the selection marquee, and the lifted
  // block while a selection is being moved.
  const [tick, setTick] = useState(0);
  const [more, setMore] = useState({ left: false, right: false });

  const width = frame[0]?.length ?? BADGE_WIDTH;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Fill the width available. The cap only stops a narrow bitmap growing so
    // tall that it crowds out the frame timeline below it; a wide one hits the
    // 5px floor first and scrolls instead.
    const fit = () => {
      const avail = el.clientWidth - 8;
      setCell(Math.max(5, Math.min(maxCell, Math.floor(avail / width))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, maxCell]);

  // Whether the bitmap continues past either edge. A canvas wider than the
  // panel scrolls, and nothing about a cropped grid of pixels says so: it just
  // looks like the drawing ends there. Recomputed on scroll and on resize
  // because both change the answer.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      // A subpixel of slack: fractional scroll positions at the far end would
      // otherwise leave the arrow showing with nothing left to reach.
      const end = el.scrollWidth - el.clientWidth;
      setMore({ left: el.scrollLeft > 1, right: el.scrollLeft < end - 1 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
    // `cell` and `width` between them decide the canvas width, so a change to
    // either can start or stop the overflow without any scrolling happening.
  }, [width, cell]);

  /** Points a shape tool would set, given the current drag. */
  const shapePoints = useCallback(
    (d: DragState): Point[] => {
      switch (tool) {
        case "line":
          return expandBrush(linePoints(d.start, d.current), brushSize);
        case "rect":
          return rectPoints(d.start, d.current, filled);
        case "ellipse":
          return ellipsePoints(d.start, d.current, filled);
        default:
          return [];
      }
    },
    [tool, brushSize, filled]
  );

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { on: ON, onion: ONION } = ledPalette(led);
    const dpr = window.devicePixelRatio || 1;
    const w = width * cell;
    const h = BADGE_HEIGHT * cell;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const d = drag.current;

    // While moving a selection the canvas shows the lifted block at its new
    // home, so what you see during the drag is what you get on release.
    let shown = frame;
    if (d?.mode === "move" && d.lifted && d.liftedFrom) {
      const dx = d.current.x - d.start.x;
      const dy = d.current.y - d.start.y;
      shown = pasteBlock(
        clearRect(d.base, d.liftedFrom),
        d.lifted,
        d.liftedFrom.x0 + dx,
        d.liftedFrom.y0 + dy,
        true
      );
    }

    const preview = d?.mode === "shape" ? shapePoints(d) : [];
    const previewSet = new Set(preview.map((p) => `${p.x},${p.y}`));

    ctx.fillStyle = OFF;
    ctx.fillRect(0, 0, w, h);

    const r = Math.max(1, Math.floor(cell * 0.36));
    const dot = (x: number, y: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * cell + cell / 2, y * cell + cell / 2, r, 0, Math.PI * 2);
      ctx.fill();
    };

    for (let y = 0; y < BADGE_HEIGHT; y++) {
      for (let x = 0; x < width; x++) {
        const inPreview = previewSet.has(`${x},${y}`);
        const on = shown[y]?.[x];
        if (inPreview) {
          dot(x, y, d!.value ? PREVIEW : OFF);
          if (!d!.value && on) {
            // Erase preview: show the pixel dimmed rather than gone.
            dot(x, y, ONION);
          }
          continue;
        }
        if (on) {
          dot(x, y, ON);
        } else if (onionFrame?.[y]?.[x]) {
          dot(x, y, ONION);
        }
      }
    }

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, h);
    }
    for (let y = 0; y <= BADGE_HEIGHT; y++) {
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(w, y * cell + 0.5);
    }
    ctx.stroke();

    if (showViewport && width > BADGE_WIDTH) {
      ctx.strokeStyle = VIEWPORT;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(1, 1, BADGE_WIDTH * cell - 2, h - 2);
      ctx.setLineDash([]);
    }

    // Selection marquee, including the in-progress one.
    let marquee: Rect | null = selection;
    if (d?.mode === "select") marquee = normalizeRect(d.start, d.current);
    if (d?.mode === "move" && d.liftedFrom) {
      const dx = d.current.x - d.start.x;
      const dy = d.current.y - d.start.y;
      marquee = {
        x0: d.liftedFrom.x0 + dx,
        y0: d.liftedFrom.y0 + dy,
        x1: d.liftedFrom.x1 + dx,
        y1: d.liftedFrom.y1 + dy,
      };
    }
    if (marquee) {
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        marquee.x0 * cell + 0.5,
        marquee.y0 * cell + 0.5,
        (marquee.x1 - marquee.x0 + 1) * cell - 1,
        (marquee.y1 - marquee.y0 + 1) * cell - 1
      );
      ctx.setLineDash([]);
    }
  }, [
    frame,
    onionFrame,
    cell,
    width,
    showViewport,
    selection,
    shapePoints,
    led,
    tick,
  ]);

  const cellAt = useCallback(
    (e: React.PointerEvent): Point | null => {
      const cv = canvasRef.current;
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left) / cell);
      const y = Math.floor((e.clientY - r.top) / cell);
      if (x < 0 || y < 0 || x >= width || y >= BADGE_HEIGHT) return null;
      return { x, y };
    },
    [cell, width]
  );

  const freehandTo = useCallback(
    (p: Point, first: boolean) => {
      const d = drag.current;
      if (!d) return;
      const key = `${p.x},${p.y}`;
      if (!first && key === lastCell.current) return;
      // Interpolate, or a fast drag leaves gaps between pointer events.
      const path = first ? [p] : linePoints(d.current, p);
      lastCell.current = key;
      d.current = p;
      onChange(applyPoints(frame, expandBrush(path, brushSize), d.value), first);
    },
    [frame, brushSize, onChange]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    const p = cellAt(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const value = e.button !== 2 && tool !== "eraser";

    if (tool === "fill") {
      onChange(applyPoints(frame, floodFillPoints(frame, p), value), true);
      return;
    }

    if (tool === "select") {
      if (selection && rectContains(selection, p)) {
        drag.current = {
          mode: "move",
          start: p,
          current: p,
          value: true,
          base: frame,
          lifted: extractRect(frame, selection),
          liftedFrom: selection,
        };
      } else {
        drag.current = {
          mode: "select",
          start: p,
          current: p,
          value: true,
          base: frame,
        };
      }
      setTick((t) => t + 1);
      return;
    }

    if (tool === "pencil" || tool === "eraser") {
      drag.current = {
        mode: "freehand",
        start: p,
        current: p,
        value,
        base: frame,
      };
      lastCell.current = "";
      freehandTo(p, true);
      return;
    }

    drag.current = { mode: "shape", start: p, current: p, value, base: frame };
    setTick((t) => t + 1);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = cellAt(e);
    if (!p) return;
    if (d.mode === "freehand") {
      freehandTo(p, false);
      return;
    }
    if (p.x === d.current.x && p.y === d.current.y) return;
    d.current = p;
    setTick((t) => t + 1);
  };

  const finish = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) {
      setTick((t) => t + 1);
      return;
    }

    if (d.mode === "shape") {
      onChange(applyPoints(d.base, shapePoints(d), d.value), true);
    } else if (d.mode === "select") {
      onSelectionChange(normalizeRect(d.start, d.current));
    } else if (d.mode === "move" && d.lifted && d.liftedFrom) {
      const dx = d.current.x - d.start.x;
      const dy = d.current.y - d.start.y;
      if (dx || dy) {
        onChange(
          pasteBlock(
            clearRect(d.base, d.liftedFrom),
            d.lifted,
            d.liftedFrom.x0 + dx,
            d.liftedFrom.y0 + dy,
            true
          ),
          true
        );
        onSelectionChange({
          x0: d.liftedFrom.x0 + dx,
          y0: d.liftedFrom.y0 + dy,
          x1: d.liftedFrom.x1 + dx,
          y1: d.liftedFrom.y1 + dy,
        });
      }
    }
    setTick((t) => t + 1);
  };

  return (
    <div className="canvas-scroller">
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={`pixel-canvas tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      {/* Hidden from assistive tech and from the pointer: purely a hint that
          the bitmap continues past the edge. Made clickable it would swallow
          the leftmost and rightmost columns of a drawing surface, which is a
          bad trade for a scroll the trackpad already does. */}
      {more.left && (
        <div className="canvas-more left" aria-hidden="true">
          <span>‹</span>
        </div>
      )}
      {more.right && (
        <div className="canvas-more right" aria-hidden="true">
          <span>›</span>
        </div>
      )}
    </div>
  );
}
