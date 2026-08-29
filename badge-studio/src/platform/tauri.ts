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
 * The desktop host. Every method here is the call the editor used to make
 * inline, moved rather than rewritten, so the desktop build behaves exactly as
 * it did before the web build existed.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BadgeInfo, TextBitmap } from "../types";
import type {
  DocRef,
  FaceInfo,
  Platform,
  Progress,
  Recovery,
  UsbInfo,
} from "./types";

/** Tauri's unlisten is a promise; the editor wants a plain unsubscribe. */
const sub = <T,>(name: string, cb: (payload: T) => void) => {
  const un = listen<T>(name, (e) => cb(e.payload));
  return () => {
    void un.then((f) => f());
  };
};

export const platform: Platform = {
  kind: "tauri",

  fontMetrics: () => invoke<FaceInfo[]>("font_metrics"),
  renderText: (text, face) => invoke<TextBitmap>("render_text", { text, face }),

  usbFind: () => invoke<UsbInfo | null>("usb_find"),
  onUsbPresence: (cb) => sub<UsbInfo | null>("usb-presence", cb),
  onSendProgress: (cb) => sub<Progress>("send-progress", cb),
  bleScan: (timeoutMs) => invoke<BadgeInfo[]>("ble_scan", { timeoutMs }),
  sendUsb: (messages, brightness) =>
    invoke<number>("send_to_badge_usb", { messages, brightness }),
  sendBle: (messages, brightness, deviceId) =>
    invoke<number>("send_to_badge", { messages, brightness, deviceId }),

  pickOpen: (kind) =>
    invoke<{ path: string; text: string } | null>("pick_open", { kind }),
  pickSave: (kind, suggested) =>
    invoke<string | null>("pick_save", { kind, suggested }),
  readText: (path, kind) => invoke<string>("read_text", { path, kind }),
  writeText: (path, contents, kind) =>
    invoke<void>("write_text", { path, contents, kind }),
  pickImage: () => invoke<string | null>("pick_image"),
  takePendingFiles: () => invoke<string[]>("take_pending_files"),

  recentClear: () => invoke<void>("recent_clear"),
  recoveryRead: () => invoke<Recovery | null>("recovery_read"),
  recoveryWrite: (json, path, savedAt) =>
    invoke<void>("recovery_write", { json, path, savedAt }),
  recoveryClear: () => invoke<void>("recovery_clear"),

  setTitle: (title) => {
    void getCurrentWindow().setTitle(title).catch(() => {});
  },
  confirmExit: () => invoke<void>("confirm_exit"),
  onMenu: (cb) => sub<string>("menu", cb),
  onOpenFile: (cb) => sub<DocRef>("open-file", cb),
  onExitRequested: (cb) => {
    // Tauri closes regardless unless the close request is prevented, and a
    // menu Quit or Cmd+Q never reaches the window handler at all, so both
    // paths have to be held.
    const w = getCurrentWindow();
    const un = w.onCloseRequested((e) => {
      e.preventDefault();
      cb();
    });
    const unq = sub("quit-requested", cb);
    return () => {
      void un.then((f) => f());
      unq();
    };
  },
};
