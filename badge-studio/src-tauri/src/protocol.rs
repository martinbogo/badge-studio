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

//! Encoder for the "wang" LED name badge protocol (CH582 / 44x11 class devices).
//!
//! See PROTOCOL.md at the repo root for the full wire format. Summary:
//! a 64-byte header followed by a column-major bitmap payload, 11 bytes per
//! 8-pixel-wide column block, MSB = leftmost pixel.

use serde::{Deserialize, Serialize};

pub const MAGIC: [u8; 4] = *b"wang";
pub const HEADER_SIZE: usize = 64;
pub const DEVICE_BUFFER: usize = 8192;
pub const BADGE_HEIGHT: usize = 11;
/// LEDs across the panel. Everything the badge can actually show fits here.
pub const BADGE_WIDTH: usize = 44;
/// Columns the firmware advances per animation frame.
///
/// Larger than the panel, so the last four columns of every frame are padding
/// that never lights up. Frames arrive at `BADGE_WIDTH` and are padded out to
/// this when packing; sending them any narrower would land each frame four
/// columns early on the badge.
pub const FRAME_WIDTH: usize = 48;
pub const MAX_MESSAGES: usize = 8;
/// Ceiling from the 8192-byte device buffer. Inherited from the USB-HID lineage
/// of this protocol; 384 of these 738 columns are confirmed reachable over BLE.
pub const MAX_BYTE_COLUMNS: usize = (DEVICE_BUFFER - HEADER_SIZE) / BADGE_HEIGHT; // 738

/// Animation frames per message slot.
///
/// The official BLE app hard-codes `hardwareFrameCount = 8`. Confirmed on
/// hardware that a slot plays all 8. Since there are 8 slots and the badge
/// cycles them, the sequence available is 8 x 8 = 64 frames, not 8.
/// Whether a single slot can hold MORE than 8 is still untested.
pub const ANIMATION_MAX_FRAMES: usize = 8;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    ScrollLeft = 0,
    ScrollRight = 1,
    ScrollUp = 2,
    ScrollDown = 3,
    Fixed = 4,
    Animation = 5,
    /// The reference BLE app calls modes 6 and 7 "snowflake" and "picture".
    /// The USB-HID tool calls them "drop-down" and "curtain", but that is a
    /// different device; these names describe what this hardware's own app
    /// simulates. Wire values are identical either way.
    Snowflake = 6,
    Picture = 7,
    Laser = 8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Column-major bitmap: `columns * 11` bytes.
    pub bitmap: Vec<u8>,
    /// Width in byte columns, i.e. `ceil(width_px / 8)`.
    pub columns: usize,
    pub mode: Mode,
    /// 1..=8
    pub speed: u8,
    pub blink: bool,
    /// Animated border.
    pub ants: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("need at least one message")]
    NoMessages,
    #[error("at most {MAX_MESSAGES} messages, got {0}")]
    TooManyMessages(usize),
    #[error("speed must be 1..=8, got {0}")]
    BadSpeed(u8),
    #[error("brightness must be 25, 50, 75 or 100, got {0}")]
    BadBrightness(u8),
    #[error("bitmap is {got} bytes but {columns} columns implies {want}")]
    BitmapSize {
        got: usize,
        columns: usize,
        want: usize,
    },
    #[error(
        "payload is {got} byte columns ({} px wide), device holds {MAX_BYTE_COLUMNS} ({} px)",
        got * 8, MAX_BYTE_COLUMNS * 8
    )]
    TooLarge { got: usize },
    #[error(
        "{got} animation frames in one slot, but a slot holds {ANIMATION_MAX_FRAMES}. \
         Split the sequence across the 8 message slots instead: the badge cycles \
         them, giving 64 frames in total."
    )]
    TooManyFrames { got: usize },
}

