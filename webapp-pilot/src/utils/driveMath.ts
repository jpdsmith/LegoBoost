// SPDX-License-Identifier: MIT
// Pure arcade-to-tank differential drive mixer.

export function mixArcadeToTank(
  x: number,
  y: number,
  maxSpeedPct: number
): { left: number; right: number } {
  const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));
  const cx = Math.abs(x) < 0.12 ? 0 : clampUnit(x);
  const cy = Math.abs(y) < 0.12 ? 0 : clampUnit(y);
  const rawL = cy + cx;
  const rawR = cy - cx;
  const peak = Math.max(1, Math.abs(rawL), Math.abs(rawR));
  const scale = Math.max(10, Math.min(100, maxSpeedPct));
  return {
    left: Math.round((rawL / peak) * scale),
    right: Math.round((rawR / peak) * scale),
  };
}
