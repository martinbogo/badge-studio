# badge-studio/

The desktop app. See the [repository README](../README.md) for what this is,
how to run it, and the protocol it speaks.

## Layout

| path | what it is |
|---|---|
| `src/` | React frontend: editor, timeline, preview, transport |
| `src/doc.ts` | Reading and writing `.badge` and `.badgemsg` documents |
| `src/badge.ts` | Preview simulation of the badge's display modes |
| `src/draw.ts` | Drawing primitives, unit-tested |
| `src-tauri/src/protocol.rs` | The wire-format encoder |
| `src-tauri/src/usb.rs` | USB HID transport and hotplug detection |
| `src-tauri/src/ble.rs` | Bluetooth transport |
| `src-tauri/src/files.rs` | Documents, recent files, crash recovery |
| `src-tauri/src/menu.rs` | The File menu, on all three platforms |

## Development

```bash
npm install
npm run tauri dev
npm test                       # frontend: drawing and preview
cd src-tauri && cargo test     # encoder and font
```

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