/// Header byte 5: a brightness level in the high nibble, 0 brightest.
///
/// Note that 25% is 0x30 and not 0x40, which is what every other client for
/// these badges sends, including this one until it was tested on hardware.
/// The reference implementation, jnweiger/led-name-badge-ls32, has used 0x40
/// since the option was added in 2019, and this project inherited it from the
/// same reverse engineering.
///
/// On a CH582 badge 0x40 does not dim the display, it corrupts it. The values
/// are a level index rather than a bitmask, and the panel has four levels, so
/// 0x40 is index 4 of 0..3 and the firmware reads past the end of its own
/// table. 0x30 completes the sequence and works. It may well be that 0x40 is
/// correct on the older hardware the reference targets; this is the value for
/// this one.
fn brightness_bits(percent: u8) -> Result<u8, ProtocolError> {
    Ok(match percent {
        100 => 0x00,
        75 => 0x10,
        50 => 0x20,
        25 => 0x30,
        other => return Err(ProtocolError::BadBrightness(other)),
    })
}

/// Wall-clock stamp written into the header. The badge stores it but never
/// displays it, so callers may pass anything.
#[derive(Debug, Clone, Copy, Default)]
pub struct Stamp {
    pub year: u8,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl Stamp {
    pub fn now() -> Self {
        use chrono::{Datelike, Local, Timelike};
        let t = Local::now();
        Stamp {
            year: (t.year() % 100) as u8,
            month: t.month() as u8,
            day: t.day() as u8,
            hour: t.hour() as u8,
            minute: t.minute() as u8,
            second: t.second() as u8,
        }
    }
}

/// Serialize up to 8 messages into the byte stream written to characteristic 0xFEE1.
pub fn pack(
    messages: &[Message],
    brightness: u8,
    stamp: Stamp,
) -> Result<Vec<u8>, ProtocolError> {
    if messages.is_empty() {
        return Err(ProtocolError::NoMessages);
    }
    if messages.len() > MAX_MESSAGES {
        return Err(ProtocolError::TooManyMessages(messages.len()));
    }
    let bright = brightness_bits(brightness)?;

    for m in messages {
        if !(1..=8).contains(&m.speed) {
            return Err(ProtocolError::BadSpeed(m.speed));
        }
        let want = m.columns * BADGE_HEIGHT;
        if m.bitmap.len() != want {
            return Err(ProtocolError::BitmapSize {
                got: m.bitmap.len(),
                columns: m.columns,
                want,
            });
        }
    }

    let total: usize = messages.iter().map(|m| m.columns).sum();
    if total > MAX_BYTE_COLUMNS {
        return Err(ProtocolError::TooLarge { got: total });
    }

    let mut out = vec![0u8; HEADER_SIZE];
    out[0..4].copy_from_slice(&MAGIC);
    out[5] = bright;

    for (i, m) in messages.iter().enumerate() {
        out[6] |= (m.blink as u8) << i;
        out[7] |= (m.ants as u8) << i;
        out[8 + i] = ((m.speed - 1) << 4) | (m.mode as u8);
        out[16 + 2 * i] = (m.columns >> 8) as u8;
        out[17 + 2 * i] = (m.columns & 0xFF) as u8;
    }

    out[38] = stamp.year;
    out[39] = stamp.month;
    out[40] = stamp.day;
    out[41] = stamp.hour;
    out[42] = stamp.minute;
    out[43] = stamp.second;

    for m in messages {
        out.extend_from_slice(&m.bitmap);
    }
    Ok(out)
}

/// Pack a grid of booleans (`BADGE_HEIGHT` rows by N columns of pixels) into
/// the column-major badge layout. Width is padded up to a multiple of 8.
pub fn pixels_to_bitmap(rows: &[Vec<bool>]) -> (Vec<u8>, usize) {
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let cols = width.div_ceil(8);
    let mut buf = Vec::with_capacity(cols * BADGE_HEIGHT);
    for col in 0..cols {
        for row in 0..BADGE_HEIGHT {
            let mut byte = 0u8;
            for bit in 0..8 {
                let x = col * 8 + bit;
                let on = rows.get(row).and_then(|r| r.get(x)).copied().unwrap_or(false);
                if on {
                    byte |= 1 << (7 - bit);
                }
            }
            buf.push(byte);
        }
    }
    (buf, cols)
}

/// Concatenate animation frames horizontally into a single mode-5 filmstrip.
/// Each frame is `BADGE_HEIGHT` rows, padded or truncated to `stride`.
///
/// The stride is the firmware's, not the display's: the stock firmware
/// advances 48 columns per frame even though only 44 light up, and badgemagic
/// advances its real 44. Pad to the wrong one and every frame after the first
/// lands further sideways than the last.
pub fn frames_to_bitmap(frames: &[Vec<Vec<bool>>], stride: usize) -> (Vec<u8>, usize) {
    let mut strip: Vec<Vec<bool>> = vec![Vec::new(); BADGE_HEIGHT];
    for f in frames {
        for (row, out) in strip.iter_mut().enumerate() {
            let src = f.get(row);
            for x in 0..stride {
                out.push(src.and_then(|r| r.get(x)).copied().unwrap_or(false));
            }
        }
    }
    pixels_to_bitmap(&strip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(columns: usize, mode: Mode, speed: u8) -> Message {
        Message {
            bitmap: vec![0; columns * BADGE_HEIGHT],
            columns,
            mode,
            speed,
            blink: false,
            ants: false,
        }
    }

    #[test]
    fn header_layout() {
        let m = msg(3, Mode::Fixed, 6);
        let out = pack(&[m], 100, Stamp::default()).unwrap();
        assert_eq!(&out[0..4], b"wang");
        assert_eq!(out[5], 0x00, "100% brightness");
        // speed 6 -> (6-1)<<4 = 0x50, mode fixed = 4
        assert_eq!(out[8], 0x54);
        assert_eq!(out[16], 0x00);
        assert_eq!(out[17], 0x03, "3 byte columns");
        assert_eq!(out.len(), HEADER_SIZE + 3 * BADGE_HEIGHT);
    }

    #[test]
    fn flags_and_brightness() {
        let mut a = msg(1, Mode::ScrollLeft, 1);
        a.blink = true;
        let mut b = msg(1, Mode::Laser, 8);
        b.ants = true;
        let out = pack(&[a, b], 25, Stamp::default()).unwrap();
        assert_eq!(out[5], 0x30, "dimmest of the four levels");
        assert_eq!(out[6], 0b01, "blink only on message 0");
        assert_eq!(out[7], 0b10, "ants only on message 1");
        assert_eq!(out[8], 0x00);
        assert_eq!(out[9], 0x78, "speed 8 -> 0x70, laser -> 0x08");
    }

    #[test]
    fn msb_is_leftmost_pixel() {
        let mut rows = vec![vec![false; 8]; BADGE_HEIGHT];
        rows[0][0] = true; // top-left
        rows[1][7] = true;
        let (buf, cols) = pixels_to_bitmap(&rows);
        assert_eq!(cols, 1);
        assert_eq!(buf[0], 0x80);
        assert_eq!(buf[1], 0x01);
    }

    #[test]
    fn filmstrip_is_frame_width_per_frame() {
        let frame = vec![vec![true; FRAME_WIDTH]; BADGE_HEIGHT];
        let (buf, cols) = frames_to_bitmap(&[frame.clone(), frame], FRAME_WIDTH);
        assert_eq!(cols, 2 * FRAME_WIDTH / 8, "6 byte columns per frame");
        assert_eq!(buf.len(), cols * BADGE_HEIGHT);
        assert!(buf.iter().all(|&b| b == 0xFF));
    }

    #[test]
    fn rejects_oversized_payload() {
        let m = msg(MAX_BYTE_COLUMNS + 1, Mode::Fixed, 1);
        assert!(matches!(
            pack(&[m], 100, Stamp::default()),
            Err(ProtocolError::TooLarge { .. })
        ));
    }

    #[test]
    fn rejects_bad_inputs() {
        assert!(pack(&[], 100, Stamp::default()).is_err());
        assert!(pack(&[msg(1, Mode::Fixed, 9)], 100, Stamp::default()).is_err());
        assert!(pack(&[msg(1, Mode::Fixed, 1)], 33, Stamp::default()).is_err());
    }
}

#[cfg(test)]
mod stride_tests {
    use super::*;

    /// badgemagic advances 44 columns per animation frame, the stock firmware
    /// 48. Padding to the wrong one walks every frame sideways, which looks
    /// like a corrupt animation rather than a configuration mistake.
    #[test]
    fn the_stride_decides_the_payload_size() {
        let frame = vec![vec![true; 44]; BADGE_HEIGHT];
        let two = vec![frame.clone(), frame];
        let (_, stock) = frames_to_bitmap(&two, 48);
        let (_, magic) = frames_to_bitmap(&two, 44);
        assert_eq!(stock, 2 * 48 / 8);
        assert_eq!(magic, 2 * 44 / 8);
    }

    /// At a 44 stride the frames are not byte-aligned, and that is not a bug
    /// to fix but a fact to know.
    ///
    /// 48 divides by 8, so on stock firmware every frame starts on a fresh
    /// byte column. 44 does not, so on badgemagic frame two begins four pixels
    /// into byte column five. The wire format is happy with that, since the
    /// header declares a count of byte columns and the firmware works in
    /// pixels.
    #[test]
    fn a_44_stride_does_not_land_on_byte_boundaries() {
        let mut a = vec![vec![false; 44]; BADGE_HEIGHT];
        a[0][43] = true; // last pixel of frame one
        let mut b = vec![vec![false; 44]; BADGE_HEIGHT];
        b[0][0] = true; // first pixel of frame two
        let (bytes, cols) = frames_to_bitmap(&[a, b], 44);
        assert_eq!(cols, 11, "88px packs into 11 whole byte columns");
        // Both pixels land in byte column 5: x=43 at bit 4, x=44 at bit 3.
        let col5 = bytes[5 * BADGE_HEIGHT];
        assert_eq!(col5, 0b0001_1000, "the frame boundary sits mid-byte");
    }

    /// An odd number of frames at 44 does not fill a whole number of byte
    /// columns, so the payload is rounded up and the badge sees a sliver of a
    /// further frame. Even counts are exact. Worth knowing before anyone
    /// trusts a three-frame animation on badgemagic.
    #[test]
    fn only_even_frame_counts_are_exact_at_44() {
        for n in 1..=8usize {
            let frames = vec![vec![vec![false; 44]; BADGE_HEIGHT]; n];
            let (_, cols) = frames_to_bitmap(&frames, 44);
            let exact = (44 * n) % 8 == 0;
            assert_eq!(exact, n % 2 == 0, "n={n}");
            assert_eq!(cols, (44 * n).div_ceil(8), "n={n}");
        }
        // The stock stride never has this problem: 48 is a multiple of 8.
        for n in 1..=8usize {
            assert_eq!((48 * n) % 8, 0);
        }
    }
}

#[cfg(test)]
mod width_tests {
    use super::*;

    /// The editor stores animation frames at the display width; the wire format
    /// steps 48 columns per frame. Packing has to bridge that, or every frame
    /// after the first lands 4 columns early on the badge.
    #[test]
    fn display_width_frames_pack_to_the_wire_stride() {
        let narrow = vec![vec![true; BADGE_WIDTH]; BADGE_HEIGHT];
        let (bytes, cols) = frames_to_bitmap(&[narrow.clone(), narrow], FRAME_WIDTH);
        assert_eq!(cols, 2 * FRAME_WIDTH / 8, "two frames at the 48px stride");
        assert_eq!(bytes.len(), cols * BADGE_HEIGHT);

        // Column 44 of each frame is padding and must be dark, or the frame
        // boundary would smear into the next one.
        for frame in 0..2 {
            let col_44 = frame * FRAME_WIDTH + 44;
            let byte = bytes[(col_44 / 8) * BADGE_HEIGHT];
            assert_eq!(byte & 0x0F, 0, "columns 44-47 of frame {frame} must be padding");
        }
    }

    /// A project made before the change still encodes to the same bytes.
    #[test]
    fn wide_frames_still_encode_identically() {
        let narrow = vec![vec![true; BADGE_WIDTH]; BADGE_HEIGHT];
        let mut wide = narrow.clone();
        for row in wide.iter_mut() {
            row.resize(FRAME_WIDTH, false);
        }
        assert_eq!(
            frames_to_bitmap(&[narrow.clone(), narrow], FRAME_WIDTH),
            frames_to_bitmap(&[wide.clone(), wide], FRAME_WIDTH),
        );
    }
}

#[cfg(test)]
mod brightness_tests {
    use super::*;

    /// The four levels are consecutive, 0x00 through 0x30.
    ///
    /// Worth asserting as a shape rather than only as four constants: the
    /// value this project shipped for two years was 0x40, which looks
    /// plausible next to 0x10 and 0x20 and is what other clients send, but
    /// leaves a gap at 0x30 and is one past the last level the panel has. It
    /// did not dim the display, it corrupted it.
    #[test]
    fn the_levels_are_consecutive_with_no_gap() {
        let bits: Vec<u8> = [100u8, 75, 50, 25]
            .iter()
            .map(|p| brightness_bits(*p).unwrap())
            .collect();
        assert_eq!(bits, vec![0x00, 0x10, 0x20, 0x30]);
        // Dimmer is a higher index, and every step is the same size.
        for w in bits.windows(2) {
            assert_eq!(w[1] - w[0], 0x10);
        }
        // Nothing lands outside the four levels the hardware has.
        assert!(bits.iter().all(|b| b >> 4 < 4));
    }

    /// Brightness is header byte 5, sent with every upload. It is the one
    /// display setting that applies to the whole badge rather than a message.
    #[test]
    fn brightness_lands_in_header_byte_5() {
        let frame = vec![vec![true; BADGE_WIDTH]; BADGE_HEIGHT];
        let (bitmap, columns) = pixels_to_bitmap(&frame);
        for (percent, expected) in [(100u8, 0x00u8), (75, 0x10), (50, 0x20), (25, 0x30)] {
            let m = Message {
                bitmap: bitmap.clone(),
                columns,
                mode: Mode::Fixed,
                speed: 4,
                blink: false,
                ants: false,
            };
            let out = pack(&[m], percent, Stamp::now()).unwrap();
            assert_eq!(out[5], expected, "{percent}% should encode as {expected:#04x}");
        }
    }
}

#[cfg(test)]
mod text_length_tests {
    use super::*;

    /// Every glyph is 8px, which is exactly one byte column, so a character
    /// count and a byte-column count are the same number for text.
    #[test]
    fn how_much_text_fits() {
        let render = |chars: usize| {
            let (bitmap, columns) = pixels_to_bitmap(&vec![vec![true; chars * 8]; BADGE_HEIGHT]);
            Message {
                bitmap,
                columns,
                mode: Mode::ScrollLeft,
                speed: 4,
                blink: false,
                ants: false,
            }
        };

        // The device buffer is the hard ceiling for one upload.
        assert!(pack(&[render(MAX_BYTE_COLUMNS)], 100, Stamp::now()).is_ok());
        assert!(pack(&[render(MAX_BYTE_COLUMNS + 1)], 100, Stamp::now()).is_err());

        // It is a shared budget: eight messages draw on the same buffer.
        let each = MAX_BYTE_COLUMNS / 8;
        let eight: Vec<Message> = (0..8).map(|_| render(each)).collect();
        assert!(pack(&eight, 100, Stamp::now()).is_ok());

        println!("hard ceiling: {MAX_BYTE_COLUMNS} characters in one upload");
        println!("  = {} bytes", HEADER_SIZE + MAX_BYTE_COLUMNS * BADGE_HEIGHT);
        println!("split across 8 messages: {each} characters each");
    }
}
