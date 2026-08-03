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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PixelCanvas from "./components/PixelCanvas";
import { ToolOptions, ToolPalette } from "./components/ToolPalette";
import Timeline from "./components/Timeline";
import BadgePreview from "./components/BadgePreview";
import TransportBar from "./components/TransportBar";
import PlaybackBar from "./components/PlaybackBar";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Modal from "./components/Modal";
import {
  previewPeriod,
  sequenceAt,
  sequenceLength,
  sequenceSlots,
  stepDelay,
} from "./badge";
import { faceList, fitText, loadFontMetrics, measureText } from "./font";
import { importImage } from "./importImage";
import {
  DocError,
  MESSAGE_EXT,
  PROJECT_EXT,
  baseName,
  parseMessage,
  parseProject,
  safeFileName,
  serializeMessage,
  serializeProject,
} from "./doc";
import {
  clearRect,
  extractRect,
  pasteBlock,
  type Rect,
} from "./draw";
import {
  byteColumns,
  blankFrame,
  cloneFrame,
  flipH,
  flipV,
  invert,
  newMessage,
  resizeFrame,
  shift,
  stamp,
} from "./badge";
import {
  BADGE_HEIGHT,
  BADGE_WIDTH,
  ANIMATION_MAX_FRAMES,
  MAX_MESSAGES,
  MAX_BYTE_COLUMNS,
  TOOLS,
  TOOL_KEYS,
  MODES,
  MODE_LABELS,
  LED_COLORS,
  LED_ORDER,
  type LedColor,
  type Frame,
  type Message,
  type Mode,
  type Project,
  type TextBitmap,
  type Tool,
} from "./types";
import "./App.css";

const MAX_FRAMES = ANIMATION_MAX_FRAMES;
const HISTORY_LIMIT = 100;
/** How long after the last edit the working copy is written for crash recovery. */
const AUTOSAVE_MS = 2000;

/** A pending modal. `recover` is asked at startup, the rest guard losing work. */
type Ask =
  | { kind: "recover"; json: string; path: string | null; savedAt: string }
  | { kind: "unsaved"; then: () => void; verb: string }
  | { kind: "quit" };

