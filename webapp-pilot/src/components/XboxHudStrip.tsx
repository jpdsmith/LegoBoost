// SPDX-License-Identifier: MIT
// Visual Xbox Controller HUD Strip showing live connection, sticks/triggers, and button hints.

import React from "react";
import { XboxDriveSample } from "../input/xboxController";
import { IconGamepad } from "./Icons";

export interface XboxHudStripProps {
  sample: XboxDriveSample;
  compact?: boolean;
}

export const XboxHudStrip: React.FC<XboxHudStripProps> = ({ sample, compact = false }) => {
  return (
    <div
      className={`xbox-hud ${sample.connected ? "is-connected" : ""} ${compact ? "is-compact" : ""}`}
      aria-label="Xbox controller status"
    >
      <div className="xbox-hud-left">
        <span className={`xbox-status-dot ${sample.connected ? "is-live" : ""}`} />
        <IconGamepad size={16} />
        <span className="xbox-title">
          {sample.connected
            ? `${sample.name} · ${sample.usingTriggers ? "Trigger Car Drive" : "Left-Stick Drive"}`
            : "Xbox Controller — press any button to activate"}
        </span>
      </div>

      <div className="xbox-legend" aria-label="Xbox button mapping">
        <span className="xbox-key"><kbd className="xbtn-neutral">LS / RT·LT</kbd> Drive</span>
        <span className="xbox-key"><kbd className="xbtn-b">B</kbd> Stop</span>
        <span className="xbox-key"><kbd className="xbtn-a">A</kbd> Horn</span>
        <span className="xbox-key"><kbd className="xbtn-x">X</kbd> Lights</span>
        <span className="xbox-key"><kbd className="xbtn-y">Y</kbd> AI Mode</span>
        <span className="xbox-key"><kbd className="xbtn-neutral">LB·RB</kbd> Speed</span>
      </div>
    </div>
  );
};
