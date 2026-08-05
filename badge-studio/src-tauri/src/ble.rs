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

//! BLE transport for the badge, via btleplug.
//!
//! CoreBluetooth on macOS, WinRT on Windows, BlueZ over DBus on Linux.
//! The badge advertises service 0xFEE0 and accepts writes on characteristic 0xFEE1.

use std::time::Duration;

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use serde::Serialize;
use uuid::Uuid;

use crate::firmware::Firmware;

pub const SERVICE_UUID: Uuid = Uuid::from_u128(0x0000fee0_0000_1000_8000_00805f9b34fb);
pub const CHAR_UUID: Uuid = Uuid::from_u128(0x0000fee1_0000_1000_8000_00805f9b34fb);

/// Stock firmware expects small writes; 16 bytes matches the vendor app.
/// Larger chunks cut the number of round trips proportionally, which matters
/// because the badge drops out of Bluetooth mode after a timeout and truncates
/// anything still in flight.
/// Not a tunable. The firmware never acknowledges a larger write, so an
/// oversized one hangs forever rather than failing.
pub const CHUNK_SIZE: usize = 16;

/// Device Information Service, and the manufacturer name inside it. Standard
/// Bluetooth SIG assignments, not badge-specific: badgemagic implements them
/// and the stock firmware does not, so the read both identifies the firmware
/// and, by returning nothing, identifies the absence of it.
const DEVINFO_SERVICE: Uuid = Uuid::from_u128(0x0000180a_0000_1000_8000_00805f9b34fb);
const MANUFACTURER_CHAR: Uuid = Uuid::from_u128(0x00002a29_0000_1000_8000_00805f9b34fb);
const MODEL_CHAR: Uuid = Uuid::from_u128(0x00002a24_0000_1000_8000_00805f9b34fb);

const WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const WRITE_ATTEMPTS: usize = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum BleError {
    #[error("bluetooth error: {0}")]
    Btle(#[from] btleplug::Error),
    #[error("no bluetooth adapter found")]
    NoAdapter,
    #[error("no badge found. Is it powered on, in range, and not already connected elsewhere?")]
    NotFound,
    #[error(
        "The badge is no longer advertising. It leaves Bluetooth mode after \
         each upload, so press the first button again to re-enter it, then retry."
    )]
    Gone,
    #[error("{0}")]
    Message(String),
    #[error("badge does not expose characteristic 0xFEE1 (wrong device, or firmware differs)")]
    NoCharacteristic,
    #[error(
        "This badge rejected the upload straight away, and it runs the badgemagic \
         firmware, so PIN security is probably switched on. Either upload over \
         USB, which never asks for a code, or turn the PIN off in the badge's \
         SECURITY menu, or press KEY4 while it is in BT-PAIRING mode to skip the \
         code for one session. Badge Studio cannot send the code itself yet."
    )]
    NeedsPin,
    #[error(
        "The link dropped after {done} of {total} chunks. The badge leaves Bluetooth \
         mode on a timeout, so a slow upload gets truncated part-way and the badge is \
         left showing a half-written buffer. Move the badge closer, raise the chunk \
         size, or send fewer frames, then press the first button and retry."
    )]
    Truncated { done: usize, total: usize },
    #[error(
        "Write {done} of {total} timed out after {secs}s with a {size}-byte chunk. \
         The badge silently ignores writes larger than its ATT payload rather than \
         rejecting them, so this usually means the chunk size is too big. Drop back \
         to 16 bytes, press the first button, and retry."
    )]
    WriteTimeout {
        done: usize,
        total: usize,
        size: usize,
        secs: u64,
    },
    #[error("Connecting to the badge timed out. Press the first button and retry.")]
    ConnectTimeout,
}



#[derive(Debug, Clone, Serialize)]
pub struct BadgeInfo {
    /// Stable per-platform identifier, passed back to `send`.
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
    /// Advertised service UUIDs.
    pub services: Vec<String>,
}

async fn adapter() -> Result<Adapter, BleError> {
    let manager = Manager::new().await?;
    manager
        .adapters()
        .await?
        .into_iter()
        .next()
        .ok_or(BleError::NoAdapter)
}

/// Scan for badges: peripherals advertising the badge service.
pub async fn scan(timeout_ms: u64) -> Result<Vec<BadgeInfo>, BleError> {
    let central = adapter().await?;
    // CoreBluetooth returns more reliable results when it is not given a
    // service filter, so scan unfiltered and match on our side.
    central.start_scan(ScanFilter::default()).await?;
    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
    let _ = central.stop_scan().await;

    let mut out = Vec::new();
    for p in central.peripherals().await? {
        let Some(props) = p.properties().await? else {
            continue;
        };
        if !props.services.contains(&SERVICE_UUID) {
            continue;
        }
        out.push(BadgeInfo {
            id: p.id().to_string(),
            name: props.local_name,
            rssi: props.rssi,
            services: props.services.iter().map(|u| u.to_string()).collect(),
        });
    }
    // Strongest signal first: with more than one badge in range, the nearest is
    // almost always the one being programmed.
    out.sort_by(|a, b| b.rssi.unwrap_or(i16::MIN).cmp(&a.rssi.unwrap_or(i16::MIN)));
    Ok(out)
}

