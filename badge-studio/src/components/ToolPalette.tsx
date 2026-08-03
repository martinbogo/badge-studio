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

import {
  SHAPE_TOOLS,
  TOOLS,
  TOOL_KEYS,
  TOOL_LABELS,
  type Tool,
} from "../types";

/** Compact glyphs; the badge display is monochrome so these stay abstract. */
const ICONS: Record<Tool, string> = {
  pencil: "✎",
  eraser: "⌫",
  line: "╱",
  rect: "▭",
  ellipse: "◯",
  fill: "▧",
  select: "⬚",
};

const BRUSH_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["pencil", "eraser", "line"]);

/** Vertical strip beside the canvas, the way pixel editors normally do it. */
export function ToolPalette({
  tool,
  onTool,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
}) {
  return (
    <div className="tool-palette" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button
          key={t}
          className={`tool-btn${t === tool ? " active" : ""}`}
          onClick={() => onTool(t)}
          title={`${TOOL_LABELS[t]}  (${TOOL_KEYS[t].toUpperCase()})`}
          aria-pressed={t === tool}
        >
          <span className="tool-icon">{ICONS[t]}</span>
        </button>
      ))}
    </div>
  );
}

interface OptionProps {
  tool: Tool;
  brushSize: number;
  onBrushSize: (n: number) => void;
  filled: boolean;
  onFilled: (v: boolean) => void;
  hasSelection: boolean;
  hasClipboard: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDeleteSelection: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}

/** Settings for whichever tool is active. Sits directly above the canvas. */
export function ToolOptions({
  tool,
  brushSize,
  onBrushSize,
  filled,
  onFilled,
  hasSelection,
  hasClipboard,
  onCut,
  onCopy,
  onPaste,
  onDeleteSelection,
  onSelectAll,
  onClearSelection,
}: OptionProps) {
  return (
    <>
      <span className="group-tag">{TOOL_LABELS[tool]}</span>

      {BRUSH_TOOLS.has(tool) && (
        <label>
          Size
          <select
            value={brushSize}
            onChange={(e) => onBrushSize(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}px
              </option>
            ))}
          </select>
        </label>
      )}

      {SHAPE_TOOLS.has(tool) && (
        <label className="check">
          <input
            type="checkbox"
            checked={filled}
            onChange={(e) => onFilled(e.target.checked)}
          />
          Filled
        </label>
      )}

      {tool === "select" && (
        <>
          <button onClick={onSelectAll}>All</button>
          <button onClick={onCopy} disabled={!hasSelection}>
            Copy
          </button>
          <button onClick={onCut} disabled={!hasSelection}>
            Cut
          </button>
          <button onClick={onPaste} disabled={!hasClipboard}>
            Paste
          </button>
          <button onClick={onDeleteSelection} disabled={!hasSelection}>
            Erase
          </button>
          <button onClick={onClearSelection} disabled={!hasSelection}>
            Deselect
          </button>
        </>
      )}

      {tool === "select" && hasSelection && (
        <span className="mu small">Drag inside to move, arrows to nudge</span>
      )}
      {tool === "fill" && (
        <span className="mu small">Right-click clears the region</span>
      )}
    </>
  );
}
