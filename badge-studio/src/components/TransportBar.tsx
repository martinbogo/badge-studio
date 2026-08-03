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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { byteColumns } from "../badge";
import {
  KNOWN_GOOD_COLUMNS,
  type BadgeInfo,
  type Brightness,
  type Message,
} from "../types";

interface Props {
  messages: Message[];
  brightness: Brightness;
  onBrightness: (b: Brightness) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  /** "frame 3 / 8" in animation mode, "still" for fixed, null otherwise. */
  frameLabel: string | null;
  /** Current position in the preview loop, and how many steps it runs for. */
  step: number;
  period: number;
  /** Scrub to an absolute step, or jog by a relative number of steps. */
  onScrub: (step: number) => void;
  onJog: (delta: number) => void;
}

interface Progress {
  chunk: number;
  total: number;
}

interface UsbInfo {
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
}

/** Rust pushes this whenever the badge is plugged in or unplugged. */
const USB_PRESENCE = "usb-presence";

function toSpec(m: Message) {
  return {
    frames: m.mode === "animation" ? m.frames : [m.frames[0]],
    mode: m.mode,
    speed: m.speed,
    blink: m.blink,
    ants: m.ants,
  };
}

/** The two steps that get the badge advertising. Shown whenever it matters. */
function PairingSteps() {
  return (
    <ol className="pairing-steps">
      <li>
        <strong>Unplug the badge from USB.</strong> It will not advertise over
        Bluetooth while it is connected.
      </li>
      <li>
        <strong>Press the first button</strong> to enter Bluetooth mode. The
        badge shows a Bluetooth icon once it is ready. It leaves Bluetooth mode
        again after every upload.
      </li>
    </ol>
  );
}

