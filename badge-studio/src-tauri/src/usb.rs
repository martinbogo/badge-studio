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

//! USB HID transport.
//!
//! The stock firmware exposes a vendor-defined HID interface alongside its
//! Bluetooth stack, and it takes the same `wang` byte stream. This path avoids
//! everything that makes BLE uploads fragile: no unplugging, no button press to
//! enter Bluetooth mode, no mode expiring part-way through a transfer, and 64
//! bytes per write instead of 16.
//!
//! From the badge's report descriptor (`06 00 FF 09 01 A1 01 ...`): vendor usage
//! page 0xFF00, 64-byte input and output reports, no report ID.

//! Two libraries, on purpose. `hidapi` does the writing, because the badge is
//! an HID device and that is the interface that accepts the payload. `nusb`
//! does the *detecting*, because hidapi cannot be trusted to notice a cable
//! being pulled: its macOS backend enumerates through an `IOHIDManager` that
//! needs a running CFRunLoop to see devices leave, and inside Tauri it never
//! gets one. Polling it harder does not help. `nusb` takes plug and unplug
//! events straight from IOKit, udev, or Windows PnP, so the answer is both
//! correct and immediate.

use futures::executor::block_on_stream;
use hidapi::HidApi;
use nusb::MaybeFuture;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const VID: u16 = 0x0416;
pub const PID: u16 = 0x5020;

/// The descriptor's Report Count. Not a tunable: a short report is a malformed
/// transfer rather than a partial one, so the payload is padded to a multiple.
pub const REPORT: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum UsbError {
    #[error("{0}")]
    Hid(#[from] hidapi::HidError),
    #[error("Could not enumerate USB devices: {0}")]
    Enumerate(nusb::Error),
    #[error(
        "No badge found on USB. Plug it in with the supplied cable. \
         On Linux this also needs a udev rule granting access to {VID:04x}:{PID:04x}, \
         otherwise the device is only visible to root."
    )]
    NotFound,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsbInfo {
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
}

fn api() -> Result<HidApi, UsbError> {
    Ok(HidApi::new()?)
}

/// Whether a badge is plugged in, and what it says about itself.
pub fn find() -> Result<Option<UsbInfo>, UsbError> {
    let devices = nusb::list_devices().wait().map_err(UsbError::Enumerate)?;
    Ok(devices
        .filter(|d| d.vendor_id() == VID && d.product_id() == PID)
        .map(|d| UsbInfo {
            manufacturer: d.manufacturer_string().map(str::to_string),
            product: d.product_string().map(str::to_string),
            serial: d.serial_number().map(str::to_string),
        })
        .next())
}

/// The event name carrying `Option<UsbInfo>` to the UI on every change.
pub const PRESENCE_EVENT: &str = "usb-presence";

/// Watch for the badge being plugged in or unplugged, for as long as the app
/// runs.
///
/// Every event re-enumerates rather than tracking device IDs: `Disconnected`
/// carries only an opaque ID, and re-listing is both simpler and correct if we
/// ever miss an event. Runs on its own thread because the watch is a blocking
/// stream, and it is never joined: it ends when the process does.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let watch = match nusb::watch_devices() {
            Ok(w) => w,
            Err(e) => {
                // Not fatal. The UI still gets the startup value and the send
                // path still works; the user just has to press Record to find
                // out, which is how it behaved before this existed.
                eprintln!("USB hotplug unavailable, falling back to startup detection: {e}");
                return;
            }
        };

        let mut last = find().ok().flatten();
        let _ = app.emit(PRESENCE_EVENT, &last);

        for _event in block_on_stream(watch) {
            let now = find().ok().flatten();
            // Any USB device on the machine wakes this, so only speak up when
            // the answer for *our* device actually changed.
            let changed = now.is_some() != last.is_some();
            if changed {
                last = now;
                let _ = app.emit(PRESENCE_EVENT, &last);
            }
        }
    });
}

/// Write the whole stream as 64-byte output reports.
///
/// `on_progress` is called per report so the UI can share one progress bar with
/// the Bluetooth path, even though this finishes fast enough to barely show.
pub fn send(
    data: &[u8],
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, UsbError> {
    let api = api()?;
    let dev = api.open(VID, PID).map_err(|e| match e {
        hidapi::HidError::HidApiError { .. } => UsbError::NotFound,
        other => UsbError::Hid(other),
    })?;

    let mut padded = data.to_vec();
    let slack = padded.len() % REPORT;
    if slack != 0 {
        padded.resize(padded.len() + (REPORT - slack), 0);
    }

    let total = padded.len() / REPORT;
    // hidapi wants the report ID as byte 0. This device has no report IDs, so
    // it is a literal zero and the device never sees it.
    let mut buf = [0u8; REPORT + 1];
    for i in 0..total {
        buf[1..].copy_from_slice(&padded[i * REPORT..(i + 1) * REPORT]);
        dev.write(&buf)?;
        on_progress(i + 1, total);
    }
    Ok(padded.len())
}
