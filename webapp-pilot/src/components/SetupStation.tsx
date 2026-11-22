// SPDX-License-Identifier: MIT
// Station 5 — Setup, Guided Wireless Updater & Hardware Diagnostics.
// Uses shared @core/ble/lwp3Flasher with zero-sum & SHA-256 verification.

import React, { useEffect, useState } from "react";
import {
  flashMoveHubViaWebBluetooth,
  FlashProgress,
  verifyMoveHubZeroSum,
} from "@core/ble/lwp3Flasher";
import { MODE_NAMES, TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";
import { ConnectionState } from "@core/ble/vernieClient";
import { IconDownload, IconRefresh, IconShield } from "./Icons";

interface FirmwareManifest {
  version: string;
  bin_size: number;
  base_size: number;
  checksum_word: string;
  bin_sha256: string;
  built_at?: string;
}

export interface SetupStationProps {
  bleSupported: boolean;
  connectionState: ConnectionState;
  telemetry: TelemetryFrame | null;
  rxHz: number;
  onRebootToBootloader: () => Promise<void>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const FIRMWARE_BASE_CANDIDATES = ["./firmware", "../firmware"];

const FLASH_STAGES: Array<{ id: FlashProgress["stage"]; label: string }> = [
  { id: "connecting", label: "Connect" },
  { id: "info", label: "Verify Hub" },
  { id: "erasing", label: "Erase" },
  { id: "programming", label: "Install" },
  { id: "rebooting", label: "Restart" },
];

export const SetupStation: React.FC<SetupStationProps> = ({
  bleSupported,
  connectionState,
  telemetry,
  rxHz,
  onRebootToBootloader,
}) => {
  const [manifest, setManifest] = useState<FirmwareManifest | null>(null);
  const [firmwareBase, setFirmwareBase] = useState<string>("./firmware");
  const [bundledBytes, setBundledBytes] = useState<Uint8Array | null>(null);
  const [customFile, setCustomFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [progress, setProgress] = useState<FlashProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebootSent, setRebootSent] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Pre-fetch verified firmware manifest & binary from ./firmware or ../firmware
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      for (const base of FIRMWARE_BASE_CANDIDATES) {
        try {
          const mResp = await fetch(`${base}/manifest.json`, { signal: controller.signal });
          if (!mResp.ok) continue;
          const mData = (await mResp.json()) as FirmwareManifest;
          setManifest(mData);
          setFirmwareBase(base);

          const bResp = await fetch(`${base}/firmware.bin`, { signal: controller.signal });
          if (!bResp.ok) return;
          const bytes = new Uint8Array(await bResp.arrayBuffer());
          if (!verifyMoveHubZeroSum(bytes)) {
            setError("Bundled firmware.bin failed Move Hub zero-sum checksum verification.");
            return;
          }
          const actualSha = await sha256Hex(bytes);
          if (controller.signal.aborted) return;
          if (actualSha && mData.bin_sha256 && actualSha !== mData.bin_sha256) {
            setError("Bundled firmware.bin SHA-256 does not match manifest.json!");
            return;
          }
          setBundledBytes(bytes);
          return;
        } catch {
          // Try next base path or silently skip in local dev without staged binary
        }
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (connectionState === "connected") setRebootSent(false);
  }, [connectionState]);

  const handleFilePick = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const input = ev.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!verifyMoveHubZeroSum(bytes)) {
      setError(
        `"${file.name}" failed Move Hub 108,544-byte zero-sum verification (or exceeded 104 KiB). Select a valid checksummed firmware.bin.`
      );
      setCustomFile(null);
      return;
    }
    setCustomFile({ name: file.name, bytes });
  };

  const handleReboot = async () => {
    setError(null);
    try {
      await onRebootToBootloader();
      setRebootSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFlash = async () => {
    setError(null);
    setFlashing(true);
    setProgress(null);
    try {
      let fwBytes = customFile ? customFile.bytes : bundledBytes;
      if (!fwBytes) {
        const resp = await fetch(`${firmwareBase}/firmware.bin`);
        if (!resp.ok) {
          throw new Error(
            "Bundled firmware.bin was not found on this server. Load a local firmware.bin file instead."
          );
        }
        fwBytes = new Uint8Array(await resp.arrayBuffer());
        if (!verifyMoveHubZeroSum(fwBytes)) {
          throw new Error("Fetched firmware.bin failed Move Hub zero-sum verification.");
        }
        const actualSha = await sha256Hex(fwBytes);
        if (actualSha && manifest?.bin_sha256 && actualSha !== manifest.bin_sha256) {
          throw new Error("Fetched firmware.bin SHA-256 does not match manifest.json.");
        }
      }
      await flashMoveHubViaWebBluetooth(fwBytes, (p) => setProgress(p));
      setRebootSent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFlashing(false);
    }
  };

  const stageIndex = progress
    ? progress.stage === "done"
      ? FLASH_STAGES.length
      : FLASH_STAGES.findIndex((s) => s.id === progress.stage)
    : -1;

  const flags = telemetry?.flags ?? 0;

  return (
    <div className="station-stack">
      {/* GUIDED WIRELESS INSTALLER */}
      <section className="console-panel" aria-label="Wireless firmware installer">
        <div className="panel-head">
          <div>
            <h2>Wireless Firmware Setup &amp; Updates</h2>
            <p className="panel-sub">
              Install or update Vernie OS right over Bluetooth — no USB cables or developer tools
              needed
            </p>
          </div>
          {manifest && (
            <span className="status-tag is-live">Latest: {manifest.version}</span>
          )}
        </div>

        {/* Visual Move Hub Update Mode Guide */}
        <div className="wizard-steps">
          <div className="wizard-card">
            <div className="wizard-step-badge">1</div>
            <div className="wizard-body">
              <div className="wizard-title-row">
                <h3>Put Your Hub in Update Mode</h3>
                <span className="rgb-blink-badge" title="Hub light cycles Red, Green, Blue">
                  <span className="rgb-blink-dot" />
                  <span>Red · Green · Blue blink</span>
                </span>
              </div>
              <p>
                <strong>First time:</strong> With fresh 6× AAA batteries and the hub turned off,
                press and hold the green button for <strong>5–10 seconds</strong> until the light
                flashes red, green, and blue.
              </p>
              {connectionState === "connected" && (
                <button
                  type="button"
                  id="btn-pilot-reboot-bl"
                  className="keycap keycap-amber keycap-sm"
                  onClick={handleReboot}
                  disabled={flashing}
                >
                  <IconRefresh size={14} />
                  <span>Reboot Connected Hub to Update Mode</span>
                </button>
              )}
              {rebootSent && (
                <p className="helper-ok">
                  Reboot sent! Wait ~2 seconds for the Red/Green/Blue blinking light, then click Step 2.
                </p>
              )}
            </div>
          </div>

          <div className="wizard-card">
            <div className="wizard-step-badge">2</div>
            <div className="wizard-body">
              <h3>Install Vernie OS (~30 seconds)</h3>
              <p>
                Click Install below, select <strong>LEGO Bootloader</strong> in Chrome&apos;s
                Bluetooth picker, and keep the hub nearby until the bar reaches 100%.
              </p>
              <div className="action-cluster">
                <button
                  type="button"
                  id="btn-pilot-flash"
                  className="keycap keycap-green"
                  onClick={handleFlash}
                  disabled={!bleSupported || flashing}
                >
                  <IconDownload size={15} />
                  <span>
                    {flashing
                      ? "Installing over Bluetooth…"
                      : customFile
                        ? `Install ${customFile.name}`
                        : "Install Vernie OS"}
                  </span>
                </button>

                <label className={`keycap keycap-subtle keycap-sm ${flashing ? "is-disabled" : ""}`}>
                  Choose Custom .bin
                  <input
                    type="file"
                    accept=".bin"
                    onChange={handleFilePick}
                    disabled={flashing}
                    hidden
                  />
                </label>

                {customFile && (
                  <button
                    type="button"
                    className="keycap keycap-subtle keycap-sm"
                    onClick={() => setCustomFile(null)}
                    disabled={flashing}
                  >
                    Use Official Build
                  </button>
                )}

                {manifest && (
                  <a
                    className="keycap keycap-subtle keycap-sm"
                    href={`${firmwareBase}/firmware.zip`}
                    download
                  >
                    Download .zip
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Live Staged Flash Progress */}
        {progress && (
          <div className="flash-progress-card" role="status">
            <div className="flash-stage-pills">
              {FLASH_STAGES.map((st, idx) => (
                <span
                  key={st.id}
                  className={`stage-chip ${
                    idx < stageIndex ? "is-done" : idx === stageIndex ? "is-now" : ""
                  }`}
                >
                  {st.label}
                </span>
              ))}
            </div>
            <div className="panel-head-inline">
              <span>{progress.message}</span>
              <strong className="mono-num">{progress.percent}%</strong>
            </div>
            <div className="progress-well">
              <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}

        {error && <div className="notice notice-danger">{error}</div>}

        {/* Verified Build Details */}
        {manifest && (
          <div className="build-meta-strip">
            <div>
              <span className="engraved-label">Release</span>
              <strong className="mono-num">{manifest.version}</strong>
            </div>
            <div>
              <span className="engraved-label">Flash Footprint</span>
              <strong className="mono-num">
                {(manifest.bin_size / 1024).toFixed(1)} KB / 104 KB
              </strong>
            </div>
            <div>
              <span className="engraved-label">Checksum</span>
              <strong className="mono-num">{manifest.checksum_word}</strong>
            </div>
            <div>
              <span className="engraved-label">SHA-256</span>
              <strong className="mono-num" title={manifest.bin_sha256}>
                {manifest.bin_sha256.slice(0, 12)}…
              </strong>
            </div>
          </div>
        )}
      </section>

      {/* OFFICIAL LEGO RESTORE + CLASSIC COCKPIT LINK */}
      <div className="two-col-grid">
        <section className="console-panel" aria-label="Restore official LEGO firmware">
          <div className="panel-head">
            <div>
              <h2>Switch Back to Official LEGO® App Anytime</h2>
              <p className="panel-sub">
                The Move Hub&apos;s factory updater is permanent and can never be erased
              </p>
            </div>
            <IconShield size={20} />
          </div>
          <p className="body-copy">
            Hold the green button 5–10 seconds from off until the light blinks Red/Green/Blue, then
            open Pybricks Code and choose <strong>Settings → Restore Official LEGO Firmware</strong>.
          </p>
          <div className="action-cluster">
            <a
              className="keycap keycap-subtle keycap-sm"
              href="https://code.pybricks.com/"
              target="_blank"
              rel="noreferrer"
            >
              Open code.pybricks.com ↗
            </a>
            <a className="keycap keycap-subtle keycap-sm" href="../">
              Open Classic Engineering Cockpit ↗
            </a>
          </div>
        </section>

        {/* EXPANDABLE HARDWARE TELEMETRY & DIAGNOSTICS */}
        <section className="console-panel" aria-label="Hardware diagnostics">
          <div className="panel-head">
            <div>
              <h2>Live Hardware Inspector</h2>
              <p className="panel-sub">
                Raw sensor &amp; encoder stream ({rxHz.toFixed(1)} Hz BLE)
              </p>
            </div>
            <button
              type="button"
              className="keycap keycap-subtle keycap-sm"
              onClick={() => setShowDiagnostics((v) => !v)}
            >
              {showDiagnostics ? "Hide Raw Data" : "Inspect Sensors"}
            </button>
          </div>

          {showDiagnostics ? (
            <div className="diag-grid mono-num">
              <div className="diag-cell">
                <span>Battery</span>
                <strong>{telemetry ? `${telemetry.batteryMv} mV` : "--"}</strong>
              </div>
              <div className="diag-cell">
                <span>Mode</span>
                <strong>
                  {telemetry ? MODE_NAMES[telemetry.modeId] ?? `#${telemetry.modeId}` : "Offline"}
                </strong>
              </div>
              <div className="diag-cell">
                <span>Encoders A / B</span>
                <strong>{telemetry ? `${telemetry.encA}° / ${telemetry.encB}°` : "--"}</strong>
              </div>
              <div className="diag-cell">
                <span>Head / IMU</span>
                <strong>
                  {telemetry
                    ? `${telemetry.headDeg}° (${telemetry.pitchDeg}°/${telemetry.rollDeg}°)`
                    : "--"}
                </strong>
              </div>
              <div className="diag-cell">
                <span>88007 Dist / Color</span>
                <strong>
                  {telemetry
                    ? `${telemetry.distancePct <= 100 ? `${telemetry.distancePct}%` : "N/A"} / #${telemetry.colorId}`
                    : "--"}
                </strong>
              </div>
              <div className="diag-cell">
                <span>Telemetry Seq</span>
                <strong>{telemetry ? `#${telemetry.seq}` : "--"}</strong>
              </div>
              <div className="diag-flags-row">
                {[
                  { bit: TelemetryFlag.SENSOR_OK, label: "SENSOR_OK" },
                  { bit: TelemetryFlag.HEAD_HOMED, label: "HEAD_HOMED" },
                  { bit: TelemetryFlag.DART_ARMED, label: "DART_ARMED" },
                  { bit: TelemetryFlag.PICKED_UP, label: "PICKED_UP" },
                  { bit: TelemetryFlag.BUMP, label: "BUMP" },
                  { bit: TelemetryFlag.TAP, label: "TAP" },
                  { bit: TelemetryFlag.SYNTH_ACTIVE, label: "SYNTH" },
                  { bit: TelemetryFlag.SAFE_MODE, label: "SAFE_MODE" },
                ].map((f) => (
                  <span
                    key={f.label}
                    className={`flag-pill ${flags & f.bit ? "is-on" : ""}`}
                  >
                    {f.label}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="body-copy">
              Need exact millivolts, motor encoder angles, packet rate, or firmware status flags?
              Tap <strong>Inspect Sensors</strong> anytime.
            </p>
          )}
        </section>
      </div>
    </div>
  );
};
