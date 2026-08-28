#!/usr/bin/env python3
# Copyright 2026 Martin Bogomolni
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Turn the .face pixel art into a JSON glyph table for the web client.

Same sources and same parser as build.py, so the browser draws exactly what
the desktop app draws. Emitting a second hand-maintained copy of the glyphs
would guarantee the two drift, and the drift would be invisible until someone
compared a photo of a badge against a screen.

    ./fonts/webfont.py            -> web/fonts.json

Faces are written in FACES order from font/mod.rs, because that order IS the
fallback chain; the web client walks the list as given.
"""
import json
import pathlib

from build import ROWS, pack, parse

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "web" / "fonts.json"

# Fallback order, mirroring FACES in badge-studio/src-tauri/src/font/mod.rs.
ORDER = ["serif", "sans", "cartoon", "future", "emoji"]


def main():
    by_id = {}
    for src in sorted(HERE.glob("*.face")):
        meta, glyphs = parse(src)
        jitter = meta.get("jitter", "") or "[]"
        by_id[meta["id"]] = {
            "id": meta["id"],
            "name": meta["name"],
            "notice": meta.get("notice", ""),
            "jitter": json.loads(jitter.replace("[", "[").replace("]", "]")),
            "pickable": meta.get("pickable", "yes") != "no",
            # char -> [advance, r0..r10]
            "glyphs": {ch: [adv] + pack(rows) for ch, adv, rows in glyphs},
        }

    missing = [i for i in ORDER if i not in by_id]
    if missing:
        raise SystemExit(f"ORDER names faces with no .face source: {missing}")
    extra = [i for i in by_id if i not in ORDER]
    if extra:
        raise SystemExit(f"face(s) not in ORDER, fallback chain would ignore them: {extra}")

    doc = {"rows": ROWS, "faces": [by_id[i] for i in ORDER]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    total = sum(len(f["glyphs"]) for f in doc["faces"])
    print(f"{len(doc['faces'])} faces, {total} glyphs -> {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
