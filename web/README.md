# Badge Studio Web

Programs the badge from a browser, with nothing installed. Two static files,
no build step, no server code.

The desktop app is the better tool for real work. This exists because a badge
handed out at a conference is useless until its owner installs something, and
"open this URL" clears that bar in a way "download an unsigned binary for your
platform" does not. It is also the only way to reach Android.

## Running it

```bash
cd web && python3 -m http.server 8765
```

Then open <http://localhost:8765/>. Localhost counts as a secure context, so
both transports work without TLS.

## Deploying

Copy `index.html` and `fonts.json` into the same directory on any static host:

```bash
scp web/index.html web/fonts.json you@example.com:/var/www/html/badge/
```

**HTTPS is mandatory.** WebHID and Web Bluetooth are gated on a secure
context. Served over plain HTTP the page loads and then offers neither API,
which presents as two buttons that silently do nothing. The page detects this
and says so in the transport log, but the fix is a certificate.

Nothing else is needed: no CORS headers, no MIME configuration, no build. Both
files compress well, so enable gzip if it is not already on.

## Browser support

| | USB (WebHID) | Bluetooth (Web Bluetooth) |
|---|---|---|
| Chrome, Edge, Opera (desktop) | yes | yes |
| Chrome (Android) | no | yes |
| Firefox | no | no |
| Safari, iOS, iPadOS | no | no |

Mobile Chromium compiles WebHID out, so `navigator.hid` is `undefined` on
Android rather than throwing. Safari implements neither API on any platform,
and no flag enables them, so iOS needs a native app. The page reports whichever
of these applies instead of failing blankly.

## How it works

### Glyphs are generated, not copied

`fonts.json` is built from the same `fonts/*.face` pixel art as the Rust tables,
by `fonts/webfont.py`, which imports `build.py`'s own parser. Maintaining a
second copy of the glyphs by hand would guarantee the two drift, and the drift
would stay invisible until someone compared a photo of a badge against a screen.

Regenerate after editing a face:

```bash
python3 fonts/webfont.py
```

The `generated-fonts-are-current` CI job runs this and fails on a diff, so the
browser and the desktop app cannot disagree about what a glyph looks like.

### The encoder is a port, and is checked against the original

`layout`, `measure`, `pixelsToBitmap` and `pack` mirror
`src-tauri/src/protocol.rs` and `src-tauri/src/font/mod.rs`. Correctness here is
not cosmetic: the output is written straight to hardware.

Parity was established by generating a golden vector from the Rust encoder and
running the same input through the JavaScript one, byte for byte, and by
comparing measured widths across all five faces against strings covering
Cyrillic, accented Latin, an emoji with a variation selector, a skin-tone
modifier, a ZWJ sequence, emoji fallback mid-word, and an unmapped character.
A variation selector counted on one side and not the other is exactly the bug
this project has already shipped once.

### Transports

Both carry the identical byte stream; only the framing differs. See
[PROTOCOL.md](../PROTOCOL.md) for the wire format.

**USB HID.** 64-byte output reports, no report ID, zero-padded to a multiple of
64 because Report Count is fixed, so a short final report is malformed rather
than partial. WebHID's leading report-ID argument is a literal `0`. Reachable
from a browser at all because the interface uses vendor-defined usage page
`0xFF00`, which is not on Chrome's blocklist, with SubClass and Protocol both 0
so the OS HID driver does not claim it.

**Bluetooth.** 16-byte writes to characteristic `0xFEE1` on service `0xFEE0`.
Larger writes are not rejected, they are simply never acknowledged, so an
oversized write hangs forever with no feedback. Write-with-response, sequential,
three attempts per chunk. The badge latches the upload when the link drops, so
the page disconnects after the last write.

## Debugging

A **Transport log** panel records connect attempts, the characteristic
properties found, per-chunk retries, byte and write totals, and timing. Errors
carry name, message and the head of the stack. Everything is mirrored to the
console prefixed `[badge]`.

| | |
|---|---|
| `window.__badge.log` | the raw records |
| `window.__badge.dump()` | the log as text, same as the Copy button |
| `window.__badge.encode()` | pack the current messages **without sending** |

`encode()` is the useful one when something looks wrong: it separates an
encoder bug from a transport bug, and needs no badge attached.

## Things that look like bugs and are not

- **The badge is silent over Bluetooth while USB is plugged in.** Unplug it,
  then press the first button until the Bluetooth icon appears.
- **It leaves Bluetooth mode after every upload.** Press the button again
  before each send. A second send without another press fails with "no longer
  reachable".
- **A failed Bluetooth upload cannot be resumed.** The badge tracks no write
  position across a reconnect, so send again from the start.
- **Delivery is unverifiable.** No checksum, no read-back, nothing ever comes
  back on either transport. "Sent 11 writes" means the link accepted the bytes,
  not that the badge parsed them. Check the display.
