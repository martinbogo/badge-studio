# LED Badge Protocol

Reference for the "wang" protocol used by 44x11 monochrome LED name badges
built on the WCH CH582/CH583. The same byte stream is accepted over both USB
HID and Bluetooth LE.

- [Hardware](#hardware)
- [Transports](#transports) — [USB HID](#usb-hid), [Bluetooth LE](#bluetooth-le)
- [Wire format](#wire-format) — [header](#header), [modes](#modes),
  [speed](#speed), [bitmap payload](#bitmap-payload)
- [Animation](#animation)
- [Capacity](#capacity)
- [Delivery is unverifiable](#delivery-is-unverifiable)

## Hardware

| | |
|---|---|
| MCU | WCH CH582 (RISC-V, integrated BLE) |
| Display | 44 x 11 monochrome LED matrix |
| Device buffer | 8192 bytes |
| Message slots | 8 |
| USB | VID `0x0416`, PID `0x5020`, enumerates as `wch.cn` / `CH583` |
| Hardware revisions | silkscreen `250901` or `260404` |

The LEDs are mounted on a tilt, so pixels are close to square on screen despite
the 44x11 grid being wider than it is tall.

## Transports

Both transports carry the identical stream described under
[Wire format](#wire-format). Only the framing differs: 64-byte HID reports
versus 16-byte GATT writes.

USB is the better path wherever it is available. It needs no pairing, no button
press, and cannot time out part-way through a transfer.

### USB HID

The stock firmware exposes a vendor-defined HID interface. No reflashing is
required to use it.

```
idVendor  0x0416 (wch.cn)      idProduct 0x5020 ("CH583")
bDeviceClass 0                 bNumConfigurations 1
Interface 0: bInterfaceClass 3 (HID), SubClass 0, Protocol 0, bNumEndpoints 2
```

Report descriptor:

```
06 00 FF     Usage Page (vendor-defined 0xFF00)
09 01        Usage (1)
A1 01        Collection (Application)
09 02          Usage (2)
15 00          Logical Minimum (0)
26 00 FF       Logical Maximum (255)
75 08          Report Size (8)
95 40          Report Count (64)
81 06          Input  (Data, Var, Rel)
09 02          Usage (2)
15 00 26 00 FF 75 08 95 40
91 06          Output (Data, Var, Rel)
C0           End Collection
```

**64-byte input and output reports, no report ID.** SubClass 0 and Protocol 0
mean this is not a boot keyboard or mouse, so a userspace tool can claim the
interface without fighting the operating system's own HID driver.

To send: write the stream as consecutive 64-byte output reports. Report Count
is fixed at 64, so the payload must be **zero-padded to a multiple of 64**; a
short final report is a malformed transfer rather than a partial one. APIs that
expect a leading report-ID byte take a literal `0x00`, which the device never
sees.

There is no CDC/serial interface on the stock firmware.

Reading the descriptors from a host:

```
ioreg -w0 -l -r -n CH583 | grep -E "bInterfaceClass|ReportDescriptor"   # macOS
lsusb -v -d 0416:5020                                                   # Linux
```

On macOS, `system_profiler SPUSBDataType` returns nothing when sandboxed;
`ioreg` works either way.

On Linux the device node is root-only unless a udev rule grants access. See
[`99-led-badge.rules`](99-led-badge.rules).

### Bluetooth LE

| | |
|---|---|
| Advertised name | `LSLED` |
| Service | `0000fee0-0000-1000-8000-00805f9b34fb` |
| Characteristic | `0000fee1-0000-1000-8000-00805f9b34fb` |

Scan filtering on the `FEE0` service UUID in the advertisement is reliable.

**Writes must be 16 bytes.** Anything larger is not rejected, it is simply never
acknowledged, so an oversized write hangs indefinitely with no feedback. Use
write-with-response and send chunks sequentially. An inter-chunk delay is not
required.

The badge latches the upload when the link drops, so disconnect after the final
write.

#### Getting the badge to advertise

The badge does not advertise by default:

1. **Unplug it from USB.** It stays silent over Bluetooth while connected,
   which is indistinguishable from a broken Bluetooth stack unless the tool
   says so.
2. **Press the first button.** A Bluetooth icon appears once it is ready.

It **leaves Bluetooth mode after every upload**, so the button press has to be
repeated before each send. A tool that caches the peripheral will fail its
second write with a "no longer reachable" error. That is expected.

#### Bluetooth mode expires on a timer

Bluetooth mode also lapses on its own after a few minutes, **including
mid-upload if the transfer is slow enough**. The badge stops acknowledging
writes and the connection hangs rather than failing, leaving a half-written
buffer that displays the first frames correctly followed by stale contents.

This makes upload *duration* a hard constraint:

```
writes = ceil((64 + columns * 11) / 16)
```

A 64-frame animation is 268 writes; a short text message is 11. That is why
text always lands and long animations sometimes do not. What helps, in order:

1. **Signal strength.** Throughput varies by roughly 2x at around -84 dBm.
   Moving the badge closer is free.
2. **Fewer frames.** Fewer bytes, less exposure.
3. **Press the button immediately before sending**, so none of the window has
   already elapsed.

**A failed BLE upload cannot be resumed.** The badge does not track a write
position across a reconnect, so continuing from a byte offset produces a
garbled buffer rather than a finished one. Send again from the start.

BLE writing to this device is not dependable at large payload sizes, and no
mitigation makes it so. Use USB for anything large.

## Wire format

A 64-byte header followed by the bitmap payload. Up to 8 independent messages
share one upload.

### Header

```
off  size  field
  0   4    magic "wang" (77 61 6E 67)
  4   1    always 0x00
  5   1    brightness: 0x00=100%  0x10=75%  0x20=50%  0x30=25%
  6   1    blink bitmask, bit i = message i
  7   1    animated border bitmask, bit i = message i
  8   8    per-message option byte: (speed-1) << 4 | mode
 16  16    per-message length, big-endian u16, in BYTE COLUMNS (not pixels)
 32   6    zero
 38   6    year%100, month, day, hour, minute, second
 44  20    zero
 64   -    bitmap payload
```

Unused message slots have a length of 0; the rest of their fields are
don't-care. The timestamp is stored but never displayed.

### A note on byte 5

Brightness is a level index in the high nibble, counting from 0 as the
brightest, and the panel has four levels. So the dimmest is `0x30`.

This is worth stating plainly because most other clients for these badges send
`0x40` for 25%, including the widely used
[led-name-badge-ls32](https://github.com/jnweiger/led-name-badge-ls32), which
has done so since the option was added in 2019. This document said `0x40` too,
inherited from the same reverse engineering.

On a CH582 badge `0x40` does not dim the display, it corrupts it: the value is
an index rather than a bitmask, so `0x40` is index 4 of a table with entries
0 to 3. The mistake is easy to make because `0x00`, `0x10`, `0x20`, `0x40`
looks like a plausible set of bit flags, and nothing complains until you
actually select the lowest brightness on hardware.

`0x40` may well be correct on the older badges the other clients target. `0x30`
is the value for this one.

### Modes

Low nibble of the option byte.

| val | mode | behaviour |
|---|---|---|
| 0 | scroll left | bitmap scrolls right to left |
| 1 | scroll right | bitmap scrolls left to right |
| 2 | scroll up | scrolls in, holds 15 steps, scrolls out |
| 3 | scroll down | same, downward |
| 4 | fixed | centred, static |
| 5 | animation | pages through the bitmap one display-width at a time |
| 6 | snowflake | rows fall in from the top staggered, settle, then fall out |
| 7 | picture | two lit columns sweep out from the centre, revealing the bitmap between them, then outside them |
| 8 | laser | a column advances left to right; each lit pixel fires a beam to the right edge and the bitmap is left standing behind. The second half erases the same way from the left |

### Speed

1 to 8, stored as `speed - 1` in the high nibble of the option byte.

Measured on hardware: an 8-frame animation at speed 6 completes 5 loops in 10
seconds, so **250 ms per frame at speed 6**.

| speed | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| ms per frame | 552 | 491 | 431 | 371 | 310 | **250** | 190 | 129 |

Two caveats on that table:

- **Only speed 6 is measured.** The linear shape either side of it is assumed.
  Treat the rest as a falsifiable prediction: at speed 2 one loop of an 8-frame
  animation should take about 3.9 seconds.
- **Only animation frames are measured.** Scroll steps are assumed to tick at
  the same rate, which is unverified.

### Bitmap payload

Column-major. For each 8-pixel-wide column block, 11 bytes, one per row top to
bottom. Within a byte, the MSB is the leftmost pixel.

```
byte index = column_block * 11 + row
bit  (7-n) = pixel at x = column_block*8 + n
```

Length fields count **byte columns** (`ceil(width_px / 8)`), not pixels. Text
glyphs are 8 px wide, so one glyph is exactly one byte column.

## Animation

Mode 5 treats a message's bitmap as a horizontal filmstrip. Each frame is 11 px
tall and **as wide as the firmware advances per frame**, which is not the same
as the display width and not the same on both firmwares:

| Firmware | Frame width |
|---|---|
| Stock | 48 px, on both 44 px and 48 px displays |
| badgemagic | 44 px, its own `LED_COLS` |

N frames become one image `N * width` px wide. Speed sets the frame rate.

Padding to the wrong one does not fail, it walks: every frame after the first
lands further sideways than the last, which looks like a corrupt animation
rather than a mismatched assumption. See [Telling the two apart](#firmware)
below.

At 44 the frames are not byte-aligned, because 44 does not divide by 8. An odd
number of frames therefore does not fill a whole number of byte columns, the
payload is rounded up, and the badge sees a sliver of a further frame. Even
counts are exact. The stock 48 never has this problem.

**A slot holds 8 animation frames, and there are 8 slots, so a full sequence is
64 frames.** The badge cycles between slots, and each slot runs its own
filmstrip. Confirmed on hardware with a diagnostic in which every frame carried
a digit for its slot and a marker for its frame index: all eight digits cycled
and the marker swept fully between each.

Whether a single slot can hold more than 8 frames is untested. The one attempt
at 24 frames failed on the Bluetooth timeout rather than on size, so the
question is open.

<a id="firmware"></a>

## Telling the two firmwares apart

Both the stock firmware and the open
[badgemagic](https://github.com/fossasia/badgemagic-firmware) firmware speak
this protocol: same magic, same 16-byte writes, same mode and speed packing,
same length arithmetic. Two things differ, and both matter to a client.

**The animation frame width**, as above.

**Bluetooth may want a PIN.** badgemagic has an optional four-digit code,
displayed on the badge when it enters BT-PAIRING. It is off by default and
stored in flash, so nothing readable from the device says in advance whether a
given badge wants one; the badge answers by rejecting the first `wang` write
with `ATT_ERR_UNLIKELY` (0x0E). The code is sent as four ASCII digits in bytes
0-3 of its own 16-byte write, zero-padded, before any `wang` packet. A new code
is generated on each entry to pairing mode and the authorisation resets on every
disconnect. USB has no such gate on either firmware.

Which firmware is running can be read off the device rather than configured:

| Transport | Where | badgemagic reports |
|---|---|---|
| USB | descriptor strings | manufacturer `FOSSASIA WAS HERE`, product `LED Badge Magic`, serial `BM1144 fw: vX.Y.Z` |
| Bluetooth | Device Information Service `0x180A` | manufacturer `0x2A29` = `FOSSASIA`, model `0x2A24` = `BM1144` |

The stock firmware exposes no Device Information Service at all, so its absence
is itself the answer. VID and PID are identical on both (`0x0416`/`0x5020`) and
cannot be used.

Do **not** use the advertised Bluetooth name. It lives in
`badge_cfg.ble_devname` and the user can change it; its default merely happens
to contain the vendor's name.

## Capacity

The theoretical ceiling from the 8192-byte device buffer:

```
payload_max = 8192 - 64        = 8128 bytes
columns_max = floor(8128 / 11) = 738 byte columns
```

That ceiling has not been reached over BLE. What has actually been confirmed to
transfer:

| payload | columns | bytes | 16-byte writes | result |
|---|---|---|---|---|
| text, 9 glyphs | 9 | 163 | 11 | uploaded, displayed |
| 1 slot, 8 frames | 48 | 592 | 37 | uploaded, displayed |
| 1 slot, 24 frames | 144 | 1648 | 103 | stalled at write 60 |
| 1 slot, 60 frames | 360 | 4024 | 252 | stalled part-way |
| **8 slots, 8 frames each** | **384** | **4288** | **268** | **uploaded, all 64 frames played** |

The stalls are **not a size limit**. A 4288-byte payload transfers fine and is
larger than both failures. Those uploads died on the Bluetooth-mode timeout,
which varies with signal strength and transfer rate. Over USB the same 4288
bytes is 67 reports and the question does not arise.

## Delivery is unverifiable

There is no checksum, no read-back, and no acknowledgement at the application
layer.

The BLE characteristic `fee1` advertises read and notify in addition to write,
and a GATT dump confirms it, but what those do is undocumented and unknown. The
same is true of the HID interface's input reports. Nothing has been observed
coming back from the badge on either transport.

In practice a tool cannot distinguish a completed upload from a truncated one
except by looking at the display. Transport-level success means the bytes were
accepted by the link, not that the badge parsed them.
