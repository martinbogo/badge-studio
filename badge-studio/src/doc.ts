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
 * Reading and writing documents.
 *
 * Everything on disk is JSON. Two extensions distinguish what the JSON *is*:
 * a `.badge` file is a whole project and replaces the document, a `.badgemsg`
 * file is one message and is inserted into it. Double-clicking a file should
 * never leave you wondering which of those just happened.
 *
 * Files arrive from three places: a file picker, the OS (double-click, "Open
 * With", drag onto the window), and the crash-recovery autosave. All three go
 * through `parseProject` / `parseMessage`, because a file that was hand-edited,
 * truncated by the crash we are recovering from, or written by a future version
 * has to produce a sentence the user can act on rather than a blank window.
 */
import {
  ANIMATION_MAX_FRAMES,
  BADGE_HEIGHT,
  BADGE_WIDTH,
  MAX_MESSAGES,
  MODES,
  type Brightness,
  type Frame,
  type Message,
  type Mode,
  type Project,
} from "./types";

/**
 * Bumped only for changes old builds could not read.
 *
 * Version 2 stores a frame as eleven strings of `.` and `#` rather than as
 * arrays of `true` and `false`. A pretty-printed boolean array puts every
 * pixel on its own line, so a full badge came to 584 KB of mostly the word
 * "false"; the same document is 42 KB as rows. Strings rather than packed
 * base64 because a `.badge` is a document people share and diff, and this way
 * the art is legible in a text editor, the same choice `fonts/*.face` makes.
 */
export const DOC_VERSION = 2;

/** A frame on disk in version 2: one string per row, `#` lit and `.` dark. */
const LIT = "#";
const DARK = ".";

export const PROJECT_EXT = "badge";
export const MESSAGE_EXT = "badgemsg";

export class DocError extends Error {}

/** A message as written, which is not quite a `Message`. */
interface StoredMessage {
  id: string;
  name: string;
  mode: Mode;
  speed: number;
  frames: string[][];
  /** Omitted when false. */
  blink?: boolean;
  ants?: boolean;
  /** Omitted when true, which is the overwhelmingly common case. */
  enabled?: boolean;
}

interface ProjectFile {
  version: number;
  kind?: "project";
  brightness: Brightness;
  messages: StoredMessage[];
}

interface MessageFile {
  version: number;
  kind: "message";
  message: StoredMessage;
}

/**
 * A message ready to write.
 *
 * `width` is not stored: it is the length of a row, so keeping a copy only
 * creates something that can disagree with the pixels. The flags are left out
 * at their defaults, which shortens the common message to five fields.
 */
function storeMessage(m: Message): StoredMessage {
  const out: StoredMessage = {
    id: m.id,
    name: m.name,
    mode: m.mode,
    speed: m.speed,
    frames: m.frames.map(encodeFrame),
  };
  if (m.blink) out.blink = true;
  if (m.ants) out.ants = true;
  if (m.enabled === false) out.enabled = false;
  return out;
}

function checkVersion(v: unknown, what: string) {
  if (typeof v !== "number") {
    throw new DocError(`This does not look like a Badge Studio ${what}.`);
  }
  if (v > DOC_VERSION) {
    throw new DocError(
      `This ${what} was written by a newer version of Badge Studio ` +
        `(format ${v}, this build reads ${DOC_VERSION}). Update the app to open it.`
    );
  }
}

function encodeFrame(f: Frame): string[] {
  return f.map((row) => row.map((p) => (p ? LIT : DARK)).join(""));
}

/**
 * Read one frame, in either format.
 *
 * Detected per frame rather than from the version number alone: a document
 * that has been hand-edited or half-converted should still open, and the two
 * shapes are not confusable. Returns null if this is not a frame at all.
 */
function decodeFrame(f: unknown, where: string): Frame | null {
  if (!Array.isArray(f) || f.length !== BADGE_HEIGHT) return null;

  if (f.every((row) => typeof row === "string")) {
    const rows = f as string[];
    return rows.map((row) => {
      for (const c of row) {
        if (c !== LIT && c !== DARK && c !== "1" && c !== "0") {
          throw new DocError(
            `${where} has a pixel row containing ${JSON.stringify(c)}. ` +
              `Rows use "${LIT}" for a lit pixel and "${DARK}" for a dark one.`
          );
        }
      }
      return [...row].map((c) => c === LIT || c === "1");
    });
  }

  if (f.every((row) => Array.isArray(row))) {
    return (f as unknown[][]).map((row) => row.map(Boolean));
  }
  return null;
}

/** Coerce one message, repairing what is safely repairable and rejecting the rest. */
function readMessage(raw: unknown, index: number): Message {
  const where = `Message ${index + 1}`;
  if (!raw || typeof raw !== "object") {
    throw new DocError(`${where} is not readable.`);
  }
  const m = raw as Partial<Message>;

  const mode: Mode = MODES.includes(m.mode as Mode) ? (m.mode as Mode) : "scroll_left";
  const rawFrames = Array.isArray(m.frames) ? (m.frames as unknown[]) : [];
  if (!rawFrames.length) {
    throw new DocError(`${where} has no frames.`);
  }

  const decoded = rawFrames.map((f) => decodeFrame(f, where));
  if (decoded.some((f) => f === null)) {
    throw new DocError(
      `${where} has a frame that is not ${BADGE_HEIGHT} rows of pixels.`
    );
  }
  const frames = decoded as Frame[];

  // Trust the frames over any stored width: a hand-edited file can disagree
  // with itself, and the pixels are the thing that cannot be recomputed.
  const width = frames[0]?.[0]?.length ?? 0;
  if (width <= 0) {
    throw new DocError(`${where} has frames with no width.`);
  }
  if (!frames.every((f) => f.every((row) => row.length === width))) {
    throw new DocError(
      `${where} has frames of inconsistent size. Every frame must be ` +
        `${BADGE_HEIGHT} rows of ${width} pixels.`
    );
  }
  // Projects saved before the editor moved to display width hold 48px frames,
  // the last four columns of which the badge cannot show. Trim them so what is
  // on screen is what will appear.
  let out: Frame[] = frames;
  let w = width;
  if (mode === "animation" && w > BADGE_WIDTH) {
    out = out.map((f) => f.map((row) => row.slice(0, BADGE_WIDTH)));
    w = BADGE_WIDTH;
  }

  if (mode === "animation" && frames.length > ANIMATION_MAX_FRAMES) {
    throw new DocError(
      `${where} has ${frames.length} frames; a slot holds ${ANIMATION_MAX_FRAMES}.`
    );
  }

  return {
    id: typeof m.id === "string" && m.id ? m.id : `m${Date.now()}${index}`,
    name: typeof m.name === "string" ? m.name : `Message ${index + 1}`,
    mode,
    speed: typeof m.speed === "number" && m.speed >= 1 && m.speed <= 8 ? m.speed : 4,
    blink: Boolean(m.blink),
    ants: Boolean(m.ants),
    frames: out,
    width: w,
    // Absent in documents written before slots could be switched off, and a
    // slot nobody disabled is an enabled one.
    enabled: m.enabled === undefined ? true : Boolean(m.enabled),
  };
}

export function parseProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DocError("That file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object") {
    throw new DocError("That file is empty or not a project.");
  }
  const doc = raw as Partial<Omit<ProjectFile, "kind">> & { kind?: string };
  if (doc.kind === "message") {
    throw new DocError(
      `That is a single message, not a project. Use File > Import Message to ` +
        `add it to the current project.`
    );
  }
  checkVersion(doc.version, "project");

  const list = Array.isArray(doc.messages) ? doc.messages : [];
  if (!list.length) {
    throw new DocError("That project has no messages in it.");
  }
  if (list.length > MAX_MESSAGES) {
    throw new DocError(
      `That project has ${list.length} messages; the badge holds ${MAX_MESSAGES}.`
    );
  }

  const brightness: Brightness = ([25, 50, 75, 100] as number[]).includes(
    doc.brightness as number
  )
    ? (doc.brightness as Brightness)
    : 100;

  return { brightness, messages: list.map(readMessage) };
}

