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

//! Which firmware is on the badge, and what that changes.
//!
//! The stock firmware and the open badgemagic firmware speak the same wire
//! format: the same "wang" header, the same 16-byte BLE writes, the same mode
//! and speed packing, and the same length arithmetic. What differs is how far
//! an animation advances per frame, and whether Bluetooth wants a PIN first.
//!
//! Both are identified rather than configured. Asking the user which firmware
//! they flashed is asking a question the badge can answer itself, and a wrong
//! answer produces an upload that looks fine and plays wrong.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Firmware {
    /// What the badge ships with.
    Stock,
    /// github.com/fossasia/badgemagic-firmware
    BadgeMagic,
}

impl Firmware {
    /// Columns the firmware advances per animation frame.
    ///
    /// The stock firmware steps 48 even though only 44 are visible, so a
    /// filmstrip has to be padded to 48 or the frames walk sideways.
    /// badgemagic steps its own `LED_COLS`, which is the real 44. Send a
    /// 48-strided strip to it and every frame lands 4px further off than the
    /// last.
    pub fn animation_stride(self) -> usize {
        match self {
            Firmware::Stock => crate::protocol::FRAME_WIDTH,
            // Its own LED_COLS, which is simply the display. Naming it that
            // way rather than as 44 is the point: badgemagic has no padded
            // stride, it steps the panel.
            Firmware::BadgeMagic => crate::protocol::BADGE_WIDTH,
        }
    }

    /// Whether Bluetooth uploads have to authenticate before the header is
    /// accepted.
    ///
    /// badgemagic generates a random four-digit code when the badge enters
    /// BT-PAIRING and shows it on the display. Until those four ASCII digits
    /// arrive in their own write, a "wang" header is rejected outright. USB
    /// has no such gate.
    pub fn ble_needs_pin(self) -> bool {
        self == Firmware::BadgeMagic
    }
}

impl Default for Firmware {
    /// Unknown means stock. Every badge leaves the factory that way, and the
    /// open firmware is the thing someone has deliberately flashed.
    fn default() -> Self {
        Firmware::Stock
    }
}

/// The manufacturer badgemagic reports over both transports.
///
/// Matched as a prefix: USB says "FOSSASIA WAS HERE" and the Bluetooth Device
/// Information Service says "FOSSASIA", and neither is worth pinning exactly.
const VENDOR: &str = "FOSSASIA";

/// Secondary marks, for a fork that rewrites the vendor string but keeps the
/// rest. "BM1144" is the model number, which appears in the USB serial
/// descriptor and in the Bluetooth model characteristic.
const MARKS: [&str; 2] = ["BADGE MAGIC", "BM1144"];

/// Identify from whatever strings a transport managed to read.
///
/// Deliberately tolerant: any one field is enough. The USB serial descriptor
/// is missing on some hosts unless the device can be opened, and on Linux that
/// needs the udev rule, so keying on a single field would make detection
/// depend on permissions.
pub fn identify<'a>(fields: impl IntoIterator<Item = Option<&'a str>>) -> Firmware {
    for field in fields.into_iter().flatten() {
        let up = field.to_ascii_uppercase();
        if up.starts_with(VENDOR) || MARKS.iter().any(|m| up.contains(m)) {
            return Firmware::BadgeMagic;
        }
    }
    Firmware::Stock
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact strings the firmware compiles in, from its own source:
    /// vendor_info and product_info in src/usb/dev.c, and the Device
    /// Information Service in src/ble/profile/devinfo.c.
    #[test]
    fn recognises_badgemagic_over_usb() {
        assert_eq!(
            identify([
                Some("FOSSASIA WAS HERE"),
                Some("LED Badge Magic"),
                Some("BM1144 fw: v1.2.3"),
            ]),
            Firmware::BadgeMagic
        );
    }

    #[test]
    fn recognises_badgemagic_over_ble() {
        // Manufacturer name and model number characteristics.
        assert_eq!(identify([Some("FOSSASIA")]), Firmware::BadgeMagic);
        assert_eq!(identify([Some("BM1144-C")]), Firmware::BadgeMagic);
    }

    #[test]
    fn any_single_field_is_enough() {
        // A host that could not read the serial descriptor still identifies.
        assert_eq!(
            identify([Some("FOSSASIA WAS HERE"), None, None]),
            Firmware::BadgeMagic
        );
        assert_eq!(identify([None, None, Some("BM1144-C")]), Firmware::BadgeMagic);
    }

    #[test]
    fn anything_else_is_stock() {
        assert_eq!(identify([None, None, None]), Firmware::Stock);
        assert_eq!(identify([Some(""), Some("LS LED BADGE")]), Firmware::Stock);
    }

    /// The advertised Bluetooth name must never be used to identify: it lives
    /// in `badge_cfg.ble_devname` and the user can change it. Its default
    /// happens to contain a mark, which is exactly the trap.
    #[test]
    fn the_two_firmwares_stride_differently() {
        assert_eq!(Firmware::Stock.animation_stride(), 48);
        assert_eq!(Firmware::BadgeMagic.animation_stride(), 44);
        assert!(!Firmware::Stock.ble_needs_pin());
        assert!(Firmware::BadgeMagic.ble_needs_pin());
    }
}
