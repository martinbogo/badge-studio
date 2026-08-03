# Badge Studio

A desktop application for designing and uploading animations to the nyx v1 LED
badge (WCH CH582, 44x11 monochrome matrix).

Runs on macOS, Windows and Linux. Uploads over USB or Bluetooth LE using the
badge's stock firmware. No reflashing is required.

## Features

**Editing**

- Pixel editor with pencil, eraser, line, rectangle, ellipse (outline or
  filled), flood fill and rectangular select
- Brush sizes 1 to 3 px for pencil, eraser and line
- Right-click erases with any tool
- Selections can be dragged, nudged with the arrow keys, and cut, copied or
  pasted
- Text insertion using the badge's built-in 167-glyph font
- Image import with an adjustable black/white threshold
- Undo and redo

**Animation**

- 8 message slots, each holding up to 8 animation frames, for 64 frames total
- Frame timeline with onion skinning, duplication, deletion and drag reordering
- Live preview that simulates the badge at its real display speed
- Scrub bar and single-frame jog through any animation or effect
- Preview colour selectable to match your badge's LEDs

**Message settings**

- 9 display modes: scroll left, scroll right, scroll up, scroll down, fixed,
  animation, snowflake, picture, laser
- 8 speeds, blink, animated border
- 4 brightness levels: 25%, 50%, 75%, 100%
- Capacity meter showing payload size against what the badge accepts

**Uploading**

- USB by default, Bluetooth LE when no cable is connected
- Automatic detection when the badge is plugged in or unplugged
- Per-chunk transfer progress

## Installing

Prebuilt packages for each release are on the
[Releases](../../releases) page.

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | `Badge.Studio_<version>_aarch64.dmg` |
| Windows | `Badge.Studio_<version>_x64-setup.exe` or `.msi` |
| Linux (Debian/Ubuntu) | `.deb` |
| Linux (Fedora/RHEL) | `.rpm` |
| Linux (portable) | `.AppImage` |
| Linux (binary only) | `.tar.gz` |

macOS builds are Apple Silicon only. Intel Macs need a build from source.

The releases are not code-signed.

On **macOS**, Gatekeeper will refuse to open the app and may report it as
damaged. Clear the quarantine attribute after copying it to Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Badge Studio.app"
```

On **Windows**, SmartScreen will warn on first run. Choose "More info" and
then "Run anyway".

Linux packages are built against glibc 2.35 (Ubuntu 22.04) and will not run on
older distributions. Build from source in that case. The `.tar.gz` contains the
bare executable and expects `webkit2gtk-4.1` to be installed already; the `.deb`
and `.rpm` declare their dependencies and are the better choice.

## Documents

| Extension | Contains | Opening one |
|---|---|---|
| `.badge` | A whole project, up to 8 message slots | Replaces the current document |
| `.badgemsg` | A single message with its frames and settings | Inserts it into the current document |

Both are JSON, and both are registered as file associations, so double-click
and "Open With" work.

New, Open, Save, Save As, Open Recent, Import Message and Export Message are in
the **File** menu. New, Open and Save are also in the application's top bar.

The window title shows the document name, with a bullet when there are unsaved
changes. Anything that would discard unsaved work asks first, offering Save,
Discard or Cancel.

The working copy is written to the application data directory a few seconds
after the last edit, and deleted on a clean exit. If the application is found
to have exited uncleanly, it offers to restore that copy on next launch.

## Connecting the badge

### USB

Connect the badge with a USB cable. It is detected automatically and a green
**USB** indicator appears in the transport bar. Press **Record** to upload.

On Linux the device is accessible only to root unless a udev rule grants
access:

```bash
sudo cp 99-led-badge.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug and reconnect the badge afterwards. macOS and Windows need no
configuration.

### Bluetooth LE

Used when no cable is connected. The badge does not advertise by default:

1. Unplug it from USB. It will not advertise over Bluetooth while connected.
2. Press the first button. A Bluetooth icon appears when it is ready.

The badge leaves Bluetooth mode after every upload, so step 2 must be repeated
before each send.

Bluetooth uploads of large animations are slow and can fail part-way. Use USB
for anything approaching the full 64 frames.

On macOS, the first scan raises a system permission prompt.

## Keyboard

| Key | Action |
|---|---|
| `P` `E` `L` `R` `O` `F` `S` | Pencil, eraser, line, rectangle, ellipse, fill, select |
| `Cmd/Ctrl` + `Z` / `Shift+Z` | Undo / redo |
| `Cmd/Ctrl` + `C` / `X` / `V` / `A` | Copy / cut / paste / select all |
| Arrow keys | Nudge the selection, or jog the preview when nothing is selected |
| `Delete` | Erase inside the selection |
| `Esc` | Deselect |
| `Space` | Play or pause the preview |
| `Cmd/Ctrl` + `N` / `O` / `S` | New / open / save |
| `Cmd/Ctrl` + `Shift` + `S` | Save as |
| `Cmd/Ctrl` + `Q` | Quit |

## Building

### Requirements

All platforms need:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20.19 or newer

Plus, per platform:

**macOS**

```bash
xcode-select --install
```

**Windows**

- Microsoft C++ Build Tools
- WebView2 runtime (preinstalled on Windows 11 and current Windows 10)

**Linux** (Debian/Ubuntu; adjust package names for other distributions)

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libudev-dev
```

### Running

```bash
cd badge-studio
npm install
npm run tauri dev
```

### Producing a release build

```bash
cd badge-studio
npm run tauri build
```

Installers and application bundles are written to
`badge-studio/src-tauri/target/release/bundle/`:

| Platform | Output |
|---|---|
| macOS | `macos/Badge Studio.app`, `dmg/*.dmg` |
| Windows | `msi/*.msi`, `nsis/*.exe` |
| Linux | `deb/*.deb`, `rpm/*.rpm`, `appimage/*.AppImage` |

Builds are native only; cross-compiling between platforms is not supported.

### Tests

```bash
cd badge-studio && npm test              # editor and preview
cd badge-studio/src-tauri && cargo test  # encoder and font
```

### Releases

Pushing a `v*` tag builds every platform and attaches the installers to a draft
GitHub release, which is then published by hand. The tag must match the version
in `package.json`, `Cargo.toml` and `tauri.conf.json`, or the workflow stops
before building.

```bash
git tag -a v1.0.0 -m "Badge Studio 1.0.0"
git push origin v1.0.0
```

The same workflow can be run from the Actions tab without a tag, which builds
everything and leaves the results as workflow artifacts.

## Protocol

[PROTOCOL.md](PROTOCOL.md) documents the wire format and both transports.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