async fn find(central: &Adapter, id: Option<&str>) -> Result<Peripheral, BleError> {
    for p in central.peripherals().await? {
        match id {
            Some(want) if p.id().to_string() != want => continue,
            _ => {}
        }
        let Some(props) = p.properties().await? else {
            continue;
        };
        if id.is_some() || props.services.contains(&SERVICE_UUID) {
            return Ok(p);
        }
    }
    match id {
        Some(_) => Err(BleError::Gone),
        None => Err(BleError::NotFound),
    }
}

/// Write `data` to the badge, in full, from the start.
///
/// There was once a `skip` parameter here to resume an upload that ran out of
/// Bluetooth-mode window part-way. It depended on the badge tracking its write
/// position across a reconnect. It does not, so a resumed transfer produced a
/// garbled buffer rather than a finished one. A failed upload has to be redone
/// from byte zero.
pub async fn send<F, E>(
    encode: E,
    id: Option<&str>,
    mut on_progress: F,
) -> Result<Firmware, BleError>
where
    F: FnMut(usize, usize),
    E: FnOnce(Firmware) -> Result<Vec<u8>, String>,
{
    let central = adapter().await?;

    // A prior scan may not have run in this process; do a short one so the
    // platform cache is populated before we look the peripheral up.
    if find(&central, id).await.is_err() {
        central.start_scan(ScanFilter::default()).await?;
        tokio::time::sleep(Duration::from_millis(4000)).await;
        let _ = central.stop_scan().await;
    }

    let peripheral = find(&central, id).await?;

    if !peripheral.is_connected().await? {
        // Without a bound this waits forever when the badge has already left
        // Bluetooth mode.
        tokio::time::timeout(CONNECT_TIMEOUT, peripheral.connect())
            .await
            .map_err(|_| BleError::ConnectTimeout)??;
    }
    // Identify before encoding, because the firmware decides the animation
    // stride and therefore the bytes. Doing it on this connection rather than
    // in a separate probe matters: the badge leaves Bluetooth mode after an
    // operation, so a second connection is not something we can count on.
    peripheral.discover_services().await?;
    let fw = identify(&peripheral).await;

    let data = match encode(fw) {
        Ok(d) => d,
        Err(e) => {
            let _ = peripheral.disconnect().await;
            return Err(BleError::Message(e));
        }
    };

    let result = write_all(&peripheral, &data, fw, &mut on_progress).await;

    // Stock firmware only latches the upload once the link drops.
    let _ = peripheral.disconnect().await;
    result.map(|()| fw)
}

/// Read the Device Information Service, if there is one.
///
/// Every failure means stock: the service is absent, the characteristic is
/// unreadable, or the value is not text. None of those is worth surfacing,
/// because the only badge that answers is the one running badgemagic.
async fn identify(peripheral: &Peripheral) -> Firmware {
    let chars = peripheral.characteristics();
    let mut seen: Vec<String> = Vec::new();
    for uuid in [MANUFACTURER_CHAR, MODEL_CHAR] {
        if let Some(c) = chars
            .iter()
            .find(|c| c.uuid == uuid && c.service_uuid == DEVINFO_SERVICE)
        {
            if let Ok(v) = peripheral.read(c).await {
                if let Ok(text) = String::from_utf8(v) {
                    seen.push(text);
                }
            }
        }
    }
    crate::firmware::identify(seen.iter().map(|s| Some(s.as_str())))
}

async fn write_all<F>(
    peripheral: &Peripheral,
    data: &[u8],
    fw: Firmware,
    on_progress: &mut F,
) -> Result<(), BleError>
where
    F: FnMut(usize, usize),
{
    let ch = peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == CHAR_UUID)
        .ok_or(BleError::NoCharacteristic)?;

    let chunks: Vec<&[u8]> = data.chunks(CHUNK_SIZE).collect();
    let total = chunks.len();
    for (i, c) in chunks.iter().enumerate() {
        // Retry each chunk a few times. A transient failure mid-transfer is
        // otherwise unrecoverable, since the badge cannot resume and is left
        // half-written.
        let mut last: Option<BleError> = None;
        for attempt in 0..WRITE_ATTEMPTS {
            // An oversized write is not rejected, it is simply never
            // acknowledged, so an unbounded write hangs with no feedback.
            match tokio::time::timeout(
                WRITE_TIMEOUT,
                peripheral.write(&ch, c, WriteType::WithResponse),
            )
            .await
            {
                Ok(Ok(())) => {
                    last = None;
                    break;
                }
                Ok(Err(_)) => last = Some(BleError::Truncated { done: i, total }),
                Err(_) => {
                    last = Some(BleError::WriteTimeout {
                        done: i + 1,
                        total,
                        size: CHUNK_SIZE,
                        secs: WRITE_TIMEOUT.as_secs(),
                    })
                }
            }
            if attempt + 1 < WRITE_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(60)).await;
            }
        }
        if let Some(e) = last {
            // A badge that refuses the very first write is refusing the header
            // itself, which on badgemagic is what an enabled PIN looks like.
            // Only the first: a failure part-way through is an ordinary
            // transfer problem, and blaming the PIN for it would send people
            // to the wrong menu.
            if i == 0 && fw.ble_may_require_pin() {
                return Err(BleError::NeedsPin);
            }
            return Err(e);
        }
        on_progress(i + 1, total);
    }
    Ok(())
}
