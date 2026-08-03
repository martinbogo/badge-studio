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

import { useCallback, useRef, useState } from "react";
import { nextSelection } from "../badge";
import { MODE_LABELS, type Message } from "../types";

interface Props {
  messages: Message[];
  activeId: string;
  /** Which slot the sequence preview is currently showing, if any. */
  playing: number | null;
  selected: Set<string>;
  onSelected: (ids: Set<string>) => void;
  onActivate: (id: string) => void;
  onReorder: (ids: Set<string>, gap: number) => void;
  onToggleEnabled: (id: string) => void;
  onRemove: (id: string) => void;
}

/** Pointer travel before a press becomes a drag rather than a click. */
const SLOP = 4;

interface Drag {
  pointer: number;
  originY: number;
  ids: Set<string>;
  moved: boolean;
  gap: number;
}

/**
 * The eight message slots: reorderable, multi-selectable, individually
 * switchable.
 *
 * Reordering is driven by pointer events rather than HTML5 drag and drop. The
 * window has Tauri's native file drop enabled, so page-level drag events are
 * competing with the webview's own handling of a dragged file, and the three
 * webviews this app ships on do not agree about who wins. Pointer events
 * behave the same everywhere and cost a drop indicator's worth of extra code.
 */
export default function SlotList({
  messages,
  activeId,
  playing,
  selected,
  onSelected,
  onActivate,
  onReorder,
  onToggleEnabled,
  onRemove,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const drag = useRef<Drag | null>(null);
  const anchor = useRef<string | null>(null);
  const [gap, setGap] = useState<number | null>(null);

  /** The gap the pointer is nearest, in original-list coordinates. */
  const gapAt = useCallback((clientY: number) => {
    const ul = listRef.current;
    if (!ul) return 0;
    const items = [...ul.querySelectorAll("li")];
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return items.length;
  }, []);

  const pick = useCallback(
    (m: Message, e: React.PointerEvent | React.MouseEvent) => {
      const r = nextSelection(
        messages.map((x) => x.id),
        selected,
        anchor.current,
        m.id,
        { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }
      );
      onSelected(r.selected);
      anchor.current = r.anchor;
    },
    [messages, selected, onSelected]
  );

  const onPointerDown = (m: Message, e: React.PointerEvent<HTMLLIElement>) => {
    // Let the buttons inside a row do their own thing.
    if ((e.target as HTMLElement).closest("button,input")) return;
    if (e.button !== 0) return;

    // Dragging a row that is already part of the selection moves the whole
    // selection. Dragging any other row is a fresh single-row drag, which is
    // what makes grabbing an unselected slot feel like picking it up rather
    // than dropping everything else on it.
    const ids = selected.has(m.id) && selected.size > 1
      ? new Set(selected)
      : new Set([m.id]);

    drag.current = { pointer: e.pointerId, originY: e.clientY, ids, moved: false, gap: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLLIElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientY - d.originY) < SLOP) return;
    d.moved = true;
    d.gap = gapAt(e.clientY);
    setGap(d.gap);
  };

  const finish = (m: Message, e: React.PointerEvent<HTMLLIElement>) => {
    const d = drag.current;
    drag.current = null;
    setGap(null);
    if (!d || d.pointer !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (d.moved) {
      onReorder(d.ids, d.gap);
      return;
    }
    // A press that never became a drag is a click.
    pick(m, e);
    onActivate(m.id);
  };

  /** Alt+Up/Down moves the selection, so reordering works without a mouse. */
  const onKeyDown = (m: Message, e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const ids = selected.has(m.id) ? new Set(selected) : new Set([m.id]);
    const idx = messages.findIndex((x) => x.id === m.id);
    const to = e.key === "ArrowUp" ? Math.max(0, idx - 1) : Math.min(messages.length, idx + 2);
    onReorder(ids, to);
  };

  const dragging = drag.current?.moved ? drag.current.ids : null;

  return (
    <ul className="slot-list" ref={listRef}>
      {messages.map((m, i) => (
        <li
          key={m.id}
          tabIndex={0}
          className={[
            m.id === activeId ? "active" : "",
            playing === i ? "playing" : "",
            selected.has(m.id) ? "selected" : "",
            m.enabled === false ? "off" : "",
            dragging?.has(m.id) ? "lifting" : "",
            gap === i ? "drop-above" : "",
            gap === messages.length && i === messages.length - 1 ? "drop-below" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onPointerDown={(e) => onPointerDown(m, e)}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(m, e)}
          onPointerCancel={() => {
            drag.current = null;
            setGap(null);
          }}
          onKeyDown={(e) => onKeyDown(m, e)}
        >
          <span className="slot-index">{i + 1}</span>
          <span className="slot-name">{m.name}</span>
          <span className="muted small">{MODE_LABELS[m.mode]}</span>
          <button
            className="ghost slot-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggleEnabled(m.id);
            }}
            title={
              m.enabled === false
                ? "Off. Kept in the project but not sent to the badge."
                : "On. Click to keep it here but leave it out of the upload."
            }
            aria-pressed={m.enabled !== false}
          >
            {m.enabled === false ? "○" : "●"}
          </button>
          {messages.length > 1 && (
            <button
              className="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(m.id);
              }}
              title="Remove message"
            >
              x
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