export default function TransportBar({
  messages,
  brightness,
  onBrightness,
  playing,
  onTogglePlay,
  onRestart,
  frameLabel,
  step,
  period,
  onScrub,
  onJog,
}: Props) {
  const [badges, setBadges] = useState<BadgeInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scan" | "send" | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPairing, setShowPairing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [chunkSize, setChunkSize] = useState(16);
  const [delayMs, setDelayMs] = useState(0);
  const [withoutResponse, setWithoutResponse] = useState(false);
  const startedAt = useRef<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [gatt, setGatt] = useState<string | null>(null);
  const [usb, setUsb] = useState<UsbInfo | null>(null);

  useEffect(() => {
    const un = listen<Progress>("send-progress", (e) => {
      setProgress(e.payload);
      if (startedAt.current) {
        const secs = (Date.now() - startedAt.current) / 1000;
        if (secs > 0.5) setRate(e.payload.chunk / secs);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const sending = busy === "send";

  // USB is the better path when it is there, so watch for the cable rather than
  // making the user tell us. Rust pushes plug and unplug events from the OS, so
  // this is immediate rather than up to a poll interval late. The invoke is
  // only a backstop for the window before the watcher's first emit lands.
  useEffect(() => {
    let alive = true;
    const un = listen<UsbInfo | null>(USB_PRESENCE, (e) => {
      if (alive) setUsb(e.payload);
    });
    invoke<UsbInfo | null>("usb_find")
      .then((found) => {
        if (alive) setUsb(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  const used = messages.reduce((n, m) => n + byteColumns(m), 0);
  const bytes = 64 + used * 11;
  const unproven = used > KNOWN_GOOD_COLUMNS;
  const pct = Math.min(100, Math.round((used / KNOWN_GOOD_COLUMNS) * 100));

  const scan = useCallback(
    async (all: boolean): Promise<BadgeInfo[]> => {
      const found = await invoke<BadgeInfo[]>("ble_scan", {
        timeoutMs: 6000,
        badgesOnly: !all,
      });
      setBadges(found);
      const real = found.filter((b) => b.is_badge);
      if (real.length) setSelected((s) => (real.some((b) => b.id === s) ? s : real[0].id));
      return real;
    },
    []
  );

  const onScan = useCallback(async () => {
    setBusy("scan");
    setError(null);
    try {
      const real = await scan(showAll);
      if (!real.length) {
        setError("No badge found.");
        setShowPairing(true);
      } else {
        setStatus(`Found ${real[0].name ?? "badge"}.`);
        setShowPairing(false);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [scan, showAll]);

  /**
   * Record always presses. USB wins whenever the cable is in: it needs no
   * pairing, no button press, and cannot time out mid-transfer. Otherwise this
   * falls back to Bluetooth, scanning first if no badge is known yet, so the
   * button never sits dead and the pairing steps appear where you are looking.
   */
  const onRecord = useCallback(
    async () => {
      setError(null);
      setStatus(null);
      setProgress(null);

      if (usb) {
        setBusy("send");
        startedAt.current = Date.now();
        setRate(null);
        try {
          const sent = await invoke<number>("send_to_badge_usb", {
            messages: messages.map(toSpec),
            brightness,
          });
          setStatus(`Sent ${sent} bytes over USB.`);
        } catch (e) {
          const err = e as { message?: string };
          setError(err?.message ?? String(e));
        } finally {
          setBusy(null);
          setProgress(null);
          startedAt.current = null;
        }
        return;
      }

      let target = selected;
      if (!target) {
        setBusy("scan");
        try {
          const real = await scan(false);
          target = real[0]?.id ?? null;
        } catch (e) {
          setError(String(e));
          setBusy(null);
          return;
        }
        setBusy(null);
        if (!target) {
          setError("No badge found.");
          setShowPairing(true);
          return;
        }
      }

      setBusy("send");
      startedAt.current = Date.now();
      setRate(null);
      try {
        const sent = await invoke<number>("send_to_badge", {
          messages: messages.map(toSpec),
          brightness,
          deviceId: target,
          chunkSize,
          delayMs,
          withoutResponse,
        });
        setStatus(
          `Sent ${sent} bytes. The badge leaves Bluetooth mode after an upload, ` +
            `so press the first button again before sending anything else.`
        );
        setShowPairing(true);
        setSelected(null);
      } catch (e) {
        const err = e as { message?: string };
        setError(err?.message ?? String(e));
        setShowPairing(true);
        setSelected(null);
      } finally {
        setBusy(null);
        setProgress(null);
        startedAt.current = null;
      }
    },
    [usb, selected, scan, messages, brightness, chunkSize, delayMs, withoutResponse]
  );

  /** Dump the badge's GATT table, to see if it offers any delivery feedback. */
  const inspect = useCallback(async () => {
    setBusy("scan");
    setError(null);
    setStatus(null);
    setShowPairing(false);
    setGatt(null);
    try {
      const svcs = await invoke<
        { uuid: string; characteristics: { uuid: string; properties: string[] }[] }[]
      >("ble_inspect", { deviceId: selected });
      setGatt(
        svcs
          .map(
            (s) =>
              `${s.uuid}\n` +
              s.characteristics
                .map((c) => `    ${c.uuid}  [${c.properties.join(", ")}]`)
                .join("\n")
          )
          .join("\n")
      );
    } catch (e) {
      setError(String(e));
      setShowPairing(true);
    } finally {
      setBusy(null);
    }
  }, [selected]);

  const detail =
    busy || progress || error || status || showPairing || showSettings || gatt;

  const dismiss = () => {
    setError(null);
    setStatus(null);
    setShowPairing(false);
    setShowSettings(false);
    setGatt(null);
  };

  return (
    <div className="transport">
      <div className="transport-main">
        <div className="tgroup">
          <button
            className="transport-btn"
            onClick={onTogglePlay}
            title={playing ? "Pause preview (Space)" : "Play preview (Space)"}
            aria-label={playing ? "Pause preview" : "Play preview"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            className="transport-btn"
            onClick={onRestart}
            title="Back to the first step"
            aria-label="Restart preview"
          >
            ⏮
          </button>
          <button
            className="transport-btn"
            onClick={() => onJog(-1)}
            disabled={period <= 1}
            title="Previous step (Left arrow)"
            aria-label="Previous step"
          >
            ‹
          </button>
          <button
            className="transport-btn"
            onClick={() => onJog(1)}
            disabled={period <= 1}
            title="Next step (Right arrow)"
            aria-label="Next step"
          >
            ›
          </button>
          {/* One scrub bar covers every mode: animation frames, scroll
              position, effect position. Dragging it pauses the preview. */}
          <input
            type="range"
            className="scrub"
            min={0}
            max={Math.max(0, period - 1)}
            value={Math.min(step, Math.max(0, period - 1))}
            disabled={period <= 1}
            onChange={(e) => onScrub(Number(e.target.value))}
            title={
              period > 1
                ? "Drag to step through the animation"
                : "Nothing to scrub: this message is a single still"
            }
            aria-label="Scrub through the animation"
          />
          {frameLabel && <span className="mu tabular">{frameLabel}</span>}
        </div>

        <div className="tgroup payload">
          <span className={unproven ? "warn" : "mu"}>{bytes} bytes</span>
          <div className="capacity-bar wide" title={`${used} byte columns`}>
            <div
              className={`capacity-fill${unproven ? " over" : ""}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {unproven && (
            <span
              className="warn small"
              title={`Above ${KNOWN_GOOD_COLUMNS} byte columns, the largest payload confirmed to transfer. Larger uploads have stalled part-way.`}
            >
              beyond tested size
            </span>
          )}
        </div>

        <div className="tgroup">
          <span className="group-tag">Badge</span>
          <label title="Display brightness on the badge">
            <select
              value={brightness}
              onChange={(e) => onBrightness(Number(e.target.value) as Brightness)}
              disabled={sending}
            >
              {[100, 75, 50, 25].map((b) => (
                <option key={b} value={b}>
                  {b}%
                </option>
              ))}
            </select>
          </label>
          <button
            className="transport-btn wide"
            onClick={() => setShowSettings((v) => !v)}
            title="Transport settings"
            aria-label="Transport settings"
          >
            ⚙
          </button>
          {usb ? (
            // Nothing to configure on this path, so say what it found and stop.
            <span
              className="transport-chip"
              title={`${usb.manufacturer ?? "unknown"} ${usb.product ?? ""}, connected over USB. Bluetooth is not needed while the cable is in.`}
            >
              USB
            </span>
          ) : (
            <button onClick={onScan} disabled={busy !== null}>
              {busy === "scan" ? "Scanning..." : "Scan"}
            </button>
          )}
          {!usb && badges.some((b) => b.is_badge) && (
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              disabled={sending}
              className="device-select"
            >
              {badges.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.is_badge}>
                  {b.is_badge ? "" : "(not a badge) "}
                  {b.name || "(unnamed)"}
                  {b.rssi !== null ? `  ${b.rssi} dBm` : ""}
                </option>
              ))}
            </select>
          )}
          <button
            className={`record${sending ? " armed" : ""}`}
            onClick={() => onRecord()}
            disabled={busy !== null || !messages.length}
            title={usb ? "Send this to the badge over USB" : "Send this to the badge over Bluetooth"}
          >
            <span className="record-dot" aria-hidden="true" />
            {sending && progress
              ? `${progress.chunk}/${progress.total}`
              : busy === "scan"
                ? "Finding..."
                : "Record"}
          </button>
        </div>
      </div>

      {detail && (
        <div className="transport-detail">
          {!busy && (
            <button
              className="ghost detail-close"
              onClick={dismiss}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
          {busy === "scan" && (
            <>
              <div className="send-progress">
                <div className="send-progress-fill indeterminate" />
              </div>
              <span className="mu small">
                Scanning for a badge, up to 6 seconds...
              </span>
            </>
          )}

          {progress && (
            <div className="send-progress">
              <div
                className="send-progress-fill"
                style={{ width: `${(progress.chunk / progress.total) * 100}%` }}
              />
            </div>
          )}
          {progress && rate && (
            <span className="mu small">
              {rate.toFixed(1)}/s, ~
              {Math.max(0, Math.round((progress.total - progress.chunk) / rate))}s
              left
            </span>
          )}

          {error && <p className="error">{error}</p>}
          {!error && status && <p className="mu small">{status}</p>}

          {gatt && <pre className="gatt-dump">{gatt}</pre>}

          {showPairing && <PairingSteps />}

          {showSettings && (
            <div className="transport-settings">
              <label>
                Chunk
                <select
                  value={chunkSize}
                  onChange={(e) => setChunkSize(Number(e.target.value))}
                  disabled={sending}
                >
                  {[16, 20, 32, 64, 128].map((n) => (
                    <option key={n} value={n}>
                      {n} B{n === 16 ? " (only known-good)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Delay
                <select
                  value={delayMs}
                  onChange={(e) => setDelayMs(Number(e.target.value))}
                  disabled={sending}
                >
                  {[0, 10, 30, 60, 120].map((n) => (
                    <option key={n} value={n}>
                      {n} ms
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={withoutResponse}
                  onChange={(e) => setWithoutResponse(e.target.checked)}
                  disabled={sending}
                />
                Write without response
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  disabled={busy !== null}
                />
                Show all devices
              </label>
              <span className="mu small">
                {Math.ceil(bytes / chunkSize)} writes. Anything above 16 bytes is
                never acknowledged by this firmware and will hang.
              </span>
              <button onClick={inspect} disabled={busy !== null}>
                Inspect GATT
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