export function parseMessage(text: string): Message {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DocError("That file is not valid JSON.");
  }
  const doc = raw as Partial<MessageFile> & { kind?: string; messages?: unknown[] };
  if (doc.kind !== "message") {
    // A project dropped on the import path is a likely enough slip to name.
    if (Array.isArray(doc.messages)) {
      throw new DocError(
        "That is a whole project, not a single message. Use File > Open Project."
      );
    }
    throw new DocError("That does not look like a Badge Studio message.");
  }
  checkVersion(doc.version, "message");
  return readMessage(doc.message, 0);
}

export function serializeProject(p: Project): string {
  const doc: ProjectFile = {
    version: DOC_VERSION,
    kind: "project",
    brightness: p.brightness,
    messages: p.messages.map(storeMessage),
  };
  return JSON.stringify(doc, null, 2);
}

export function serializeMessage(m: Message): string {
  const doc: MessageFile = {
    version: DOC_VERSION,
    kind: "message",
    message: storeMessage(m),
  };
  return JSON.stringify(doc, null, 2);
}

/** The filename without directories or extension, for titles and Save As. */
export function baseName(path: string | null): string | null {
  if (!path) return null;
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.(badge|badgemsg)$/i, "");
}

/** Strip characters that are awkward in filenames on some platform or other. */
export function safeFileName(name: string, fallback: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, "").trim();
  return clean || fallback;
}
