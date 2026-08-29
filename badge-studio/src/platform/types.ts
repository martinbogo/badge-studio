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
 * The seam between the editor and whatever is hosting it.
 *
 * The editor is the same code in both builds: drawing, the document model, the
 * timeline and the slot list never knew what they were running on. Only the
 * handful of things that genuinely differ live behind this interface, and the
 * two implementations sit next to each other so a new capability has an obvious
 * home on both sides rather than being reached for through `invoke` from
 * wherever it happened to be needed.
 */

import type { BadgeInfo, Frame, Mode, TextBitmap } from "../types";

/** Matches Rust's `Firmware`, serialised kebab-case. */
export type Firmware = "stock" | "badge-magic";

export interface UsbInfo {
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
  /** Read off the USB descriptors, not configured. */
  firmware: Firmware;
}

export interface FaceInfo {
  id: string;
  name: string;
  notice: string;
  /** False for a face that only exists to be fallen back to, like the emoji. */
  pickable: boolean;
  advances: [string, number][];
}

/** What the encoder needs from a message. Frames only, no identity. */
export interface MessageSpec {
  frames: Frame[];
  mode: Mode;
  speed: number;
  blink: boolean;
  ants: boolean;
}

export interface Progress {
  chunk: number;
  total: number;
}

export interface Recovery {
  json: string;
  path: string | null;
  saved_at: string;
}

export type FileKind = "project" | "message";

/**
 * A document's identity.
 *
 * Tauri has real paths. The browser has opaque handles, and the File System
 * Access API will not hand back a path for one, so "where is this file" is a
 * string the host chose rather than something either side can parse. The
 * editor only ever displays it and passes it back, so an opaque token is
 * enough, and pretending the browser has paths would be the lie that breaks
 * Save In Place.
 */
export type DocRef = string;

export interface Platform {
  readonly kind: "tauri" | "web";

  // --- fonts -------------------------------------------------------------
  fontMetrics(): Promise<FaceInfo[]>;
  renderText(text: string, face?: string): Promise<TextBitmap>;

  // --- transports --------------------------------------------------------
  usbFind(): Promise<UsbInfo | null>;
  /**
   * Ask the user to grant a badge over USB.
   *
   * Only the browser needs this. It cannot see a device until the user picks it
   * from the browser's own chooser, and that chooser opens only from a user
   * gesture, so it has to be a button rather than something that happens when
   * the cable goes in. Undefined on the desktop, where the OS just tells us.
   */
  requestUsb?(): Promise<UsbInfo | null>;
  onUsbPresence(cb: (info: UsbInfo | null) => void): () => void;
  onSendProgress(cb: (p: Progress) => void): () => void;
  bleScan(timeoutMs: number): Promise<BadgeInfo[]>;
  sendUsb(messages: MessageSpec[], brightness: number): Promise<number>;
  sendBle(
    messages: MessageSpec[],
    brightness: number,
    deviceId: string
  ): Promise<number>;

  // --- documents ---------------------------------------------------------
  pickOpen(kind: FileKind): Promise<{ path: DocRef; text: string } | null>;
  pickSave(kind: FileKind, suggested: string): Promise<DocRef | null>;
  readText(path: DocRef, kind: FileKind): Promise<string>;
  writeText(path: DocRef, contents: string, kind: FileKind): Promise<void>;
  pickImage(): Promise<string | null>;
  takePendingFiles(): Promise<DocRef[]>;

  // --- session -----------------------------------------------------------
  recentClear(): Promise<void>;
  recoveryRead(): Promise<Recovery | null>;
  recoveryWrite(json: string, path: DocRef | null, savedAt: string): Promise<void>;
  recoveryClear(): Promise<void>;

  // --- shell -------------------------------------------------------------
  setTitle(title: string): void;
  /** Let the host finish shutting down. A no-op where there is no shell. */
  confirmExit(): Promise<void>;
  onMenu(cb: (id: string) => void): () => void;
  /**
   * Raise a menu action. Only the browser needs this: it has no native menu,
   * so an in-page one stands in and the editor never learns the difference.
   */
  fireMenu?(id: string): void;
  onOpenFile(cb: (path: DocRef) => void): () => void;
  /**
   * The host wants to close. Returning without calling `confirmExit` holds it.
   * In the browser this is `beforeunload`, which cannot ask a question, so it
   * can only prompt with the browser's own wording.
   */
  onExitRequested(cb: () => void): () => void;
}
