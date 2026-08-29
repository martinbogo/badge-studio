# Badge Studio in the browser

The same editor as the desktop app, built for the web. Drawing tools, the
timeline, message slots, documents and both transports, with nothing installed.

It is the only way to use Badge Studio on Android. It cannot run on iOS, where
Safari implements neither WebHID nor Web Bluetooth on any platform.

## Building and running

```bash
cd badge-studio
npm run dev:web             # http://localhost:5180
npm run build:web           # -> badge-studio/dist-web/
```

`localhost` counts as a secure context, so the badge works in `dev:web` without
TLS.

## Deploying

Upload the contents of `badge-studio/dist-web/` to any static host:

```bash
npm run build:web
scp -r badge-studio/dist-web/* you@example.com:/var/www/html/badge/
```

**HTTPS is mandatory.** WebHID and Web Bluetooth are gated on a secure context.
Served over plain HTTP the page loads and then offers neither, which looks like
a broken app rather than a missing certificate.

No server code, no CORS headers, no MIME configuration.

## Browser support

| | USB (WebHID) | Bluetooth |
|---|---|---|
| Chrome, Edge, Opera (desktop) | yes | yes |
| Chrome (Android) | no | yes |
| Firefox | no | no |
| Safari, iOS, iPadOS | no | no |

Mobile Chromium compiles WebHID out, so `navigator.hid` is `undefined` on
Android rather than throwing.

## How the two builds share one editor

Only a handful of things genuinely differ between a desktop app and a web page.
Those live behind `src/platform/`, and everything above that line, which is
most of the program, is the same code in both builds.

```
src/platform/
  types.ts     the interface
  tauri.ts     desktop: Rust commands and window events
  web.ts       browser: WebHID, Web Bluetooth, File System Access, IndexedDB
  wire.ts      the "wang" encoder, in TypeScript
  webfont.ts   the glyph renderer, a port of font/mod.rs
  index.ts     picks one, at build time
```

`vite.config.ts` aliases `@platform-impl` to one implementation or the other, so
the unused half is never bundled: the desktop build carries no glyph table and
the web build carries no Tauri client.

Editor code imports from `./platform` and never from either implementation. If
you find yourself reaching for `invoke` in a component, add a method to the
interface instead and implement it on both sides.

## Two implementations of one wire format

The encoder now exists twice, in Rust for the desktop and in TypeScript for the
browser, and both write to hardware. That is a liability, so it is tested rather
than trusted.

`src/wire.test.ts` holds the TypeScript encoder to golden vectors printed by
`protocol.rs` itself: text through the shared glyph table, animation at both
firmware strides, blink and border bits across two messages, and the brightness
level. It also asserts the two strides differ, because if they ever stopped
differing the firmware detection would be doing nothing.

To regenerate the vectors, add a test to `protocol.rs` that prints `pack(...)`
as hex with a `Stamp::default()`, run it, and paste the output.

The glyphs are not duplicated at all. `fonts/webfont.py` generates
`web/fonts.json` from the same `fonts/*.face` pixel art that `build.py` turns
into the Rust tables, and CI regenerates both and fails on a diff.

## What the browser cannot do

Three differences are inherent rather than unfinished:

- **Device access needs a click.** Chrome will not reveal a device until the
  user picks it from its own chooser, and that chooser opens only from a user
  gesture. Hence the `Connect USB` button, and a `Scan` that opens the
  Bluetooth chooser rather than surveying the air.
- **There are no file paths.** The File System Access API will not hand one
  back, so a document is an opaque handle. Save In Place works, but what the
  title bar shows is a name, not a location.
- **Double-clicking a `.badge` file does not open it.** That needs the File
  Handling API, which means an installed PWA.

Everything else has a real equivalent: the autosave and crash recovery use
IndexedDB, the menu is an in-page one raising the same action ids, and the
window title is the document title.

## Things that look like bugs and are not

- **The badge is silent over Bluetooth while USB is plugged in.** Unplug it,
  then press the first button until the Bluetooth icon appears.
- **It leaves Bluetooth mode after every upload.** Press the button again
  before each send.
- **A failed Bluetooth upload cannot be resumed.** Send again from the start.
- **Delivery is unverifiable.** No checksum, no read-back, nothing comes back
  on either transport. Bytes accepted by the link is not the same as bytes
  parsed by the badge. Check the display.

## The standalone prototype

`web/index.html` is a single-file text sender that predates this port. It
proved WebHID and Web Bluetooth reach the hardware and that the encoder ports
faithfully, which were the risky unknowns. The full build supersedes it, and it
is kept only as a minimal fallback.

`web/fonts.json` is not part of that prototype and stays regardless: the real
build imports it.
