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

export const BADGE_HEIGHT = 11;
export const BADGE_WIDTH = 44;
/** Animation frames are 48px wide even though the display is 44px. */
export const FRAME_WIDTH = 48;
export const MAX_MESSAGES = 8;
/**
 * Theoretical ceiling from the 8192-byte buffer. Inherited from the USB-HID
 * lineage of this protocol and NOT reachable over BLE on this hardware.
 * Must match protocol.rs::MAX_BYTE_COLUMNS.
 */
export const MAX_BYTE_COLUMNS = 738;

/**
 * Animation frames per message slot. With 8 slots that the badge cycles, the
 * full sequence is 8 x 8 = 64 frames, confirmed on hardware.
 */
export const ANIMATION_MAX_FRAMES = 8;

/**
 * Largest payload confirmed to transfer over BLE: all 8 slots at 8 frames each,
 * 4288 bytes over 268 writes.
 *
 * Earlier stalls at 1648 and 4024 bytes were NOT a size limit. The badge had
 * dropped out of Bluetooth mode mid-transfer, which is a timing failure that
 * varies with signal strength and how long the badge has been advertising. A
 * payload this size transfers given a clean window.
 *
 * A soft ceiling, not a hard one: it only drives the capacity meter's warning.
 * The hard limit the encoder enforces is MAX_BYTE_COLUMNS. There is no Rust
 * counterpart to this constant for that reason.
 */
export const KNOWN_GOOD_COLUMNS = 384;

export const MODES = [
  "scroll_left",
  "scroll_right",
  "scroll_up",
  "scroll_down",
  "fixed",
  "animation",
  "snowflake",
  "picture",
  "laser",
] as const;

export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  scroll_left: "Scroll left",
  scroll_right: "Scroll right",
  scroll_up: "Scroll up",
  scroll_down: "Scroll down",
  fixed: "Fixed",
  animation: "Animation",
  snowflake: "Snowflake",
  picture: "Picture",
  laser: "Laser",
};

/** 11 rows of booleans, each row `width` long. */
export type Frame = boolean[][];

export interface Message {
  id: string;
  name: string;
  mode: Mode;
  /** 1..8 */
  speed: number;
  blink: boolean;
  ants: boolean;
  frames: Frame[];
  /** Pixel width of every frame in this message. */
  width: number;
}

export type Brightness = 25 | 50 | 75 | 100;

export interface Project {
  messages: Message[];
  brightness: Brightness;
}

export interface BadgeInfo {
  id: string;
  name: string | null;
  rssi: number | null;
  services: string[];
  is_badge: boolean;
}

export interface EncodeSummary {
  total_bytes: number;
  payload_bytes: number;
  byte_columns: number;
  capacity_columns: number;
  chunks: number;
  header_hex: string;
}

export interface TextBitmap {
  rows: boolean[][];
  columns: number;
  width: number;
  missing: string[];
}

export const TOOLS = [
  "pencil",
  "eraser",
  "line",
  "rect",
  "ellipse",
  "fill",
  "select",
] as const;

export type Tool = (typeof TOOLS)[number];

export const TOOL_LABELS: Record<Tool, string> = {
  pencil: "Pencil",
  eraser: "Eraser",
  line: "Line",
  rect: "Rectangle",
  ellipse: "Ellipse",
  fill: "Fill",
  select: "Select",
};

/** Single-key shortcut per tool. */
export const TOOL_KEYS: Record<Tool, string> = {
  pencil: "p",
  eraser: "e",
  line: "l",
  rect: "r",
  ellipse: "o",
  fill: "f",
  select: "s",
};

/** Tools whose outline/fill toggle applies. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["rect", "ellipse"]);

/**
 * LED colours the badge ships in. The badge does not report which one it is,
 * so the user picks it and the app renders to match.
 */
export const LED_COLORS = {
  red: "#ff4d3d",
  orange: "#ff8c2b",
  yellow: "#ffcf2b",
  green: "#35e05f",
  blue: "#3d8bff",
  purple: "#a86bff",
  pink: "#ff5bb8",
  white: "#eef2f8",
} as const;

export type LedColor = keyof typeof LED_COLORS;

export const LED_ORDER: LedColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "white",
];
