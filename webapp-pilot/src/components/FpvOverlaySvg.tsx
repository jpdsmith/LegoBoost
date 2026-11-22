// SPDX-License-Identifier: MIT
// Interactive FPV HUD SVG Overlay:
//   - 5-sector translucent Free-Floor Clearance Fan (aligned to real horizonYs when available)
//   - Asymmetric Swept-Bumper Chassis Rails (compensating for left-offset Pixel Fold rear camera!)
//   - Optional Floor Sample Patch box (verifies LEGO bumper isn't polluting floor calibration)
//   - Dynamic Predictive Steering Trajectory Arcs
//   - Front Bumper 88007 Proximity Radar Arc
//   - Clickable AI / HSV Object Bounding Boxes for 1-tap Tap-to-Follow

import React from "react";
import { DetectedObjectBox, RoverVisionSnapshot } from "../rtc/roverBridge";
import { computeSweptBumperBounds, MountCalibration } from "../vision/roverVision";

export interface FpvOverlaySvgProps {
  steer: number;
  frontDistPct: number | null;
  vision: RoverVisionSnapshot | null;
  showCorridors: boolean;
  /** Optional mount calibration to draw true asymmetric left/right swept robot bumper rails */
  calibration?: MountCalibration;
  /** Show subtle floor-sampling patch rectangle for visual mount verification */
  showFloorPatch?: boolean;
  onSelectObject?: (box: DetectedObjectBox) => void;
}

function corridorFill(clearance: number): string {
  if (clearance < 0.25) return "rgba(239, 68, 68, 0.34)";
  if (clearance < 0.5) return "rgba(245, 158, 11, 0.26)";
  return "rgba(34, 197, 94, 0.22)";
}

function corridorStroke(clearance: number): string {
  if (clearance < 0.25) return "rgba(248, 113, 113, 0.84)";
  if (clearance < 0.5) return "rgba(251, 191, 36, 0.8)";
  return "rgba(74, 222, 128, 0.74)";
}

export const FpvOverlaySvg: React.FC<FpvOverlaySvgProps> = ({
  steer,
  frontDistPct,
  vision,
  showCorridors,
  calibration,
  showFloorPatch = false,
  onSelectObject,
}) => {
  const W = 640;
  const H = 360;
  const curveOffset = Math.round(steer * 145);
  const trajectoryColor =
    frontDistPct !== null && frontDistPct <= 30
      ? "#EF4444"
      : frontDistPct !== null && frontDistPct <= 55
        ? "#F59E0B"
        : "#38BDF8";

  const corridors = vision?.corridors ?? null;
  const horizonYs = vision?.horizonYs ?? null;
  const objects = vision?.objects ?? [];
  const lockedId = vision?.lockedTarget?.id ?? null;

  const bottomY = calibration ? Math.round(calibration.bumperMaskY * H) : 330;
  const topHorizonY = calibration ? Math.round(calibration.horizonY * H) : 158;

  // Asymmetric left/right chassis path rails when mount calibration is active
  let chassisRails: {
    leftPts: string;
    rightPts: string;
    centerNearX: number;
    centerFarX: number;
    color: string;
  } | null = null;
  if (calibration) {
    const nearB = computeSweptBumperBounds(calibration, 0);
    const midB = computeSweptBumperBounds(calibration, 0.45);
    const farB = computeSweptBumperBounds(calibration, 1);
    const yMid = Math.round(bottomY - (bottomY - topHorizonY) * 0.45);
    const sweptClr = vision?.sweptClear ?? 1;
    chassisRails = {
      leftPts: `${Math.round(nearB.uLeft * W)},${bottomY} ${Math.round(midB.uLeft * W)},${yMid} ${Math.round(farB.uLeft * W)},${topHorizonY}`,
      rightPts: `${Math.round(nearB.uRight * W)},${bottomY} ${Math.round(midB.uRight * W)},${yMid} ${Math.round(farB.uRight * W)},${topHorizonY}`,
      centerNearX: Math.round(nearB.uCenter * W),
      centerFarX: Math.round(farB.uCenter * W),
      color: sweptClr < 0.25 ? "#F87171" : sweptClr < 0.5 ? "#FBBF24" : "#38BDF8",
    };
  }

  const floorPatch = showFloorPatch ? vision?.floorPatch : undefined;

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
              const topY =
                horizonYs && typeof horizonYs[idx] === "number"
                  ? Math.round(Math.max(40, Math.min(bottomY - 4, horizonYs[idx] * H)))
                  : Math.round(326 - clr * 150);
              return (
                <g key={idx}>
                  <polygon
                    points={`${x0 + 4},${bottomY} ${x0 + 10},${topY} ${x1 - 10},${topY} ${x1 - 4},${bottomY}`}
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

        {/* Asymmetric Swept-Bumper Chassis Rails (visualizes left-offset camera right-tread clearance!) */}
        {chassisRails && (
          <g opacity="0.92">
            <polyline
              points={chassisRails.leftPts}
              fill="none"
              stroke={chassisRails.color}
              strokeWidth="2.8"
              strokeDasharray="8 5"
              strokeLinecap="round"
            />
            <polyline
              points={chassisRails.rightPts}
              fill="none"
              stroke={chassisRails.color}
              strokeWidth="2.8"
              strokeDasharray="8 5"
              strokeLinecap="round"
            />
            <line
              x1={chassisRails.centerNearX}
              y1={bottomY}
              x2={chassisRails.centerFarX}
              y2={topHorizonY}
              stroke="rgba(255,255,255,0.45)"
              strokeWidth="1.2"
              strokeDasharray="4 6"
            />
          </g>
        )}

        {/* Bumper mask cutoff line when raised above default */}
        {calibration && calibration.bumperMaskY < 0.94 && (
          <line
            x1="0"
            y1={bottomY}
            x2={W}
            y2={bottomY}
            stroke="rgba(251, 191, 36, 0.5)"
            strokeWidth="1.2"
            strokeDasharray="6 6"
          />
        )}

        {/* Floor Sample Patch Debug Box */}
        {floorPatch && (
          <rect
            x={Math.round(floorPatch.x * W)}
            y={Math.round(floorPatch.y * H)}
            width={Math.round(floorPatch.w * W)}
            height={Math.round(floorPatch.h * H)}
            fill="rgba(250, 204, 21, 0.08)"
            stroke="rgba(250, 204, 21, 0.85)"
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
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
          const isLocked =
            box.id === lockedId ||
            (vision?.lockedTarget?.label === box.label && box.source === vision?.lockedTarget?.source);
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