export default function App() {
  const blank = useMemo<Project>(
    () => ({ messages: [newMessage("scroll_left")], brightness: 100 }),
    []
  );
  const [project, setProject] = useState<Project>(blank);
  // Which badge you physically own, not a property of the document. Loading
  // someone else's project must not change the colour of your hardware.
  const [led, setLed] = useState<LedColor>(
    () => (localStorage.getItem("badge-led") as LedColor) || "red"
  );

  useEffect(() => {
    localStorage.setItem("badge-led", led);
  }, [led]);

  useEffect(() => {
    loadFontMetrics().then(
      () => setMetricsReady(true),
      // Not worth blocking the editor over: measuring falls back to 8px per
      // character, which is right for the face selected at startup.
      () => undefined
    );
  }, []);
  const [activeId, setActiveId] = useState<string>(() => project.messages[0].id);
  const [frameIndex, setFrameIndex] = useState(0);
  // Parked on the first frame at startup. An animation looping the moment the
  // app opens is motion nobody asked for; press play to preview it.
  const [playing, setPlaying] = useState(false);
  // Preview one message, or the whole 8-slot loop the badge actually cycles.
  const [scope, setScope] = useState<"message" | "sequence">("message");
  const [onion, setOnion] = useState(true);
  const [textInput, setTextInput] = useState("");
  // The face the next stamp uses. Not stored in the document: text becomes
  // pixels the moment it is stamped, so a project has no idea which face drew
  // it and messages can freely mix them.
  const [faceId, setFaceId] = useState("serif");
  // Bumped once the faces arrive, so anything measured before then is
  // remeasured with the real widths rather than the 8px assumption.
  const [metricsReady, setMetricsReady] = useState(false);
  const faces = useMemo(() => (metricsReady ? faceList() : []), [metricsReady]);
  const [textWarning, setTextWarning] = useState<string | null>(null);
  // Insert is a two-button group; only the open one shows its controls.
  const [insert, setInsert] = useState<"text" | "image" | null>(null);
  const [threshold, setThreshold] = useState(127);
  const [step, setStep] = useState(0);
  const [tool, setTool] = useState<Tool>("pencil");
  const [brushSize, setBrushSize] = useState(1);
  const [filled, setFilled] = useState(false);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [clipboard, setClipboard] = useState<boolean[][] | null>(null);

  // The file this document belongs to, and the exact bytes last written to it.
  // Dirtiness is a comparison rather than a flag, so undoing back to the saved
  // state correctly stops claiming there is anything to lose.
  const [docPath, setDocPath] = useState<string | null>(null);
  const [savedJson, setSavedJson] = useState<string>(() => serializeProject(blank));
  /** A question that has to be answered before anything else happens. */
  const [ask, setAsk] = useState<Ask | null>(null);

  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);

  const active = useMemo(
    () => project.messages.find((m) => m.id === activeId) ?? null,
    [project.messages, activeId]
  );

  // `history: false` folds the change into the previous undo entry. Painting a
  // stroke fires one change per pixel, and an undo stack at that granularity
  // is unusable, so only the first change of a stroke records history.
  const apply = useCallback((next: Project, history: boolean) => {
    setProject((prev) => {
      if (history) {
        past.current = [...past.current.slice(-HISTORY_LIMIT), prev];
        future.current = [];
      }
      return next;
    });
  }, []);

  const commit = useCallback(
    (next: Project) => apply(next, true),
    [apply]
  );

  const undo = useCallback(() => {
    setProject((prev) => {
      const p = past.current.pop();
      if (!p) return prev;
      future.current = [prev, ...future.current];
      return p;
    });
  }, []);

  const redo = useCallback(() => {
    setProject((prev) => {
      const [f, ...rest] = future.current;
      if (!f) return prev;
      future.current = rest;
      past.current = [...past.current, prev];
      return f;
    });
  }, []);



  useEffect(() => {
    setSelection(null);
  }, [activeId, frameIndex]);

  // Keep the selected frame in range when the message or its frames change.
  useEffect(() => {
    if (active && frameIndex >= active.frames.length) {
      setFrameIndex(Math.max(0, active.frames.length - 1));
    }
  }, [active, frameIndex]);

  const updateActive = useCallback(
    (fn: (m: Message) => Message, history = true) => {
      if (!active) return;
      apply(
        {
          ...project,
          messages: project.messages.map((m) =>
            m.id === active.id ? fn(m) : m
          ),
        },
        history
      );
    },
    [active, project, apply]
  );

  const updateFrame = useCallback(
    (fn: (f: Frame) => Frame, history = true) => {
      updateActive(
        (m) => ({
          ...m,
          frames: m.frames.map((f, i) => (i === frameIndex ? fn(f) : f)),
        }),
        history
      );
    },
    [updateActive, frameIndex]
  );

  const setMode = useCallback(
    (mode: Mode) => {
      updateActive((m) => {
        if (mode === "animation") {
          return {
            ...m,
            mode,
            width: BADGE_WIDTH,
            frames: m.frames.map((f) => resizeFrame(f, BADGE_WIDTH)),
          };
        }
        // Leaving animation mode collapses to the first frame, since every
        // other mode displays a single bitmap.
        if (m.mode === "animation") {
          return {
            ...m,
            mode,
            frames: [m.frames[0]],
            width: m.frames[0][0].length,
          };
        }
        return { ...m, mode };
      });
      setFrameIndex(0);
    },
    [updateActive]
  );

  const setWidth = useCallback(
    (width: number) => {
      const w = Math.max(8, Math.min(2000, width));
      updateActive((m) => ({
        ...m,
        width: w,
        frames: m.frames.map((f) => resizeFrame(f, w)),
      }));
    },
    [updateActive]
  );

  const insertText = useCallback(async () => {
    if (!textInput || !active) return;
    try {
      const bmp = await invoke<TextBitmap>("render_text", {
        text: textInput,
        face: faceId,
      });
      setTextWarning(
        bmp.missing.length
          ? `No glyph for ${bmp.missing.join(" ")}, replaced with "?"`
          : null
      );
      const grow = active.mode !== "animation";
      updateActive((m) => {
        const frames = m.frames.map((f, i) => {
          if (i !== frameIndex) return f;
          const base = grow ? blankFrame(bmp.width) : f;
          const out = stamp(base, bmp.rows, 0, 0, true);
          // Animation frames must stay exactly the display width.
          return grow ? out : resizeFrame(out, m.width);
        });
        return {
          ...m,
          frames,
          width: grow ? bmp.width : m.width,
          name: m.name === "Untitled" ? textInput.slice(0, 20) : m.name,
        };
      });
    } catch (e) {
      setTextWarning(String(e));
    }
  }, [textInput, faceId, active, frameIndex, updateActive]);

  const copySelection = useCallback(() => {
    if (!selection || !active) return;
    setClipboard(extractRect(active.frames[frameIndex], selection));
  }, [selection, active, frameIndex]);

  const cutSelection = useCallback(() => {
    if (!selection || !active) return;
    setClipboard(extractRect(active.frames[frameIndex], selection));
    updateFrame((f) => clearRect(f, selection));
  }, [selection, active, frameIndex, updateFrame]);

  const eraseSelection = useCallback(() => {
    if (!selection) return;
    updateFrame((f) => clearRect(f, selection));
  }, [selection, updateFrame]);

  const pasteClipboard = useCallback(() => {
    if (!clipboard) return;
    // Land it on the selection if there is one, otherwise top-left.
    const ox = selection?.x0 ?? 0;
    const oy = selection?.y0 ?? 0;
    updateFrame((f) => pasteBlock(f, clipboard, ox, oy, false));
    setSelection({
      x0: ox,
      y0: oy,
      x1: ox + (clipboard[0]?.length ?? 1) - 1,
      y1: oy + clipboard.length - 1,
    });
    setTool("select");
  }, [clipboard, selection, updateFrame]);

  const selectAll = useCallback(() => {
    if (!active) return;
    setSelection({
      x0: 0,
      y0: 0,
      x1: (active.frames[frameIndex]?.[0]?.length ?? 1) - 1,
      y1: BADGE_HEIGHT - 1,
    });
    setTool("select");
  }, [active, frameIndex]);

  /** Move the selected pixels by (dx, dy), leaving blank behind. */
  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (!selection || !active) return;
      const block = extractRect(active.frames[frameIndex], selection);
      updateFrame((f) =>
        pasteBlock(clearRect(f, selection), block, selection.x0 + dx, selection.y0 + dy, true)
      );
      setSelection({
        x0: selection.x0 + dx,
        y0: selection.y0 + dy,
        x1: selection.x1 + dx,
        y1: selection.y1 + dy,
      });
    },
    [selection, active, frameIndex, updateFrame]
  );

  /** Copy the previous frame's art into this one, the usual animation workflow. */
  const copyPreviousFrame = useCallback(() => {
    if (!active || frameIndex === 0) return;
    const prev = active.frames[frameIndex - 1];
    updateFrame(() => prev.map((row) => row.slice()));
  }, [active, frameIndex, updateFrame]);

  const slots = useMemo(
    () => sequenceSlots(project.messages),
    [project.messages]
  );

  // In sequence scope the step counts across every slot, so the message being
  // shown is whichever the playhead is inside, not the one being edited.
  const here = useMemo(
    () => (scope === "sequence" ? sequenceAt(slots, step) : null),
    [scope, slots, step]
  );
  const shown = here ? project.messages[here.slot.index] ?? active : active;
  const shownStep = here ? here.local : step;

  const period = useMemo(
    () =>
      scope === "sequence"
        ? sequenceLength(slots)
        : active
          ? previewPeriod(active)
          : 1,
    [scope, slots, active]
  );

  // Scrubbing takes the preview off the clock: dragging the bar or stepping a
  // frame while it is playing would be undone by the next interval tick.
  const scrubTo = useCallback(
    (v: number) => {
      setPlaying(false);
      setStep(Math.max(0, Math.min(period - 1, v)));
    },
    [period]
  );

  /** Jog by whole steps, wrapping, so you can go either way round the loop. */
  const scrubBy = useCallback(
    (d: number) => {
      setPlaying(false);
      setStep((s) => (((s + d) % period) + period) % period);
    },
    [period]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField =
        e.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
      if (inField) return;

      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            e.preventDefault();
            if (e.shiftKey) redo();
            else undo();
            return;
          case "c":
            e.preventDefault();
            copySelection();
            return;
          case "x":
            e.preventDefault();
            cutSelection();
            return;
          case "v":
            e.preventDefault();
            pasteClipboard();
            return;
          case "a":
            e.preventDefault();
            selectAll();
            return;
        }
        return;
      }

      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
        return;
      }
      if (e.key === "Escape") {
        setSelection(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (selection) {
          e.preventDefault();
          eraseSelection();
        }
        return;
      }

      const nudges: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      if (nudges[e.key] && selection) {
        e.preventDefault();
        nudgeSelection(...nudges[e.key]);
        return;
      }
      // With nothing selected there is nothing to nudge, so left and right jog
      // the preview instead. Up and down stay unbound.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        scrubBy(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }

      const hit = TOOLS.find((t) => TOOL_KEYS[t] === e.key.toLowerCase());
      if (hit) setTool(hit);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    undo,
    redo,
    selection,
    copySelection,
    cutSelection,
    pasteClipboard,
    selectAll,
    eraseSelection,
    nudgeSelection,
    scrubBy,
  ]);

  // --- documents ---------------------------------------------------------

  /** Replace the whole document and treat the result as freshly opened. */
  const adopt = useCallback(
    (next: Project, path: string | null) => {
      past.current = [];
      future.current = [];
      setProject(next);
      setActiveId(next.messages[0].id);
      setFrameIndex(0);
      setStep(0);
      setSelection(null);
      setDocPath(path);
      setSavedJson(serializeProject(next));
      setTextWarning(null);
    },
    []
  );

  /** Write to a known path. Returns false if the write failed. */
  const writeTo = useCallback(
    async (path: string, p: Project) => {
      const json = serializeProject(p);
      try {
        await invoke("write_text", { path, contents: json, kind: "project" });
        setDocPath(path);
        setSavedJson(json);
        // The autosave exists to survive a crash. Once the work is on disk for
        // real there is nothing left to recover, and a stale one would prompt
        // on next launch for no reason.
        await invoke("recovery_clear").catch(() => {});
        setTextWarning(`Saved to ${path}`);
        return true;
      } catch (e) {
        setTextWarning(String(e));
        return false;
      }
    },
    []
  );

  const saveProjectAs = useCallback(async () => {
    const suggested = `${safeFileName(baseName(docPath) ?? "Untitled", "Untitled")}.${PROJECT_EXT}`;
    try {
      const path = await invoke<string | null>("pick_save", {
        kind: "project",
        suggested,
      });
      if (!path) return false;
      return await writeTo(path, project);
    } catch (e) {
      setTextWarning(String(e));
      return false;
    }
  }, [docPath, project, writeTo]);

  /** Save in place, falling back to Save As for a document with no file yet. */
  const saveProject = useCallback(async () => {
    if (!docPath) return saveProjectAs();
    return writeTo(docPath, project);
  }, [docPath, project, saveProjectAs, writeTo]);

  const loadProjectFrom = useCallback(
    async (path: string) => {
      try {
        const text = await invoke<string>("read_text", { path, kind: "project" });
        adopt(parseProject(text), path);
      } catch (e) {
        setTextWarning(e instanceof DocError ? e.message : `Could not open that project: ${e}`);
      }
    },
    [adopt]
  );

  const openProject = useCallback(async () => {
    try {
      const picked = await invoke<{ path: string; text: string } | null>("pick_open", {
        kind: "project",
      });
      if (!picked) return;
      adopt(parseProject(picked.text), picked.path);
    } catch (e) {
      setTextWarning(e instanceof DocError ? e.message : `Could not open that project: ${e}`);
    }
  }, [adopt]);

  const newProject = useCallback(() => {
    adopt({ messages: [newMessage("scroll_left")], brightness: 100 }, null);
  }, [adopt]);

  // --- single messages ---------------------------------------------------

  const exportMessage = useCallback(async () => {
    if (!active) return;
    const suggested = `${safeFileName(active.name, "message")}.${MESSAGE_EXT}`;
    try {
      const path = await invoke<string | null>("pick_save", {
        kind: "message",
        suggested,
      });
      if (!path) return;
      await invoke("write_text", {
        path,
        contents: serializeMessage(active),
        kind: "message",
      });
      setTextWarning(`Exported ${active.name} to ${path}`);
    } catch (e) {
      setTextWarning(String(e));
    }
  }, [active]);

  const importMessageFrom = useCallback(
    (text: string, source: string) => {
      try {
        const m = parseMessage(text);
        if (project.messages.length >= MAX_MESSAGES) {
          throw new DocError(
            `This project already holds ${MAX_MESSAGES} messages. Delete one first.`
          );
        }
        // A fresh id, or importing the same file twice would produce two
        // messages the selection logic cannot tell apart.
        const copy: Message = { ...m, id: `m${Date.now()}` };
        commit({ ...project, messages: [...project.messages, copy] });
        setActiveId(copy.id);
        setFrameIndex(0);
        setTextWarning(`Imported ${copy.name} from ${source}`);
      } catch (e) {
        setTextWarning(e instanceof DocError ? e.message : `Could not import that: ${e}`);
      }
    },
    [project, commit]
  );

  const importMessage = useCallback(async () => {
    try {
      const picked = await invoke<{ path: string; text: string } | null>("pick_open", {
        kind: "message",
      });
      if (!picked) return;
      importMessageFrom(picked.text, picked.path);
    } catch (e) {
      setTextWarning(String(e));
    }
  }, [importMessageFrom]);

  // Byte columns still available for this message. The badge's buffer is shared
  // across all 8 slots, so what the others spend is not available here.
  const textBudget = useMemo(() => {
    const others = project.messages
      .filter((m) => m.id !== activeId)
      .reduce((n, m) => n + byteColumns(m), 0);
    return Math.max(0, MAX_BYTE_COLUMNS - others);
  }, [project.messages, activeId]);

  // The budget in the units the face measures in. A proportional face lands
  // wherever it lands and the message rounds up to a byte column at the end.
  const textBudgetPx = textBudget * 8;

  // What the typed string will actually occupy in the chosen face, asked of
  // that face rather than inferred from the string's length. See font.ts.
  const textPx = useMemo(
    () => measureText(textInput, faceId),
    [textInput, faceId, metricsReady]
  );

  const currentJson = useMemo(() => serializeProject(project), [project]);
  const dirty = currentJson !== savedJson;

  /** Run `then` once it is safe to throw the current document away. */
  const guard = useCallback(
    (verb: string, then: () => void) => {
      if (!dirty) {
        then();
        return;
      }
      setAsk({ kind: "unsaved", verb, then });
    },
    [dirty]
  );

  /** Shut down for real. Clearing the autosave is what marks the exit clean. */
  const leave = useCallback(async () => {
    await invoke("recovery_clear").catch(() => {});
    await invoke("confirm_exit").catch(() => {});
  }, []);

  /** Open a path, choosing project or message by its extension. */
  const openPath = useCallback(
    async (path: string) => {
      if (path.toLowerCase().endsWith(`.${MESSAGE_EXT}`)) {
        try {
          const text = await invoke<string>("read_text", { path, kind: "message" });
          importMessageFrom(text, path);
        } catch (e) {
          setTextWarning(String(e));
        }
        return;
      }
      await loadProjectFrom(path);
    },
    [importMessageFrom, loadProjectFrom]
  );

  // The title bar is the only always-visible place to say which file this is
  // and whether it has been saved.
  useEffect(() => {
    const name = baseName(docPath) ?? "Untitled";
    getCurrentWindow()
      .setTitle(`${dirty ? "• " : ""}${name} - Badge Studio`)
      .catch(() => {});
  }, [docPath, dirty]);

  // Autosave the working copy for crash recovery. Never writes to the user's
  // own file: an autosave that overwrote the document would turn a crash into
  // data loss. Debounced, so a drawing stroke does not hit the disk per pixel.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      invoke("recovery_write", {
        json: currentJson,
        path: docPath,
        savedAt: new Date().toISOString(),
      }).catch(() => {});
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [currentJson, dirty, docPath]);

  // Startup: a leftover autosave means the last session did not end cleanly.
  // Files the OS asked us to open win over it, since that was a deliberate act.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pending = await invoke<string[]>("take_pending_files");
        if (pending.length) {
          if (alive) await openPath(pending[0]);
          return;
        }
      } catch {
        // fall through to recovery
      }
      try {
        const rec = await invoke<{
          json: string;
          path: string | null;
          saved_at: string;
        } | null>("recovery_read");
        if (rec && alive) {
          setAsk({
            kind: "recover",
            json: rec.json,
            path: rec.path,
            savedAt: rec.saved_at,
          });
        }
      } catch {
        // A broken autosave is not worth an error on startup.
      }
    })();
    return () => {
      alive = false;
    };
    // Deliberately once, at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files opened from the OS while already running: double-click, "Open With",
  // or dropping onto the dock icon.
  useEffect(() => {
    const un = listen<string>("open-file", (e) => {
      const path = e.payload;
      if (path.toLowerCase().endsWith(`.${MESSAGE_EXT}`)) {
        // Importing adds to the document rather than replacing it, so there is
        // nothing to lose and nothing to confirm.
        void openPath(path);
      } else {
        guard("open another project", () => void openPath(path));
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [openPath, guard]);

  // Menu items act here rather than in Rust, because only this side knows
  // whether the document is dirty and therefore whether to ask first.
  useEffect(() => {
    const un = listen<string>("menu", (e) => {
      const id = e.payload;
      if (id.startsWith("open-recent:")) {
        const path = id.slice("open-recent:".length);
        if (path.toLowerCase().endsWith(`.${MESSAGE_EXT}`)) void openPath(path);
        else guard("open another project", () => void openPath(path));
        return;
      }
      switch (id) {
        case "new-project":
          guard("start a new project", newProject);
          break;
        case "open-project":
          guard("open another project", () => void openProject());
          break;
        case "save-project":
          void saveProject();
          break;
        case "save-project-as":
          void saveProjectAs();
          break;
        case "import-message":
          void importMessage();
          break;
        case "export-message":
          void exportMessage();
          break;
        case "clear-recent":
          void invoke("recent_clear");
          break;
        case "quit-app":
          if (dirty) setAsk({ kind: "quit" });
          else void leave();
          break;
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [
    guard,
    newProject,
    openProject,
    openPath,
    saveProject,
    saveProjectAs,
    importMessage,
    exportMessage,
    dirty,
    leave,
  ]);

  // Closing the window is the last chance to lose work, so it gets the same
  // guard as New and Open. Tauri will close regardless unless we prevent it.
  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested((e) => {
      e.preventDefault();
      if (dirty) setAsk({ kind: "quit" });
      else void leave();
    });
    // Quit from the menu or Cmd+Q never reaches the window's close handler,
    // and Rust holds the exit until we answer.
    const unq = listen("quit-requested", () => {
      if (dirty) setAsk({ kind: "quit" });
      else void leave();
    });
    return () => {
      un.then((f) => f());
      unq.then((f) => f());
    };
  }, [dirty, leave]);

  const importImageFile = useCallback(async () => {
    if (!active) return;
    try {
      const dataUrl = await invoke<string | null>("pick_image");
      if (!dataUrl) return;
      const asFrames = active.mode === "animation";
      const res = await importImage(dataUrl, { threshold, asFrames });
      if (asFrames && res.frames.length > MAX_FRAMES) {
        throw new Error(
          `That image is ${res.frames.length} frames wide; the badge holds ${MAX_FRAMES}.`
        );
      }
      updateActive((m) => ({
        ...m,
        frames: res.frames,
        width: res.width,
      }));
      setFrameIndex(0);
      setTextWarning(
        res.scaledFrom
          ? `Scaled from ${res.scaledFrom}px tall to 11px. ${res.frames.length} frame(s).`
          : `Imported ${res.frames.length} frame(s).`
      );
    } catch (e) {
      setTextWarning(String(e));
    }
  }, [active, threshold, updateActive]);

  const addMessage = useCallback(() => {
    if (project.messages.length >= MAX_MESSAGES) return;
    const m = newMessage("scroll_left");
    commit({ ...project, messages: [...project.messages, m] });
    setActiveId(m.id);
    setFrameIndex(0);
  }, [project, commit]);

  const removeMessage = useCallback(
    (id: string) => {
      if (project.messages.length <= 1) return;
      const rest = project.messages.filter((m) => m.id !== id);
      commit({ ...project, messages: rest });
      if (activeId === id) setActiveId(rest[0].id);
    },
    [project, commit, activeId]
  );

  useEffect(() => setStep(0), [activeId, active?.mode, scope]);

  useEffect(() => {
    if (!shown || !playing || period <= 1) return;
    const t = setInterval(
      () => setStep((s) => (s + 1) % period),
      stepDelay(shown.speed)
    );
    return () => clearInterval(t);
  }, [shown, playing, period]);

  // Only animation mode has real frames. Showing "51 / 68" for a scrolling
  // message reads as a frame count when it is really scroll position.
  const frameLabel = (() => {
    if (!shown) return null;
    const where =
      scope === "sequence" && here
        ? `${here.slot.index + 1}/${project.messages.length} · `
        : "";
    if (shown.mode === "animation") {
      return `${where}frame ${shownStep + 1} / ${shown.frames.length}`;
    }
    if (shown.mode === "fixed") return `${where}still`;
    return where ? where.replace(/ · $/, "") : null;
  })();

  const currentFrame = active?.frames[frameIndex] ?? blankFrame(BADGE_WIDTH);
  const onionFrame =
    onion && active?.mode === "animation" && frameIndex > 0
      ? active.frames[frameIndex - 1]
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Badge Studio
        </div>
        <div className="topbar-controls">
          <label title="Your badge's LED colour. Rendering only, never sent to the badge.">
            <span
              className="led-swatch"
              style={{ background: LED_COLORS[led] }}
              aria-hidden="true"
            />
            <select
              value={led}
              onChange={(e) => setLed(e.target.value as LedColor)}
            >
              {LED_ORDER.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <span className="sep" />
          {/* Duplicates of the File menu. The menu is the complete set; these
              are the two that get used constantly. */}
          <button
            onClick={() => guard("start a new project", newProject)}
            title="New project (Cmd/Ctrl+N)"
          >
            New
          </button>
          <button
            onClick={() => guard("open another project", () => void openProject())}
            title="Open a project (Cmd/Ctrl+O)"
          >
            Open
          </button>
          <button
            onClick={() => void saveProject()}
            disabled={!dirty && docPath !== null}
            title={
              docPath
                ? dirty
                  ? `Save to ${docPath} (Cmd/Ctrl+S)`
                  : "No changes since the last save"
                : "Save this project to a file (Cmd/Ctrl+S)"
            }
          >
            Save
          </button>
          <span className="sep" />
          <button onClick={undo} title="Cmd/Ctrl+Z">
            Undo
          </button>
          <button onClick={redo} title="Cmd/Ctrl+Shift+Z">
            Redo
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="panel slots">
          <h2>
            Messages
            <span className="muted small">
              {project.messages.length}/{MAX_MESSAGES}
            </span>
          </h2>
          <ul className="slot-list">
            {project.messages.map((m, i) => (
              <li
                key={m.id}
                className={[
                  m.id === activeId ? "active" : "",
                  here?.slot.index === i ? "playing" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  setActiveId(m.id);
                  setFrameIndex(0);
                }}
              >
                <span className="slot-index">{i + 1}</span>
                <span className="slot-name">{m.name}</span>
                <span className="muted small">{MODE_LABELS[m.mode]}</span>
                {project.messages.length > 1 && (
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeMessage(m.id);
                    }}
                    title="Remove message"
                  >
                    x
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            onClick={addMessage}
            disabled={project.messages.length >= MAX_MESSAGES}
          >
            Add message
          </button>
        </aside>

        <main className="editor">
          {active && (
            <>
              <div className="preview-strip">
                <BadgePreview
                  message={shown}
                  step={shownStep}
                  brightness={project.brightness}
                  playing={playing}
                  led={led}
                />
                <PlaybackBar
                  playing={playing}
                  onTogglePlay={() => setPlaying((p) => !p)}
                  onRestart={() => setStep(0)}
                  frameLabel={frameLabel}
                  step={step}
                  period={period}
                  onScrub={scrubTo}
                  onJog={scrubBy}
                  scope={scope}
                  onScope={setScope}
                  canSequence={project.messages.length > 1}
                />
              </div>

              <div className="message-props">
                <span className="group-tag">This message</span>
                <input
                  className="name-input"
                  value={active.name}
                  onChange={(e) =>
                    updateActive((m) => ({ ...m, name: e.target.value }))
                  }
                />
                <label>
                  Mode
                  <select
                    value={active.mode}
                    onChange={(e) => setMode(e.target.value as Mode)}
                  >
                    {MODES.map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Speed
                  <input
                    type="range"
                    min={1}
                    max={8}
                    value={active.speed}
                    onChange={(e) =>
                      updateActive((m) => ({
                        ...m,
                        speed: Number(e.target.value),
                      }))
                    }
                  />
                  <span className="mu tabular">{active.speed}</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={active.blink}
                    onChange={(e) =>
                      updateActive((m) => ({ ...m, blink: e.target.checked }))
                    }
                  />
                  Blink
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={active.ants}
                    onChange={(e) =>
                      updateActive((m) => ({ ...m, ants: e.target.checked }))
                    }
                  />
                  Border
                </label>
                {active.mode !== "animation" && (
                  <label>
                    Width
                    <input
                      className="num"
                      type="number"
                      min={8}
                      step={8}
                      value={active.width}
                      onChange={(e) => setWidth(Number(e.target.value))}
                    />
                    <span className="mu small">px</span>
                  </label>
                )}
              </div>

              <div className="workspace">
                <ToolPalette tool={tool} onTool={setTool} />

                <div className="workspace-main">
                  <div className="bar-row">
                    <ToolOptions
                      tool={tool}
                      brushSize={brushSize}
                      onBrushSize={setBrushSize}
                      filled={filled}
                      onFilled={setFilled}
                      hasSelection={!!selection}
                      hasClipboard={!!clipboard}
                      onCopy={copySelection}
                      onCut={cutSelection}
                      onPaste={pasteClipboard}
                      onDeleteSelection={eraseSelection}
                      onSelectAll={selectAll}
                      onClearSelection={() => setSelection(null)}
                    />
                    <span className="grow" />
                    <span className="group-tag">Insert</span>
                    <button
                      className={insert === "text" ? "active" : ""}
                      onClick={() =>
                        setInsert((v) => (v === "text" ? null : "text"))
                      }
                    >
                      Text...
                    </button>
                    <button
                      className={insert === "image" ? "active" : ""}
                      onClick={() =>
                        setInsert((v) => (v === "image" ? null : "image"))
                      }
                    >
                      Image...
                    </button>
                  </div>

                  {insert === "text" && (
                    <div className="bar-row insert-panel">
                      <input
                        autoFocus
                        placeholder="Text to stamp into this frame"
                        value={textInput}
                        onChange={(e) =>
                          setTextInput(
                            fitText(e.target.value, textBudgetPx, faceId)
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            insertText();
                            setInsert(null);
                          }
                          if (e.key === "Escape") setInsert(null);
                        }}
                      />
                      <button
                        className="primary"
                        onClick={() => {
                          insertText();
                          setInsert(null);
                        }}
                        disabled={!textInput}
                      >
                        Insert
                      </button>
                      <button onClick={() => setInsert(null)}>Cancel</button>
                      {faces.length > 1 && (
                        <select
                          value={faceId}
                          onChange={(e) => setFaceId(e.target.value)}
                          title="Typeface for this stamp. Text becomes pixels once stamped, so one message can mix faces."
                          aria-label="Typeface"
                        >
                          {faces.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <span
                        className={textPx >= textBudgetPx ? "warn small" : "mu small"}
                        title={`Width, not character count: the badge holds ${MAX_BYTE_COLUMNS * 8}px of text across all messages, and the others use ${(MAX_BYTE_COLUMNS - textBudget) * 8}px.`}
                      >
                        {textPx} / {textBudgetPx} px
                      </span>
                    </div>
                  )}

                  {insert === "image" && (
                    <div className="bar-row insert-panel">
                      <label title="Luminance above this becomes a lit pixel">
                        Threshold
                        <input
                          type="range"
                          min={0}
                          max={255}
                          value={threshold}
                          onChange={(e) => setThreshold(Number(e.target.value))}
                        />
                        <span className="mu tabular">{threshold}</span>
                      </label>
                      <button
                        className="primary"
                        onClick={() => {
                          importImageFile();
                          setInsert(null);
                        }}
                      >
                        Choose file...
                      </button>
                      <button onClick={() => setInsert(null)}>Cancel</button>
                    </div>
                  )}

                  {textWarning && <p className="warn small">{textWarning}</p>}

                  <PixelCanvas
                    frame={currentFrame}
                    onionFrame={onionFrame}
                    tool={tool}
                    brushSize={brushSize}
                    filled={filled}
                    selection={selection}
                    onSelectionChange={setSelection}
                    onChange={(f, history) => updateFrame(() => f, history)}
                    led={led}
                  />

                  <div className="bar-row">
                    <span className="group-tag">This frame</span>
                    {/* Back to a bare badge, not a blank canvas of whatever
                        width the last drawing happened to need. Clearing a
                        240px scroll otherwise leaves an empty 240px canvas and
                        a trip to the Width box to undo it.

                        Resizing the siblings cannot lose anything: extra frames
                        exist only in animation mode, where the width is already
                        the badge's own. */}
                    <button
                      onClick={() =>
                        updateActive((m) => ({
                          ...m,
                          width: BADGE_WIDTH,
                          frames: m.frames.map((f, i) =>
                            i === frameIndex
                              ? blankFrame(BADGE_WIDTH)
                              : resizeFrame(f, BADGE_WIDTH)
                          ),
                        }))
                      }
                      title={`Erase this frame and return the canvas to ${BADGE_WIDTH}x${BADGE_HEIGHT}`}
                    >
                      Clear
                    </button>
                    <button onClick={() => updateFrame(invert)}>Invert</button>
                    <button onClick={() => updateFrame(flipH)} title="Flip horizontally">
                      Flip ⇄
                    </button>
                    <button onClick={() => updateFrame(flipV)} title="Flip vertically">
                      Flip ⇅
                    </button>
                    <span className="sep" />
                    <span className="mu">Shift</span>
                    <button onClick={() => updateFrame((f) => shift(f, -1, 0))} title="Shift left">
                      ←
                    </button>
                    <button onClick={() => updateFrame((f) => shift(f, 1, 0))} title="Shift right">
                      →
                    </button>
                    <button onClick={() => updateFrame((f) => shift(f, 0, -1))} title="Shift up">
                      ↑
                    </button>
                    <button onClick={() => updateFrame((f) => shift(f, 0, 1))} title="Shift down">
                      ↓
                    </button>
                    {active.mode === "animation" && frameIndex > 0 && (
                      <>
                        <span className="sep" />
                        <button
                          onClick={copyPreviousFrame}
                          title="Replace this frame with a copy of the one before it"
                        >
                          Copy previous
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {active.mode === "animation" ? (
                <Timeline
                  frames={active.frames}
                  current={frameIndex}
                  led={led}
                  maxFrames={MAX_FRAMES}
                  onion={onion}
                  onOnion={setOnion}
                  onSelect={setFrameIndex}
                  onAdd={() => {
                    updateActive((m) => ({
                      ...m,
                      frames: [...m.frames, blankFrame(m.width)],
                    }));
                    setFrameIndex(active.frames.length);
                  }}
                  onDuplicate={(i) => {
                    updateActive((m) => {
                      const next = m.frames.slice();
                      next.splice(i + 1, 0, cloneFrame(m.frames[i]));
                      return { ...m, frames: next };
                    });
                    setFrameIndex(i + 1);
                  }}
                  onDelete={(i) => {
                    updateActive((m) => ({
                      ...m,
                      frames: m.frames.filter((_, j) => j !== i),
                    }));
                    setFrameIndex(Math.max(0, i - 1));
                  }}
                  onMove={(from, to) => {
                    updateActive((m) => {
                      const next = m.frames.slice();
                      const [f] = next.splice(from, 1);
                      next.splice(to, 0, f);
                      return { ...m, frames: next };
                    });
                    setFrameIndex(to);
                  }}
                />
              ) : (
                <p className="muted small">
                  {MODE_LABELS[active.mode]} displays a single bitmap. Switch to
                  Animation mode for frame-by-frame editing.
                </p>
              )}
            </>
          )}
        </main>

      </div>

      <TransportBar
        messages={project.messages}
        brightness={project.brightness}
        onBrightness={(b) => commit({ ...project, brightness: b })}
      />

      {ask?.kind === "unsaved" && (
        <Modal
          title={`Save changes to ${baseName(docPath) ?? "Untitled"}?`}
          body={
            <p>
              You have unsaved changes. If you {ask.verb} now they will be lost.
            </p>
          }
          onCancel={() => setAsk(null)}
          actions={[
            {
              label: "Save",
              primary: true,
              onSelect: async () => {
                const then = ask.then;
                setAsk(null);
                // Only continue if the save actually happened. A cancelled
                // Save As must not silently discard the work.
                if (await saveProject()) then();
              },
            },
            {
              label: "Discard",
              danger: true,
              onSelect: () => {
                const then = ask.then;
                setAsk(null);
                then();
              },
            },
            { label: "Cancel", onSelect: () => setAsk(null) },
          ]}
        />
      )}

      {ask?.kind === "quit" && (
        <Modal
          title={`Save changes to ${baseName(docPath) ?? "Untitled"} before closing?`}
          body={<p>You have unsaved changes. Closing now will lose them.</p>}
          onCancel={() => setAsk(null)}
          actions={[
            {
              label: "Save",
              primary: true,
              onSelect: async () => {
                if (await saveProject()) await leave();
                else setAsk(null);
              },
            },
            {
              label: "Discard",
              danger: true,
              onSelect: () => void leave(),
            },
            { label: "Cancel", onSelect: () => setAsk(null) },
          ]}
        />
      )}

      {ask?.kind === "recover" && (
        <Modal
          title="Badge Studio closed unexpectedly"
          body={
            <>
              <p>
                There is unsaved work from{" "}
                {new Date(ask.savedAt).toLocaleString()}
                {ask.path ? (
                  <>
                    {" "}
                    belonging to <strong>{baseName(ask.path)}</strong>
                  </>
                ) : (
                  " from a project that was never saved to a file"
                )}
                .
              </p>
              <p className="mu small">
                Discarding keeps whatever is already on disk and throws the
                recovered copy away.
              </p>
            </>
          }
          actions={[
            {
              label: "Restore",
              primary: true,
              onSelect: () => {
                try {
                  const p = parseProject(ask.json);
                  adopt(p, ask.path);
                  // Restored work is not yet on disk, so it must read as
                  // unsaved. Anything else invites closing without saving.
                  setSavedJson("");
                  setTextWarning(
                    ask.path
                      ? `Recovered unsaved changes to ${baseName(ask.path)}.`
                      : "Recovered an unsaved project. Use Save to give it a file."
                  );
                } catch (e) {
                  setTextWarning(
                    e instanceof DocError
                      ? `The recovered copy is unreadable: ${e.message}`
                      : String(e)
                  );
                }
                void invoke("recovery_clear").catch(() => {});
                setAsk(null);
              },
            },
            {
              label: "Discard",
              danger: true,
              onSelect: () => {
                void invoke("recovery_clear").catch(() => {});
                setAsk(null);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
