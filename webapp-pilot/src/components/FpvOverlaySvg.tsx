// SPDX-License-Identifier: MIT
// Interactive FPV HUD SVG Overlay:
//   - 5-sector translucent Free-Floor Clearance Fan (shows what the Rover's brain sees)
//   - Dynamic Predictive Steering Trajectory Arcs
//   - Front Bumper 88007 Proximity Radar Arc
//   - Clickable AI / HSV Object Bounding Boxes for 1-tap Tap-to-Follow

import React from "react";
import { DetectedObjectBox, RoverVisionSnapshot } from "../rtc/roverBridge";

export interface FpvOverlaySvgProps {
  steer: number;
  frontDistPct: number | null;
  vision: RoverVisionSnapshot | null;
  showCorridors: boolean;
  onSelectObject?: (box: DetectedObjectBox) => void;
}

function corridorFill(clearance: number): string {
  if (clearance < 0.25) return "rgba(239, 68, 68, 0.34)";
  if (clearance < 0.5) return "rgba(245, 158, 11, 0.26)";
  return "rgba(34, 197, 94, 0.22)";
}

function corridorStroke(clearance: number): string {
  if (clearance < 0.25) return "rgba(248, 113, 113, 0.8)";
  if (clearance < 0.5) return "rgba(251, 191, 36, 0.78)";
  return "rgba(74, 222, 128, 0.72)";
}

export const FpvOverlaySvg: React.FC<FpvOverlaySvgProps> = ({
  steer,
  frontDistPct,
  vision,
  showCorridors,
  onSelectObject,
}) => {
  const curveOffset = Math.round(steer * 145);
  const trajectoryColor =
    frontDistPct !== null && frontDistPct <= 30
      ? "#EF4444"
      : frontDistPct !== null && frontDistPct <= 55
        ? "#F59E0B"
        : "#38BDF8";

  const corridors = vision?.corridors ?? null;
  const objects = vision?.objects ?? [];
  const lockedId = vision?.lockedTarget?.id ?? null;

  return (
    <>
      <svg
        className="fpv-hud-svg"
        viewBox="0 0 640 360"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* 5-Sector Free-Floor Clearance Overlay Fan */}
        {showCorridors && corridors && (
          <g>
            {corridors.map((clr, idx) => {
              const x0 = idx * 128;
              const x1 = x0 + 128;
              const topY = Math.round(326 - clr * 150);
              return (
                <g key={idx}>
                  <polygon
                    points={`${x0 + 4},330 ${x0 + 10},${topY} ${x1 - 10},${topY} ${x1 - 4},330`}
                    fill={corridorFill(clr)}
                    stroke={corridorStroke(clr)}
                    strokeWidth="1.5"
                  />
                  <line
                    x1={x0 + 12}
                    y1={topY}
                    x2={x1 - 12}
                    y2={topY}
                    stroke={corridorStroke(clr)}
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* Lane Assist Center Guide when detected */}
        {vision?.laneOffset !== null && vision?.laneOffset !== undefined && (
          <line
            x1={320 + vision.laneOffset * 200}
            y1="230"
            x2={320 + vision.laneOffset * 260}
            y2="352"
            stroke="#FACC15"
            strokeWidth="4"
            strokeDasharray="10 6"
            opacity="0.85"
          />
        )}

        {/* Predictive dynamic steering rails */}
        <path
          d={`M 165 358 Q ${220 + curveOffset * 0.55} 265 ${260 + curveOffset} 205`}
          fill="none"
          stroke={trajectoryColor}
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.86"
        />
        <path
          d={`M 475 358 Q ${420 + curveOffset * 0.55} 265 ${380 + curveOffset} 205`}
          fill="none"
          stroke={trajectoryColor}
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.86"
        />
        <line
          x1={230 + curveOffset * 0.52}
          y1="265"
          x2={410 + curveOffset * 0.52}
          y2="265"
          stroke={trajectoryColor}
          strokeWidth="1.8"
          strokeDasharray="6 6"
          opacity="0.55"
        />

        {/* Center reticle */}
        <circle cx="320" cy="180" r="13" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.5" />
        <line x1="301" y1="180" x2="310" y2="180" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />
        <line x1="330" y1="180" x2="339" y2="180" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />

        {/* Front bumper proximity radar arc */}
        {frontDistPct !== null && frontDistPct < 85 && (
          <path
            d="M 245 332 Q 320 310 395 332"
            fill="none"
            stroke={frontDistPct <= 30 ? "#EF4444" : frontDistPct <= 55 ? "#F59E0B" : "#4ADE80"}
            strokeWidth="6"
            strokeLinecap="round"
            opacity="0.92"
          />
        )}
      </svg>

      {/* Interactive HTML Object Bounding Boxes (clickable to Tap-to-Follow!) */}
      <div className="fpv-boxes-layer">
        {objects.map((box) => {
          const isLocked = box.id === lockedId || (vision?.lockedTarget?.label === box.label && box.source === vision?.lockedTarget?.source);
          return (
            <button
              key={box.id}
              type="button"
              className={`fpv-detect-box ${isLocked ? "is-locked" : ""}`}
              style={{
                left: `${(box.x * 100).toFixed(1)}%`,
                top: `${(box.y * 100).toFixed(1)}%`,
                width: `${(box.w * 100).toFixed(1)}%`,
                height: `${(box.h * 100).toFixed(1)}%`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectObject?.(box);
              }}
              title={isLocked ? `Following ${box.label} (click to unlock)` : `Click to follow ${box.label}`}
            >
              <span className={`fpv-box-tag ${box.y < 0.09 ? "is-inside" : ""}`}>
                {isLocked ? "LOCKED · " : ""}
                {box.label} {Math.round(box.score * 100)}%
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
};
