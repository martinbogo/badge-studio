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

pub const SERVICE_UUID: Uuid = Uuid::from_u128(0x0000fee0_0000_1000_8000_00805f9b34fb);
pub const CHAR_UUID: Uuid = Uuid::from_u128(0x0000fee1_0000_1000_8000_00805f9b34fb);

/// Stock firmware expects small writes; 16 bytes matches the vendor app.
/// Larger chunks cut the number of round trips proportionally, which matters
/// because the badge drops out of Bluetooth mode after a timeout and truncates
/// anything still in flight.
/// Not a tunable. The firmware never acknowledges a larger write, so an
/// oversized one hangs forever rather than failing.
pub const CHUNK_SIZE: usize = 16;

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
    #[error("badge does not expose characteristic 0xFEE1 (wrong device, or firmware differs)")]
    NoCharacteristic,
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
    /// Advertised service UUIDs, for troubleshooting unrecognised devices.
    pub services: Vec<String>,
    /// Whether this device advertises the badge service.
    pub is_badge: bool,
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

/// Scan for peripherals. With `badges_only`, returns just those advertising the
/// badge service; otherwise returns everything seen, which is how you tell
/// "badge is not advertising" apart from "Bluetooth is not working".
pub async fn scan(timeout_ms: u64, badges_only: bool) -> Result<Vec<BadgeInfo>, BleError> {
    let central = adapter().await?;
    // An empty filter is required to see non-badge devices; CoreBluetooth also
    // returns more reliable results unfiltered, so filter on our side instead.
    central.start_scan(ScanFilter::default()).await?;
    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
    let _ = central.stop_scan().await;

    let mut out = Vec::new();
    for p in central.peripherals().await? {
        let Some(props) = p.properties().await? else {
            continue;
        };
        let is_badge = props.services.contains(&SERVICE_UUID);
        if badges_only && !is_badge {
            continue;
        }
        out.push(BadgeInfo {
            id: p.id().to_string(),
            name: props.local_name,
            rssi: props.rssi,
            services: props.services.iter().map(|u| u.to_string()).collect(),
            is_badge,
        });
    }
    out.sort_by(|a, b| {
        b.is_badge
            .cmp(&a.is_badge)
            .then(b.rssi.unwrap_or(i16::MIN).cmp(&a.rssi.unwrap_or(i16::MIN)))
    });
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
pub async fn send<F>(
    data: &[u8],
    id: Option<&str>,
    mut on_progress: F,
) -> Result<(), BleError>
where
    F: FnMut(usize, usize),
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
    let result = write_all(&peripheral, data, &mut on_progress).await;

    // Stock firmware only latches the upload once the link drops.
    let _ = peripheral.disconnect().await;
    result
}

async fn write_all<F>(
    peripheral: &Peripheral,
    data: &[u8],
    on_progress: &mut F,
) -> Result<(), BleError>
where
    F: FnMut(usize, usize),
{
    peripheral.discover_services().await?;
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
            return Err(e);
        }
        on_progress(i + 1, total);
    }
    Ok(())
}

/// Whether a Bluetooth adapter is present and usable. Surfaces the common
/// setup problems (adapter off, missing OS permission) before the user tries
/// to send something.
pub async fn adapter_status() -> Result<String, BleError> {
    let central = adapter().await?;
    let info = central.adapter_info().await.unwrap_or_default();
    // Touching the peripheral list forces the platform to hand out a session,
    // which is where a permission failure shows up first.
    let _ = central.peripherals().await?;
    Ok(info)
}
