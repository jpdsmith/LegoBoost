// SPDX-License-Identifier: MIT
// Lightweight Web Audio API synthesizer that emulates Vernie's singing-motor sound
// for Demo Mode and optional local browser audio monitoring.

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) {
    try {
      sharedCtx = new Ctor();
    } catch {
      return null;
    }
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume().catch(() => undefined);
  }
  return sharedCtx;
}

const activeNodes = new Set<OscillatorNode>();

export function stopBrowserSynth(): void {
  for (const osc of activeNodes) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      // Already stopped
    }
  }
  activeNodes.clear();
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function scheduleTone(
  ctx: AudioContext,
  startOffsetSec: number,
  durSec: number,
  freqStart: number,
  freqEnd = freqStart,
  gainPeak = 0.08,
  wave: OscillatorType = "triangle"
): void {
  const now = ctx.currentTime + startOffsetSec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = wave;
  osc.frequency.setValueAtTime(Math.max(60, freqStart), now);
  if (freqEnd !== freqStart) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, freqEnd), now + durSec);
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(gainPeak, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.04, durSec));

  osc.connect(gain);
  gain.connect(ctx.destination);
  activeNodes.add(osc);
  osc.onended = () => {
    activeNodes.delete(osc);
    osc.disconnect();
    gain.disconnect();
  };
  osc.start(now);
  osc.stop(now + durSec + 0.02);
}

/**
 * Play either an R2-D2 SFX preset (1..7) or a MIDI note (36..108) via Web Audio.
 * Preset 0 silences active browser audio immediately.
 */
export function playBrowserSynth(presetOrNote: number, durMs = 280): void {
  if (presetOrNote === 0) {
    stopBrowserSynth();
    return;
  }
  const ctx = getAudioContext();
  if (!ctx) return;

  // R2-D2 style SFX presets (1..7) matching Vernie OS firmware
  if (presetOrNote >= 1 && presetOrNote <= 7) {
    switch (presetOrNote) {
      case 1: // Boot Chime: 4-note rising arpeggio
        scheduleTone(ctx, 0.0, 0.11, 523.25, 523.25, 0.08, "triangle");
        scheduleTone(ctx, 0.11, 0.11, 659.25, 659.25, 0.08, "triangle");
        scheduleTone(ctx, 0.22, 0.11, 783.99, 783.99, 0.08, "triangle");
        scheduleTone(ctx, 0.33, 0.18, 1046.5, 1046.5, 0.09, "triangle");
        break;
      case 2: // Happy Chirp
        scheduleTone(ctx, 0.0, 0.09, 680, 1280, 0.08, "triangle");
        scheduleTone(ctx, 0.1, 0.11, 960, 1560, 0.08, "triangle");
        break;
      case 3: // Curious Beep
        scheduleTone(ctx, 0.0, 0.12, 740, 620, 0.07, "triangle");
        scheduleTone(ctx, 0.14, 0.16, 660, 1180, 0.08, "triangle");
        break;
      case 4: // Alarm Squawk
        scheduleTone(ctx, 0.0, 0.14, 920, 420, 0.08, "sawtooth");
        scheduleTone(ctx, 0.16, 0.14, 880, 380, 0.08, "sawtooth");
        break;
      case 5: // Warning Siren
        scheduleTone(ctx, 0.0, 0.22, 540, 1080, 0.07, "square");
        scheduleTone(ctx, 0.22, 0.22, 1080, 540, 0.07, "square");
        break;
      case 6: // Laser Zap
        scheduleTone(ctx, 0.0, 0.24, 1950, 260, 0.09, "sawtooth");
        break;
      case 7: // Victory Fanfare
        scheduleTone(ctx, 0.0, 0.1, 523.25, 523.25, 0.08, "triangle");
        scheduleTone(ctx, 0.1, 0.1, 659.25, 659.25, 0.08, "triangle");
        scheduleTone(ctx, 0.2, 0.1, 783.99, 783.99, 0.08, "triangle");
        scheduleTone(ctx, 0.31, 0.26, 1046.5, 1080, 0.1, "triangle");
        break;
    }
    return;
  }

  // Musical MIDI note
  const clampedDur = Math.max(0.08, Math.min(2.5, durMs / 1000));
  const hz = midiToHz(presetOrNote);
  scheduleTone(ctx, 0, clampedDur, hz, hz, 0.085, "triangle");
}

export function playDartLaunchSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  scheduleTone(ctx, 0, 0.07, 420, 140, 0.11, "sawtooth");
  scheduleTone(ctx, 0.04, 0.16, 1400, 320, 0.07, "triangle");
}
