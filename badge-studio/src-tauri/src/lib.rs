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

mod ble;
mod files;
mod menu;
mod usb;
mod font;
mod protocol;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use protocol::{Message, Mode};

/// One badge message slot as described by the UI.
///
/// `frames` is a list of frames; each frame is 11 rows of booleans.
/// In `animation` mode every frame is padded to 48px and concatenated into a
/// filmstrip. In every other mode only the first frame is used, at whatever
/// width it has, which is what makes long scrolling text work.
#[derive(Debug, Deserialize)]
pub struct MessageSpec {
    pub frames: Vec<Vec<Vec<bool>>>,
    pub mode: Mode,
    pub speed: u8,
    #[serde(default)]
    pub blink: bool,
    #[serde(default)]
    pub ants: bool,
}

#[derive(Debug, Serialize)]
pub struct TextBitmap {
    pub rows: Vec<Vec<bool>>,
    pub columns: usize,
    pub width: usize,
    pub missing: Vec<char>,
}

#[derive(Debug, Serialize)]
pub struct EncodeSummary {
    pub total_bytes: usize,
    pub payload_bytes: usize,
    pub byte_columns: usize,
    pub capacity_columns: usize,
    pub chunks: usize,
    /// Hex dump of the 64-byte header, for the inspector panel.
    pub header_hex: String,
}

/// A failed send.
///
/// This used to carry a byte offset so the UI could offer to resume. It could
/// not: the badge does not track a write position across a reconnect, so
/// continuing from the middle produced a garbled buffer rather than a finished
/// one. A failed BLE upload has to be sent again from the start.
#[derive(Debug, Serialize)]
pub struct SendError {
    pub message: String,
}

#[derive(Clone, Serialize)]
struct Progress {
    chunk: usize,
    total: usize,
}

fn to_messages(specs: &[MessageSpec]) -> Result<Vec<Message>, String> {
    if specs.is_empty() {
        return Err("Add at least one message before sending.".into());
    }
    specs
        .iter()
        .map(|s| {
            if s.frames.is_empty() {
                return Err("A message has no frames.".to_string());
            }
            let (bitmap, columns) = if s.mode == Mode::Animation {
                if s.frames.len() > protocol::ANIMATION_MAX_FRAMES {
                    return Err(protocol::ProtocolError::TooManyFrames {
                        got: s.frames.len(),
                    }
                    .to_string());
                }
                protocol::frames_to_bitmap(&s.frames)
            } else {
                protocol::pixels_to_bitmap(&s.frames[0])
            };
            if columns == 0 {
                return Err("A message is empty. Draw something or remove it.".to_string());
            }
            Ok(Message {
                bitmap,
                columns,
                mode: s.mode,
                speed: s.speed,
                blink: s.blink,
                ants: s.ants,
            })
        })
        .collect()
}

fn encode(specs: &[MessageSpec], brightness: u8) -> Result<Vec<u8>, String> {
    let messages = to_messages(specs)?;
    protocol::pack(&messages, brightness, protocol::Stamp::now()).map_err(|e| e.to_string())
}

#[tauri::command]
fn render_text(text: String) -> TextBitmap {
    let (bitmap, columns, missing) = font::text_to_bitmap(&text);
    let width = columns * 8;
    let mut rows = vec![vec![false; width]; protocol::BADGE_HEIGHT];
    for col in 0..columns {
        for row in 0..protocol::BADGE_HEIGHT {
            let byte = bitmap[col * protocol::BADGE_HEIGHT + row];
            for bit in 0..8 {
                rows[row][col * 8 + bit] = (byte >> (7 - bit)) & 1 == 1;
            }
        }
    }
    TextBitmap {
        rows,
        columns,
        width,
        missing,
    }
}

