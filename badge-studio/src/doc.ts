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
  MAX_MESSAGES,
  MODES,
  type Brightness,
  type Frame,
  type Message,
  type Mode,
  type Project,
} from "./types";

/** Bumped only for changes old builds could not read. */
export const DOC_VERSION = 1;

export const PROJECT_EXT = "badge";
export const MESSAGE_EXT = "badgemsg";

export class DocError extends Error {}

interface ProjectFile {
  version: number;
  kind?: "project";
  brightness: Brightness;
  messages: Message[];
}

interface MessageFile {
  version: number;
  kind: "message";
  message: Message;
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

function validFrame(f: unknown, width: number): f is Frame {
  return (
    Array.isArray(f) &&
    f.length === BADGE_HEIGHT &&
    f.every((row) => Array.isArray(row) && row.length === width)
  );
}

/** Coerce one message, repairing what is safely repairable and rejecting the rest. */
function readMessage(raw: unknown, index: number): Message {
  const where = `Message ${index + 1}`;
  if (!raw || typeof raw !== "object") {
    throw new DocError(`${where} is not readable.`);
  }
  const m = raw as Partial<Message>;

  const mode: Mode = MODES.includes(m.mode as Mode) ? (m.mode as Mode) : "scroll_left";
  const frames = Array.isArray(m.frames) ? m.frames : [];
  if (!frames.length) {
    throw new DocError(`${where} has no frames.`);
  }

  // Trust the frames over the stored width: a hand-edited file can disagree
  // with itself, and the pixels are the thing that cannot be recomputed.
  const width = frames[0]?.[0]?.length ?? 0;
  if (width <= 0) {
    throw new DocError(`${where} has frames with no width.`);
  }
  if (!frames.every((f) => validFrame(f, width))) {
    throw new DocError(
      `${where} has frames of inconsistent size. Every frame must be ` +
        `${BADGE_HEIGHT} rows of ${width} pixels.`
    );
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
    frames: frames.map((f) => f.map((row) => row.map(Boolean))),
    width,
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
    messages: p.messages,
  };
  return JSON.stringify(doc, null, 2);
}

export function serializeMessage(m: Message): string {
  const doc: MessageFile = { version: DOC_VERSION, kind: "message", message: m };
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
