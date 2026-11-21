// SPDX-License-Identifier: MIT
// Interactive Live Vernie Digital Twin — reflects live telemetry (or Demo simulation):
// head rotation, expressive orange eyebrows, eye tracking & blinking, Hub RGB glow,
// 88007 chest distance/color sensor, animated tank treads, IMU tilt, and dart recoil.

import React, { useEffect, useState } from "react";
import { ChestLedState, MODE_NAMES, TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";

export interface VernieTwinProps {
  connected: boolean;
  demoMode: boolean;
  telemetry: TelemetryFrame | null;
  hubRgb: [number, number, number];
  chestLedState: number;
  homingInProgress: boolean;
  dartFiredAt: number;
  onTapFace?: () => void;
  onLaunchDemo?: () => void;
  onDemoTogglePickup?: () => void;
  onDemoBump?: () => void;
  onDemoBrick?: (colorId: number) => void;
}

const LEGO_BRICK_MAP: Record<number, { name: string; hex: string }> = {
  0: { name: "Clear", hex: "transparent" },
  3: { name: "Blue Brick", hex: "#2563EB" },
  5: { name: "Green Brick", hex: "#16A34A" },
  7: { name: "Yellow Brick", hex: "#EAB308" },
  9: { name: "Red Brick", hex: "#DC2626" },
  10: { name: "White", hex: "#E2E8F0" },
};

const CHEST_LED_HEX: Record<number, string> = {
  [ChestLedState.OFF]: "#334155",
  [ChestLedState.BLUE]: "#38BDF8",
  [ChestLedState.GREEN]: "#4ADE80",
  [ChestLedState.RED]: "#F87171",
};

export const VernieTwin: React.FC<VernieTwinProps> = ({
  connected,
  demoMode,
  telemetry,
  hubRgb,
  chestLedState,
  homingInProgress,
  dartFiredAt,
  onTapFace,
  onLaunchDemo,
  onDemoTogglePickup,
  onDemoBump,
  onDemoBrick,
}) => {
  const [blinking, setBlinking] = useState(false);
  const [dartFlash, setDartFlash] = useState(false);

  // Subtle organic eye blink every ~4.5 seconds when online
  useEffect(() => {
    if (!connected) return;
    let blinkTimeout: ReturnType<typeof setTimeout> | null = null;
    const id = window.setInterval(() => {
      setBlinking(true);
      blinkTimeout = setTimeout(() => setBlinking(false), 150);
    }, 4600);
    return () => {
      window.clearInterval(id);
      if (blinkTimeout) clearTimeout(blinkTimeout);
    };
  }, [connected]);

  // Brief launch animation when dart fires
  useEffect(() => {
    if (!dartFiredAt) return;
    setDartFlash(true);
    const t = setTimeout(() => setDartFlash(false), 700);
    return () => clearTimeout(t);
  }, [dartFiredAt]);

  const flags = telemetry?.flags ?? 0;
  const pickedUp = Boolean(flags & TelemetryFlag.PICKED_UP);
  const bump = Boolean(flags & TelemetryFlag.BUMP);
  const tap = Boolean(flags & TelemetryFlag.TAP);
  const dartArmed = Boolean(flags & TelemetryFlag.DART_ARMED);
  const headHomed = Boolean(flags & TelemetryFlag.HEAD_HOMED);
  const sensorOk = Boolean(flags & TelemetryFlag.SENSOR_OK);
  const safeMode = Boolean(flags & TelemetryFlag.SAFE_MODE);
  const synthActive = Boolean(flags & TelemetryFlag.SYNTH_ACTIVE);

  const headDeg = telemetry?.headDeg ?? 0;
  const speedA = telemetry?.speedA ?? 0;
  const speedB = telemetry?.speedB ?? 0;
  const pitchDeg = telemetry?.pitchDeg ?? 0;
  const rollDeg = telemetry?.rollDeg ?? 0;
  const distPct = telemetry && telemetry.distancePct <= 100 ? telemetry.distancePct : null;
  const detectedBrick = telemetry ? LEGO_BRICK_MAP[telemetry.colorId] : undefined;

  const hubHex = `rgb(${hubRgb[0]}, ${hubRgb[1]}, ${hubRgb[2]})`;
  const eyeAccent = safeMode
    ? "#EF4444"
    : pickedUp
      ? "#F97316"
      : connected
        ? "#38BDF8"
        : "#475569";

  // Map headDeg (-40..+35) to expressive horizontal head shift & eyebrow slant
  const headShiftX = Math.max(-18, Math.min(18, headDeg * 0.48));
  const headRot = Math.max(-9, Math.min(9, headDeg * 0.22));
  const pupilShiftX = Math.max(-7, Math.min(7, headDeg * 0.18 + (speedA - speedB) * 0.04));

  // Eyebrow tilts: curious (negative headDeg), stern (positive), wide/surprised when pickedUp
  const leftBrowRot = pickedUp ? -14 : dartArmed ? 14 : Math.max(-18, Math.min(18, headDeg * 0.42));
  const rightBrowRot = pickedUp ? 14 : dartArmed ? -14 : Math.max(-18, Math.min(18, -headDeg * 0.25 + (headDeg > 10 ? -10 : 0)));
  const browLiftY = pickedUp ? -6 : synthActive ? -3 : 0;

  // Whole-chassis tilt from IMU roll/pitch
  const bodyTiltDeg = Math.max(-12, Math.min(12, rollDeg * 0.45));
  const bodyLiftY = pickedUp ? -14 : Math.max(-5, Math.min(5, -pitchDeg * 0.2));

  // Tread animation duration inversely scaled to wheel speed
  const treadDurL = Math.abs(speedA) > 4 ? `${Math.max(0.18, 2.2 - Math.abs(speedA) * 0.019)}s` : "0s";
  const treadDurR = Math.abs(speedB) > 4 ? `${Math.max(0.18, 2.2 - Math.abs(speedB) * 0.019)}s` : "0s";
  const treadDirL = speedA >= 0 ? "normal" : "reverse";
  const treadDirR = speedB >= 0 ? "normal" : "reverse";

  const chestHex =
    chestLedState !== ChestLedState.OFF
      ? CHEST_LED_HEX[chestLedState] ?? "#38BDF8"
      : sensorOk && distPct !== null && distPct <= 35
        ? "#F59E0B"
        : "#0EA5E9";

  const modeLabel = telemetry
    ? MODE_NAMES[telemetry.modeId] ?? `Mode ${telemetry.modeId}`
    : "Standby";

  return (
    <div className="twin-frame" aria-label="Live interactive Vernie robot preview">
      <div className="twin-visor-stage">
        {/* Top HUD inside the dark studio stage */}
        <div className="twin-hud-top">
          <div className="twin-hud-group">
            <span
              className="twin-mode-dot"
              style={{ background: connected ? hubHex : "#475569" }}
            />
            <span className="twin-hud-label">{modeLabel}</span>
          </div>
          <div className="twin-hud-chips">
            {homingInProgress && <span className="visor-chip visor-chip-amber">CALIBRATING HEAD…</span>}
            {!homingInProgress && connected && (
              <span className={`visor-chip ${headHomed ? "visor-chip-green" : ""}`}>
                {headHomed ? `HEAD ${headDeg}°` : "HEAD UNCALIBRATED"}
              </span>
            )}
            {pickedUp && <span className="visor-chip visor-chip-orange">PICKED UP</span>}
            {bump && <span className="visor-chip visor-chip-orange">BUMP</span>}
            {tap && <span className="visor-chip visor-chip-cyan">TAP</span>}
            {dartArmed && <span className="visor-chip visor-chip-red">DART ARMED</span>}
            {synthActive && <span className="visor-chip visor-chip-cyan">SINGING</span>}
          </div>
        </div>

        {/* Center stage: left tread meter + SVG Vernie + right tread meter */}
        <div className="twin-stage-body">
          <div className="torque-meter" aria-label={`Left track speed ${speedA}%`}>
            <span className="torque-label">L</span>
            <div className="torque-rail">
              <div className="torque-midline" />
              <div
                className={`torque-bar ${speedA < 0 ? "torque-rev" : ""}`}
                style={{
                  height: `${Math.min(50, Math.abs(speedA) / 2)}%`,
                  bottom: speedA >= 0 ? "50%" : undefined,
                  top: speedA < 0 ? "50%" : undefined,
                }}
              />
            </div>
            <span className="torque-val mono-num">{speedA}</span>
          </div>

          <button
            type="button"
            className="twin-svg-btn"
            onClick={onTapFace}
            title={connected ? "Tap Vernie for a friendly chirp" : "Connect or try Demo Mode"}
            aria-label="Interact with Vernie avatar"
          >
            <svg
              className={`vernie-svg ${connected ? "is-awake" : "is-asleep"}`}
              viewBox="0 0 320 276"
              role="img"
              aria-label="Vernie robot digital twin"
            >
              <defs>
                <linearGradient id="vWhite" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFFFFF" />
                  <stop offset="100%" stopColor="#E4E7EE" />
                </linearGradient>
                <linearGradient id="vVisor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#1E2532" />
                  <stop offset="100%" stopColor="#0D1118" />
                </linearGradient>
                <linearGradient id="vCyan" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38BDF8" />
                  <stop offset="100%" stopColor="#0284C7" />
                </linearGradient>
                <linearGradient id="vOrange" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#FF8533" />
                  <stop offset="100%" stopColor="#EA580C" />
                </linearGradient>
                <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={hubHex} stopOpacity="0.85" />
                  <stop offset="100%" stopColor={hubHex} stopOpacity="0" />
                </radialGradient>
              </defs>

              {/* Soft studio floor shadow */}
              <ellipse
                cx="160"
                cy="252"
                rx={pickedUp ? 72 : 98}
                ry={pickedUp ? 9 : 14}
                fill="#05070B"
                opacity={pickedUp ? 0.35 : 0.65}
                style={{ transition: "all 260ms ease" }}
              />

              {/* Bump ripple ring */}
              {bump && (
                <circle
                  cx="160"
                  cy="145"
                  r="105"
                  fill="none"
                  stroke="#F97316"
                  strokeWidth="2.5"
                  strokeDasharray="6 6"
                  opacity="0.7"
                />
              )}

              {/* Whole chassis group responds to IMU tilt & pickup */}
              <g
                style={{
                  transform: `translateY(${bodyLiftY}px) rotate(${bodyTiltDeg}deg)`,
                  transformOrigin: "160px 190px",
                  transition: "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              >
                {/* LEFT TANK TREAD */}
                <g>
                  <rect x="44" y="156" width="38" height="90" rx="15" fill="#1C222D" stroke="#364152" strokeWidth="2.5" />
                  <rect x="51" y="164" width="24" height="74" rx="10" fill="#10141B" />
                  <g
                    className={Math.abs(speedA) > 4 ? "tread-moving" : ""}
                    style={{
                      animationDuration: treadDurL,
                      animationDirection: treadDirL,
                    }}
                  >
                    {[168, 182, 196, 210, 224].map((y) => (
                      <rect key={y} x="48" y={y} width="30" height="5" rx="2.5" fill="#475569" />
                    ))}
                  </g>
                  <circle cx="63" cy="176" r="8" fill="#0EA5E9" opacity="0.28" />
                  <circle cx="63" cy="226" r="8" fill="#0EA5E9" opacity="0.28" />
                </g>

                {/* RIGHT TANK TREAD */}
                <g>
                  <rect x="238" y="156" width="38" height="90" rx="15" fill="#1C222D" stroke="#364152" strokeWidth="2.5" />
                  <rect x="245" y="164" width="24" height="74" rx="10" fill="#10141B" />
                  <g
                    className={Math.abs(speedB) > 4 ? "tread-moving" : ""}
                    style={{
                      animationDuration: treadDurR,
                      animationDirection: treadDirR,
                    }}
                  >
                    {[168, 182, 196, 210, 224].map((y) => (
                      <rect key={y} x="242" y={y} width="30" height="5" rx="2.5" fill="#475569" />
                    ))}
                  </g>
                  <circle cx="257" cy="176" r="8" fill="#0EA5E9" opacity="0.28" />
                  <circle cx="257" cy="226" r="8" fill="#0EA5E9" opacity="0.28" />
                </g>

                {/* SHOULDER DART LAUNCHER POD (Right shoulder) */}
                <g>
                  <rect x="220" y="96" width="42" height="30" rx="8" fill="#2A3240" stroke="#475569" strokeWidth="2" />
                  <rect x="254" y="102" width="12" height="18" rx="4" fill={dartArmed ? "#EF4444" : "#64748B"} />
                  {/* Hinged safety guard */}
                  <rect
                    x="224"
                    y={dartArmed ? "84" : "98"}
                    width="30"
                    height="8"
                    rx="3"
                    fill={dartArmed ? "#EF4444" : "#F97316"}
                    style={{
                      transform: dartArmed ? "rotate(-28deg)" : "rotate(0deg)",
                      transformOrigin: "226px 98px",
                      transition: "all 220ms ease",
                    }}
                  />
                  {/* Fired dart streak */}
                  {dartFlash && (
                    <g>
                      <line x1="268" y1="111" x2="314" y2="111" stroke="#F97316" strokeWidth="5" strokeLinecap="round" />
                      <circle cx="312" cy="111" r="5" fill="#FDE047" />
                    </g>
                  )}
                </g>

                {/* LEFT ARM ACCENT */}
                <rect x="58" y="114" width="28" height="36" rx="10" fill="url(#vCyan)" />
                <rect x="64" y="122" width="16" height="10" rx="4" fill="#E0F2FE" opacity="0.55" />

                {/* MOVE HUB TORSO CHASSIS */}
                <rect x="84" y="116" width="152" height="118" rx="22" fill="url(#vWhite)" stroke="#CBD5E1" strokeWidth="2.5" />
                {/* Blue shoulder collar */}
                <path d="M96 116 H224 L214 134 H106 Z" fill="url(#vCyan)" />
                {/* Vernie's iconic orange bow-tie accent */}
                <polygon points="148,132 160,138 148,144" fill="url(#vOrange)" />
                <polygon points="172,132 160,138 172,144" fill="url(#vOrange)" />
                <circle cx="160" cy="138" r="4.5" fill="#EA580C" />

                {/* 88007 CHEST COLOR & DISTANCE SENSOR */}
                <g>
                  <rect x="114" y="150" width="92" height="36" rx="10" fill="#18202C" stroke="#334155" strokeWidth="2" />
                  {/* Dual optical sensor lenses */}
                  <circle cx="140" cy="168" r="10" fill="#0B0F17" stroke={chestHex} strokeWidth="2.5" />
                  <circle cx="140" cy="168" r="4" fill={chestHex} opacity={connected ? 0.9 : 0.25} />
                  <circle cx="180" cy="168" r="10" fill="#0B0F17" stroke="#475569" strokeWidth="2" />
                  <circle cx="180" cy="168" r="4" fill={detectedBrick && detectedBrick.hex !== "transparent" ? detectedBrick.hex : "#334155"} />
                  {/* Live distance sonar arc when close */}
                  {connected && sensorOk && distPct !== null && distPct < 75 && (
                    <path
                      d="M 146 192 Q 160 200 174 192"
                      fill="none"
                      stroke={distPct <= 35 ? "#F59E0B" : "#38BDF8"}
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      opacity="0.85"
                    />
                  )}
                </g>

                {/* MOVE HUB RGB GLOW + GREEN POWER BUTTON */}
                <g>
                  {connected && <circle cx="160" cy="210" r="22" fill="url(#hubGlow)" />}
                  <rect x="142" y="201" width="36" height="18" rx="9" fill="#16A34A" stroke="#15803D" strokeWidth="1.5" />
                  <rect x="147" y="204" width="26" height="5" rx="2.5" fill="#86EFAC" opacity="0.6" />
                </g>

                {/* NECK STEM */}
                <rect x="146" y="100" width="28" height="20" rx="6" fill="#475569" />

                {/* ARTICULATED HEAD GROUP */}
                <g
                  style={{
                    transform: `translateX(${headShiftX}px) rotate(${headRot}deg)`,
                    transformOrigin: "160px 104px",
                    transition: "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)",
                  }}
                >
                  {/* Top LEGO stud accents */}
                  <rect x="116" y="18" width="28" height="12" rx="4" fill="#CBD5E1" />
                  <rect x="176" y="18" width="28" height="12" rx="4" fill="#CBD5E1" />

                  {/* Head housing */}
                  <rect x="82" y="26" width="156" height="80" rx="26" fill="url(#vWhite)" stroke="#CBD5E1" strokeWidth="2.5" />
                  {/* Dark recessed eye visor */}
                  <rect x="94" y="38" width="132" height="56" rx="18" fill="url(#vVisor)" />

                  {/* Left Eye */}
                  <g>
                    <circle cx="132" cy="68" r="19" fill="#0B0F17" stroke={eyeAccent} strokeWidth="3.2" />
                    {blinking ? (
                      <line x1="120" y1="68" x2="144" y2="68" stroke={eyeAccent} strokeWidth="3.2" strokeLinecap="round" />
                    ) : (
                      <>
                        <circle cx={132 + pupilShiftX} cy="68" r="9.5" fill={eyeAccent} />
                        <circle cx={129 + pupilShiftX} cy="64" r="3" fill="#FFFFFF" opacity="0.88" />
                      </>
                    )}
                  </g>

                  {/* Right Eye */}
                  <g>
                    <circle cx="188" cy="68" r="19" fill="#0B0F17" stroke={eyeAccent} strokeWidth="3.2" />
                    {blinking ? (
                      <line x1="176" y1="68" x2="200" y2="68" stroke={eyeAccent} strokeWidth="3.2" strokeLinecap="round" />
                    ) : (
                      <>
                        <circle cx={188 + pupilShiftX} cy="68" r="9.5" fill={eyeAccent} />
                        <circle cx={185 + pupilShiftX} cy="64" r="3" fill="#FFFFFF" opacity="0.88" />
                      </>
                    )}
                  </g>

                  {/* Synth audio waves around head when singing */}
                  {synthActive && (
                    <g stroke="#38BDF8" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.9">
                      <path d="M68 54 Q60 66 68 78" />
                      <path d="M58 46 Q46 66 58 86" opacity="0.55" />
                      <path d="M252 54 Q260 66 252 78" />
                      <path d="M262 46 Q274 66 262 86" opacity="0.55" />
                    </g>
                  )}

                  {/* ICONIC EXPRESSIVE ORANGE EYEBROWS */}
                  <g
                    style={{
                      transform: `translateY(${browLiftY}px) rotate(${leftBrowRot}deg)`,
                      transformOrigin: "132px 46px",
                      transition: "transform 160ms ease",
                    }}
                  >
                    <rect x="106" y="40" width="46" height="10" rx="5" fill="url(#vOrange)" />
                  </g>
                  <g
                    style={{
                      transform: `translateY(${browLiftY}px) rotate(${rightBrowRot}deg)`,
                      transformOrigin: "188px 46px",
                      transition: "transform 160ms ease",
                    }}
                  >
                    <rect x="168" y="40" width="46" height="10" rx="5" fill="url(#vOrange)" />
                  </g>
                </g>
              </g>
            </svg>
          </button>

          <div className="torque-meter" aria-label={`Right track speed ${speedB}%`}>
            <span className="torque-label">R</span>
            <div className="torque-rail">
              <div className="torque-midline" />
              <div
                className={`torque-bar ${speedB < 0 ? "torque-rev" : ""}`}
                style={{
                  height: `${Math.min(50, Math.abs(speedB) / 2)}%`,
                  bottom: speedB >= 0 ? "50%" : undefined,
                  top: speedB < 0 ? "50%" : undefined,
                }}
              />
            </div>
            <span className="torque-val mono-num">{speedB}</span>
          </div>
        </div>

        {/* Bottom telemetry strip inside the visor */}
        <div className="twin-hud-bottom">
          <div className="twin-stat">
            <span className="twin-stat-k">CHEST RANGE</span>
            <span className="twin-stat-v mono-num">
              {distPct !== null ? `${distPct}%` : chestLedState !== ChestLedState.OFF ? "LED ON" : "N/A"}
            </span>
          </div>
          <div className="twin-stat">
            <span className="twin-stat-k">BRICK COLOR</span>
            <span className="twin-stat-v">
              {detectedBrick && detectedBrick.hex !== "transparent" && (
                <span className="brick-swatch" style={{ background: detectedBrick.hex }} />
              )}
              {sensorOk ? detectedBrick?.name ?? "None" : "Paused"}
            </span>
          </div>
          <div className="twin-stat">
            <span className="twin-stat-k">POSTURE</span>
            <span className="twin-stat-v mono-num">
              {connected ? (pickedUp ? "Lifted" : `${pitchDeg}° / ${rollDeg}°`) : "Offline"}
            </span>
          </div>
        </div>
      </div>

      {/* Offline first-visit invitation */}
      {!connected && !demoMode && onLaunchDemo && (
        <div className="standby-invite-bar">
          <span>Pair your Move Hub via Bluetooth, or explore everything with our live virtual robot.</span>
          <button type="button" className="chip-btn chip-btn-amber" onClick={onLaunchDemo}>
            Try Demo Robot
          </button>
        </div>
      )}

      {/* Interactive Demo Sandbox triggers — only shown when testing in Demo Mode */}
      {demoMode && (
        <div className="demo-sandbox-bar" aria-label="Demo sensor triggers">
          <span className="demo-sandbox-label">Simulate Robot Sensors</span>
          <div className="demo-sandbox-btns">
            <button
              type="button"
              className={`chip-btn chip-compact ${pickedUp ? "chip-btn-warn" : ""}`}
              onClick={onDemoTogglePickup}
            >
              {pickedUp ? "Set Down" : "Pick Up"}
            </button>
            <button type="button" className="chip-btn chip-compact" onClick={onDemoBump}>
              Bump
            </button>
            {[
              { id: 5, label: "Green", hex: "#16A34A" },
              { id: 9, label: "Red", hex: "#DC2626" },
              { id: 3, label: "Blue", hex: "#2563EB" },
              { id: 7, label: "Yellow", hex: "#EAB308" },
            ].map((b) => (
              <button
                key={b.id}
                type="button"
                className="chip-btn chip-compact"
                onClick={() => onDemoBrick?.(b.id)}
                title={`Hold ${b.label} LEGO brick in front of chest sensor`}
              >
                <span className="chip-dot" style={{ background: b.hex }} />
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