#[tauri::command]
fn encode_summary(
    messages: Vec<MessageSpec>,
    brightness: u8,
    chunk_size: usize,
) -> Result<EncodeSummary, String> {
    let data = encode(&messages, brightness)?;
    let payload = data.len() - protocol::HEADER_SIZE;
    let header_hex = data[..protocol::HEADER_SIZE]
        .chunks(16)
        .map(|c| {
            c.iter()
                .map(|b| format!("{b:02X}"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(EncodeSummary {
        total_bytes: data.len(),
        payload_bytes: payload,
        byte_columns: payload / protocol::BADGE_HEIGHT,
        capacity_columns: protocol::MAX_BYTE_COLUMNS,
        chunks: data.len().div_ceil(chunk_size.max(1)),
        header_hex,
    })
}

/// Pick an image and hand it back as a data URL for the frontend to decode.
/// Returns None if cancelled.
#[tauri::command]
async fn pick_image(app: AppHandle) -> Result<Option<String>, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("Image", &["png", "gif", "bmp", "jpg", "jpeg", "webp"])
        .blocking_pick_file();
    let Some(path) = path else { return Ok(None) };
    let path = path
        .into_path()
        .map_err(|e| format!("Could not resolve that file: {e}"))?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        other => return Err(format!("Unsupported image type: .{other}")),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

#[tauri::command]
async fn ble_status() -> Result<String, String> {
    ble::adapter_status().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ble_scan(
    timeout_ms: Option<u64>,
) -> Result<Vec<ble::BadgeInfo>, String> {
    ble::scan(timeout_ms.unwrap_or(6000))
        .await
        .map_err(|e| e.to_string())
}

/// Whether a badge is plugged in over USB. Cheap enough to poll.
#[tauri::command]
fn usb_find() -> Result<Option<usb::UsbInfo>, String> {
    usb::find().map_err(|e| e.to_string())
}

/// Send over USB HID.
///
/// Deliberately not folded into `send_to_badge`: that function is mostly
/// machinery for BLE's failure modes (a stall detector, resume offsets, a
/// device picker), none of which apply here. A USB transfer either opens the
/// device and completes in well under a second, or fails immediately.
#[tauri::command]
async fn send_to_badge_usb(
    app: AppHandle,
    messages: Vec<MessageSpec>,
    brightness: u8,
) -> Result<usize, SendError> {
    let data = encode(&messages, brightness).map_err(|message| SendError { message })?;

    // hidapi is blocking, so keep it off the async runtime's threads.
    tokio::task::spawn_blocking(move || {
        usb::send(&data, move |chunk, total| {
            let _ = app.emit("send-progress", Progress { chunk, total });
        })
    })
    .await
    .map_err(|e| SendError {
        message: format!("The USB transfer task stopped unexpectedly: {e}"),
    })?
    .map_err(|e| SendError {
        message: e.to_string(),
    })
}

#[tauri::command]
async fn send_to_badge(
    app: AppHandle,
    messages: Vec<MessageSpec>,
    brightness: u8,
    device_id: Option<String>,
) -> Result<usize, SendError> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let data = encode(&messages, brightness).map_err(|message| SendError { message })?;
    let total_bytes = data.len();
    let total_writes = total_bytes.div_ceil(ble::CHUNK_SIZE);

    // A wedged CoreBluetooth write does not respond to `tokio::time::timeout`:
    // the future never completes and never wakes. So run the transfer on its
    // own task and watch it from here. If progress stops advancing we give up
    // and hand control back to the UI, leaving the orphaned task to unwind
    // whenever the OS eventually lets go.
    let progress = Arc::new(AtomicUsize::new(0));
    let seen = progress.clone();
    let emitter = app.clone();

    let task = tokio::spawn(async move {
        ble::send(&data, device_id.as_deref(), |chunk, total| {
            seen.store(chunk, Ordering::Relaxed);
            let _ = emitter.emit("send-progress", Progress { chunk, total });
        })
        .await
        .map_err(|e| e.to_string())
    });

    let mut last = 0usize;
    let mut idle = std::time::Duration::ZERO;
    let tick = std::time::Duration::from_millis(500);

    tokio::pin!(task);
    loop {
        match tokio::time::timeout(tick, &mut task).await {
            Ok(joined) => {
                return match joined {
                    Ok(Ok(())) => Ok(total_bytes),
                    Ok(Err(message)) => Err(SendError { message }),
                    Err(_) => Err(SendError {
                        message: "The transfer task stopped unexpectedly.".into(),
                    }),
                }
            }
            Err(_) => {
                let now = progress.load(Ordering::Relaxed);
                if now != last {
                    last = now;
                    idle = std::time::Duration::ZERO;
                    continue;
                }
                idle += tick;
                if idle < STALL_TIMEOUT {
                    continue;
                }
                return Err(SendError {
                    message: format!(
                        "The upload stopped after {last} of {total_writes} writes.\n\n\
                         The badge leaves Bluetooth mode on its own after a few \
                         minutes, and stops responding without closing the \
                         connection. Press its first button to put it back into \
                         Bluetooth mode, then send again from the start.\n\n\
                         Connecting the badge over USB avoids this entirely and is \
                         much faster.",
                    ),
                });
            }
        }
    }
}

/// How long a transfer may make no forward progress before we call it dead.
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            usb::watch(app.handle().clone());
            menu::install(app.handle())?;
            pending_from_argv();
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            render_text,
            encode_summary,
            pick_image,
            ble_status,
            ble_scan,
            usb_find,
            send_to_badge,
            send_to_badge_usb,
            files::pick_open,
            files::pick_save,
            files::read_text,
            files::write_text,
            files::recovery_write,
            files::recovery_read,
            files::recovery_clear,
            files::recent_list,
            files::recent_clear,
            take_pending_files,
            confirm_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Double-clicking a .badge file, or "Open With". macOS delivers it
            // as an Apple Event at any time, including before the window is
            // ready, so the frontend re-asks for a pending file once it mounts
            // rather than relying on catching the event live.
            //
            // `Opened` exists only on macOS. Windows and Linux pass the file as
            // an argument instead, which `pending_from_argv` handles at startup.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        remember_pending(app, path.display().to_string());
                    }
                }
            }
            // Quit from the menu or Cmd+Q does not go through the window's
            // close handler, so without this the one path most likely to be
            // used in a hurry is the one that loses work silently.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !EXIT_OK.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("quit-requested", ());
                }
            }
            _ => {}
        });
}

