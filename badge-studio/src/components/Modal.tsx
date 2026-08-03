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

export interface ModalAction {
  label: string;
  /** The one Enter triggers and focus lands on. */
  primary?: boolean;
  /** Renders as destructive, and is never the primary. */
  danger?: boolean;
  onSelect: () => void;
}

interface Props {
  title: string;
  body?: React.ReactNode;
  actions: ModalAction[];
  /** Escape and the backdrop pick this. Omit to make the dialog unskippable. */
  onCancel?: () => void;
}

/**
 * A modal question. Deliberately not `window.confirm`: that only offers two
 * answers, and "you have unsaved changes" needs three (save, discard, cancel).
 * Losing work to a two-button dialog is exactly the failure this exists to
 * prevent.
 */
export default function Modal({ title, body, actions, onCancel }: Props) {
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primary.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onCancel) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    // Capture, so the app's own Escape handler does not clear the selection
    // behind the dialog on the way past.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        {body && <div className="modal-body">{body}</div>}
        <div className="modal-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              ref={a.primary ? primary : undefined}
              className={a.danger ? "danger" : a.primary ? "primary" : undefined}
              onClick={a.onSelect}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
