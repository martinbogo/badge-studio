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
import { platform } from "../platform";

/**
 * The menu, for hosts that do not have one.
 *
 * The desktop gets a real menu from the operating system. The browser has
 * none, so this raises exactly the same action ids and the editor cannot tell
 * which one it is talking to. Keeping the ids identical is the point: the
 * handler in App.tsx is shared, so an action added here needs no second
 * implementation, and one added to the native menu shows up here by name.
 */

interface Item {
  id: string;
  label: string;
  /** Shown as the shortcut hint. The editor already binds these itself. */
  key?: string;
}

const MENUS: { title: string; items: (Item | "separator")[] }[] = [
  {
    title: "File",
    items: [
      { id: "new-project", label: "New", key: "N" },
      { id: "open-project", label: "Open...", key: "O" },
      "separator",
      { id: "save-project", label: "Save", key: "S" },
      { id: "save-project-as", label: "Save As...", key: "⇧S" },
      "separator",
      { id: "import-message", label: "Import message..." },
      { id: "export-message", label: "Export message..." },
    ],
  },
];

export function WebMenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  // A menu that stays open after you click elsewhere reads as a stuck UI.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const fire = (id: string) => {
    setOpen(null);
    platform.fireMenu?.(id);
  };

  return (
    <div className="web-menubar" ref={bar}>
      {MENUS.map((m) => (
        <div className="web-menu" key={m.title}>
          <button
            className={open === m.title ? "web-menu-title open" : "web-menu-title"}
            onClick={() => setOpen(open === m.title ? null : m.title)}
          >
            {m.title}
          </button>
          {open === m.title && (
            <div className="web-menu-items">
              {m.items.map((it, i) =>
                it === "separator" ? (
                  <hr key={`sep${i}`} />
                ) : (
                  <button key={it.id} onClick={() => fire(it.id)}>
                    <span>{it.label}</span>
                    {it.key && <kbd>{it.key}</kbd>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
