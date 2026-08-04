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

import { describe, expect, it } from "vitest";
import {
  DOC_VERSION,
  DocError,
  parseMessage,
  parseProject,
  serializeMessage,
  serializeProject,
} from "./doc";
import { newMessage } from "./badge";
import { BADGE_HEIGHT, type Message, type Project } from "./types";

/** A message with a recognisable pattern, so a lost pixel shows up. */
function patterned(width = 44): Message {
  const m = newMessage("fixed");
  m.frames = [
    Array.from({ length: BADGE_HEIGHT }, (_, y) =>
      Array.from({ length: width }, (_, x) => (x + y) % 3 === 0)
    ),
  ];
  m.width = width;
  m.name = "Pattern";
  return m;
}

const project = (messages: Message[]): Project => ({ brightness: 100, messages });

/**
 * The same document in the format version 1 wrote, pretty-printed exactly as
 * that writer did. Comparing against a minified version 1 would flatter the
 * new format for the wrong reason: the old size problem was largely the
 * pretty-printer giving every single pixel its own line.
 */
function asV1(p: Project): string {
  return JSON.stringify(
    {
    version: 1,
    kind: "project",
    brightness: p.brightness,
    messages: p.messages.map((m) => ({
      id: m.id,
      name: m.name,
      mode: m.mode,
      speed: m.speed,
      blink: m.blink,
      ants: m.ants,
      frames: m.frames,
      width: m.width,
      enabled: m.enabled,
      })),
    },
    null,
    2
  );
}

describe("version 2 documents", () => {
  it("round-trips a project without losing a pixel", () => {
    const p = project([patterned()]);
    const back = parseProject(serializeProject(p));
    expect(back.messages[0].frames).toEqual(p.messages[0].frames);
    expect(back.brightness).toBe(100);
  });

  it("writes frames as rows of . and #", () => {
    const text = serializeProject(project([patterned(8)]));
    const doc = JSON.parse(text);
    expect(doc.version).toBe(DOC_VERSION);
    expect(doc.messages[0].frames[0]).toHaveLength(BADGE_HEIGHT);
    expect(doc.messages[0].frames[0][0]).toBe("#..#..#.");
  });

  it("leaves out the flags at their defaults and the derived width", () => {
    const stored = JSON.parse(serializeProject(project([patterned()]))).messages[0];
    expect(stored).not.toHaveProperty("blink");
    expect(stored).not.toHaveProperty("ants");
    expect(stored).not.toHaveProperty("enabled");
    // Width is the length of a row; a second copy could only disagree with it.
    expect(stored).not.toHaveProperty("width");
  });

  it("writes the flags that are not at their default, and reads them back", () => {
    const m = { ...patterned(), blink: true, ants: true, enabled: false };
    const stored = JSON.parse(serializeProject(project([m]))).messages[0];
    expect(stored.blink).toBe(true);
    expect(stored.ants).toBe(true);
    expect(stored.enabled).toBe(false);

    const back = parseProject(serializeProject(project([m]))).messages[0];
    expect(back).toMatchObject({ blink: true, ants: true, enabled: false });
  });

  it("round-trips a single message file", () => {
    const m = patterned();
    const back = parseMessage(serializeMessage(m));
    expect(back.frames).toEqual(m.frames);
    expect(back.name).toBe("Pattern");
  });

  it("is a great deal smaller than version 1 was", () => {
    const p = project([patterned()]);
    // A full badge went from 584 KB to 42 KB; one frame is the same ratio.
    expect(serializeProject(p).length).toBeLessThan(asV1(p).length / 8);
  });
});

describe("version 1 documents still open", () => {
  it("reads boolean frames unchanged", () => {
    const p = project([patterned()]);
    const back = parseProject(asV1(p));
    expect(back.messages[0].frames).toEqual(p.messages[0].frames);
  });

  it("keeps the flags a version 1 file stored explicitly", () => {
    const m = { ...patterned(), blink: true, enabled: false };
    const back = parseProject(asV1(project([m]))).messages[0];
    expect(back).toMatchObject({ blink: true, ants: false, enabled: false });
  });

  it("treats a missing enabled flag as on", () => {
    const raw = JSON.parse(asV1(project([patterned()])));
    delete raw.messages[0].enabled;
    expect(parseProject(JSON.stringify(raw)).messages[0].enabled).toBe(true);
  });

  it("still trims the old 48px animation frames to the display", () => {
    const m = patterned(48);
    m.mode = "animation";
    const back = parseProject(asV1(project([m]))).messages[0];
    expect(back.frames[0][0]).toHaveLength(44);
    expect(back.width).toBe(44);
  });
});

describe("mixed and damaged files", () => {
  it("reads a file whose frames were half converted by hand", () => {
    const doc = JSON.parse(serializeProject(project([patterned(4), patterned(4)])));
    // One frame left in the old shape, which is what a partial edit looks like.
    doc.messages[1].frames[0] = doc.messages[1].frames[0].map((row: string) =>
      [...row].map((c) => c === "#")
    );
    const back = parseProject(JSON.stringify(doc));
    expect(back.messages[1].frames[0]).toEqual(back.messages[0].frames[0]);
  });

  it("names the offending character in a hand-edited row", () => {
    const doc = JSON.parse(serializeProject(project([patterned(4)])));
    doc.messages[0].frames[0][2] = "#x#.";
    expect(() => parseProject(JSON.stringify(doc))).toThrow(DocError);
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/"x"/);
  });

  it("rejects a document from a newer format", () => {
    const doc = JSON.parse(serializeProject(project([patterned()])));
    doc.version = DOC_VERSION + 1;
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/newer version/);
  });

  it("rejects frames of inconsistent width", () => {
    const doc = JSON.parse(serializeProject(project([patterned(8)])));
    doc.messages[0].frames[0][3] = "###";
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/inconsistent size/);
  });

  it("rejects a frame with the wrong number of rows", () => {
    const doc = JSON.parse(serializeProject(project([patterned(8)])));
    doc.messages[0].frames[0].pop();
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/rows of pixels/);
  });
});
