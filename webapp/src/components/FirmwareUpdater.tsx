// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from "react";
import {
  flashMoveHubViaWebBluetooth,
  FlashProgress,
  verifyMoveHubZeroSum,
} from "../ble/lwp3Flasher";
import { ConnectionState } from "../ble/vernieClient";

interface FirmwareManifest {
  version: string;
  bin_size: number;
  base_size: number;
  checksum_word: string;
  bin_sha256: string;
  built_at?: string;
}

interface FirmwareUpdaterProps {
  bleSupported: boolean;
  connectionState: ConnectionState;
  onRebootToBootloader: () => Promise<void>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const FirmwareUpdater: React.FC<FirmwareUpdaterProps> = ({
  bleSupported,
  connectionState,
  onRebootToBootloader,
}) => {
  const [manifest, setManifest] = useState<FirmwareManifest | null>(null);
  const [bundledBytes, setBundledBytes] = useState<Uint8Array | null>(null);
  const [customFile, setCustomFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [progress, setProgress] = useState<FlashProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step1Done, setStep1Done] = useState(false);

  // Pre-fetch manifest & bundled firmware.bin on mount so Step 2 invokes
  // navigator.bluetooth.requestDevice() synchronously inside the user gesture.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const mResp = await fetch("./firmware/manifest.json", { signal: controller.signal });
        if (!mResp.ok) return;
        const mData = (await mResp.json()) as FirmwareManifest;
        setManifest(mData);

        const bResp = await fetch("./firmware/firmware.bin", { signal: controller.signal });
        if (!bResp.ok) return;
        const bytes = new Uint8Array(await bResp.arrayBuffer());
        if (!verifyMoveHubZeroSum(bytes)) {
          setError("Bundled firmware.bin failed zero-sum verification.");
          return;
        }
        const actualSha = await sha256Hex(bytes);
        if (controller.signal.aborted) return;
        if (actualSha && mData.bin_sha256 && actualSha !== mData.bin_sha256) {
          setError("Bundled firmware.bin SHA-256 does not match manifest.json!");
          return;
        }
        setBundledBytes(bytes);
      } catch {
        // Optional in local dev before firmware copy, or aborted on unmount.
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (connectionState === "connected") {
      setStep1Done(false);
    }
  }, [connectionState]);

  const handleFileUpload = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const input = ev.target;
    const file = input.files?.[0];
    // Reset input value so re-selecting a fixed file with the same name always fires onChange.
    input.value = "";
    if (!file) {
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!verifyMoveHubZeroSum(bytes)) {
      setError(
        `"${file.name}" failed Move Hub 108,544-byte zero-sum verification (or exceeded 104 KiB FLASH_FIRMWARE). Select a checksummed firmware.bin.`
      );
      setCustomFile(null);
      return;
    }
    setCustomFile({ name: file.name, bytes });
  };

  const handleStep1Reboot = async () => {
    setError(null);
    try {
      await onRebootToBootloader();
      setStep1Done(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStep2Flash = async () => {
    setError(null);
    setFlashing(true);
    setProgress(null);
    try {
      let fwBytes: Uint8Array | null = customFile ? customFile.bytes : bundledBytes;
      if (!fwBytes) {
        const resp = await fetch("./firmware/firmware.bin");
        if (!resp.ok) {
          throw new Error(
            "Bundled firmware.bin not found. Upload a local firmware.bin or deploy via GitHub Actions."
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
      setStep1Done(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFlashing(false);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Chromebook Web Bluetooth Flasher</h2>
          <p className="subtitle">
            Direct LWP3 bootloader (<code>0x1625 / 0x1626</code>) — zero cables, zero Crostini CLI.
          </p>
        </div>
        <span className="badge badge-cyan">Pure MIT · STM32F070RB</span>
      </div>

      {manifest && (
        <div className="manifest-grid">
          <div>
            <span className="label">Bundled Build</span>
            <strong>{manifest.version}</strong>
          </div>
          <div>
            <span className="label">Binary Size</span>
            <strong>{manifest.bin_size.toLocaleString()} B / 106,496 B</strong>
          </div>
          <div>
            <span className="label">LWP3 Checksum</span>
            <code>{manifest.checksum_word}</code>
          </div>
          <div>
            <span className="label">SHA-256</span>
            <code title={manifest.bin_sha256}>{manifest.bin_sha256.slice(0, 12)}…</code>
          </div>
        </div>
      )}

      <div className="steps">
        <div className="step-box">
          <div className="step-num">1</div>
          <div className="step-body">
            <h3>Put Vernie in LEGO Bootloader Mode</h3>
            <p>
              <strong>First time:</strong> With Vernie off and fresh 6× AAA batteries, hold the
              green button <strong>~5 seconds</strong> until the LED blinks{" "}
              <span className="rainbow-text">red / green / blue</span>.
            </p>
            {connectionState === "connected" && (
              <button
                className="btn btn-secondary"
                onClick={handleStep1Reboot}
                disabled={flashing}
              >
                Send Software Reboot to Bootloader (0x05)
              </button>
            )}
            {step1Done && (
              <p className="hint-ok">
                Reboot command sent! Wait for rainbow LED blink, then click Step 2.
              </p>
            )}
          </div>
        </div>

        <div className="step-box">
          <div className="step-num">2</div>
          <div className="step-body">
            <h3>Select <code>LEGO Bootloader</code> &amp; Flash (~35 s)</h3>
            <div className="action-row">
              <button
                className="btn btn-primary"
                onClick={handleStep2Flash}
                disabled={!bleSupported || flashing}
              >
                {flashing
                  ? "Flashing over Bluetooth…"
                  : customFile
                    ? `Flash ${customFile.name}`
                    : "Flash Vernie OS"}
              </button>
              <label className="btn btn-ghost file-btn">
                Load Custom .bin
                <input
                  type="file"
                  accept=".bin"
                  onChange={handleFileUpload}
                  disabled={flashing}
                  hidden
                />
              </label>
              {customFile && (
                <button
                  className="btn btn-ghost"
                  onClick={() => setCustomFile(null)}
                  disabled={flashing}
                >
                  Use Bundled
                </button>
              )}
              {manifest && (
                <a className="btn btn-ghost" href="./firmware/firmware.zip" download>
                  Download firmware.zip
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {progress && (
        <div className="progress-panel">
          <div className="progress-meta">
            <span>{progress.message}</span>
            <strong>{progress.percent}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      <div className="recovery-note">
        <strong>Unbrickable Recovery:</strong> You can restore official LEGO firmware anytime by
        holding the green button 5 s and opening{" "}
        <a href="https://code.pybricks.com/" target="_blank" rel="noreferrer">
          code.pybricks.com
        </a>{" "}
        → Tools → <em>Restore official LEGO firmware</em>.
      </div>
    </section>
  );
};