/// Set once the frontend has dealt with unsaved work and really means it.
static EXIT_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn confirm_exit(app: AppHandle) {
    EXIT_OK.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// Files the OS asked us to open that the UI has not collected yet.
static PENDING: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[cfg(target_os = "macos")]
fn remember_pending(app: &AppHandle, path: String) {
    if let Ok(mut q) = PENDING.lock() {
        q.push(path.clone());
    }
    // Harmless if nothing is listening yet; `take_pending_files` is the catch-up.
    let _ = app.emit("open-file", path);
}

/// Windows and Linux pass the file as an argument instead of an event.
fn pending_from_argv() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(mut q) = PENDING.lock() {
        for a in args {
            let p = std::path::Path::new(&a);
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if (ext == files::PROJECT_EXT || ext == files::MESSAGE_EXT) && p.exists() {
                q.push(a);
            }
        }
    }
}

#[tauri::command]
fn take_pending_files() -> Vec<String> {
    PENDING
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank_frame(width: usize) -> Vec<Vec<bool>> {
        vec![vec![false; width]; protocol::BADGE_HEIGHT]
    }

    #[test]
    fn animation_mode_builds_a_filmstrip() {
        let spec = MessageSpec {
            frames: vec![blank_frame(44), blank_frame(44), blank_frame(44)],
            mode: Mode::Animation,
            speed: 8,
            blink: false,
            ants: false,
        };
        let msgs = to_messages(&[spec]).unwrap();
        // 3 frames padded to 48px = 144px = 18 byte columns
        assert_eq!(msgs[0].columns, 18);
    }

    #[test]
    fn non_animation_modes_use_only_the_first_frame() {
        let spec = MessageSpec {
            frames: vec![blank_frame(80), blank_frame(44)],
            mode: Mode::ScrollLeft,
            speed: 4,
            blink: false,
            ants: false,
        };
        let msgs = to_messages(&[spec]).unwrap();
        assert_eq!(
            msgs[0].columns, 10,
            "80px = 10 byte columns, second frame ignored"
        );
    }

    #[test]
    fn render_text_round_trips_through_the_font() {
        let out = render_text("HI".into());
        assert_eq!(out.columns, 2);
        assert_eq!(out.width, 16);
        assert_eq!(out.rows.len(), protocol::BADGE_HEIGHT);
        assert!(out.missing.is_empty());
        // 'H' crossbar row 5 = 0xFE = 7 lit pixels then dark
        assert_eq!(
            out.rows[5][0..8].to_vec(),
            vec![true, true, true, true, true, true, true, false]
        );
    }

    #[test]
    fn summary_reports_capacity() {
        let spec = MessageSpec {
            frames: vec![blank_frame(44)],
            mode: Mode::Fixed,
            speed: 4,
            blink: false,
            ants: false,
        };
        let s = encode_summary(vec![spec], 100, 16).unwrap();
        assert_eq!(s.byte_columns, 6);
        assert_eq!(s.capacity_columns, protocol::MAX_BYTE_COLUMNS);
        assert_eq!(s.total_bytes, 64 + 66);
        assert!(s.header_hex.starts_with("77 61 6E 67"));
    }

    #[test]
    fn empty_input_is_rejected_with_a_readable_message() {
        assert!(encode(&[], 100).is_err());
    }
}
