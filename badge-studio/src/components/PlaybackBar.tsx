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

interface Props {
  playing: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  /** "frame 3 / 8", or "2/8 · frame 3 / 8" across the whole sequence. */
  frameLabel: string | null;
  step: number;
  period: number;
  onScrub: (step: number) => void;
  onJog: (delta: number) => void;
  scope: "message" | "sequence";
  onScope: (s: "message" | "sequence") => void;
  canSequence: boolean;
}

/**
 * Transport for the preview, sitting directly under it.
 *
 * These belong with the picture they control rather than at the far edge of the
 * window next to the upload controls, which are a different job entirely.
 */
export default function PlaybackBar({
  playing,
  onTogglePlay,
  onRestart,
  frameLabel,
  step,
  period,
  onScrub,
  onJog,
  scope,
  onScope,
  canSequence,
}: Props) {
  const idle = period <= 1;

  return (
    <div className="playback">
      <button
        className="transport-btn"
        onClick={onTogglePlay}
        disabled={idle}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button
        className="transport-btn"
        onClick={onRestart}
        disabled={idle}
        title="Back to the start"
        aria-label="Back to the start"
      >
        ⏮
      </button>
      <button
        className="transport-btn"
        onClick={() => onJog(-1)}
        disabled={idle}
        title="Previous step (Left arrow)"
        aria-label="Previous step"
      >
        ‹
      </button>
      <button
        className="transport-btn"
        onClick={() => onJog(1)}
        disabled={idle}
        title="Next step (Right arrow)"
        aria-label="Next step"
      >
        ›
      </button>

      <input
        type="range"
        className="scrub"
        min={0}
        max={Math.max(0, period - 1)}
        value={Math.min(step, Math.max(0, period - 1))}
        disabled={idle}
        onChange={(e) => onScrub(Number(e.target.value))}
        title={
          idle
            ? "Nothing to scrub: this message is a single still"
            : "Drag to step through"
        }
        aria-label="Scrub through the preview"
      />

      <span className="mu tabular playback-pos">{frameLabel}</span>

      {canSequence && (
        <label
          className="check"
          title="Play every message in order, the way the badge cycles them"
        >
          <input
            type="checkbox"
            checked={scope === "sequence"}
            onChange={(e) => onScope(e.target.checked ? "sequence" : "message")}
          />
          All messages
        </label>
      )}
    </div>
  );
}
