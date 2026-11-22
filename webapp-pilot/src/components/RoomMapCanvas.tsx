// SPDX-License-Identifier: MIT
// Live 2D Room Radar Map Canvas displaying explored floor trail, obstacle hits,
// discovery pins, home origin, and live Tank Rover heading + camera FOV cone.

import React, { useEffect, useRef } from "react";
import { RoomMapSnapshot, RoverDiscoveryItem } from "../rtc/roverBridge";
import { IconMap } from "./Icons";

export interface RoomMapCanvasProps {
  map: RoomMapSnapshot | null;
  discoveries: RoverDiscoveryItem[];
  recoveries: number;
  onResetMap: () => void;
}

export const RoomMapCanvas: React.FC<RoomMapCanvasProps> = ({
  map,
  discoveries,
  recoveries,
  onResetMap,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const size = canvas.width;
    const grid = map?.gridSize ?? 64;
    const cellPx = size / grid;
    const center = size / 2;

    // Dark recessed radar backdrop
    ctx.fillStyle = "#0F141D";
    ctx.fillRect(0, 0, size, size);

    // Subtle concentric meter range rings (1m, 2m, 3m)
    ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
    ctx.lineWidth = 1;
    for (const rCells of [10, 20, 30]) {
      ctx.beginPath();
      ctx.arc(center, center, rCells * cellPx, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Crosshair axes
    ctx.beginPath();
    ctx.moveTo(center, 8);
    ctx.lineTo(center, size - 8);
    ctx.moveTo(8, center);
    ctx.lineTo(size - 8, center);
    ctx.stroke();

    if (map) {
      // Visited open floor cells (soft emerald glow)
      ctx.fillStyle = "rgba(34, 197, 94, 0.34)";
      for (const [gx, gy] of map.visited) {
        ctx.fillRect(gx * cellPx - 1, gy * cellPx - 1, cellPx + 2, cellPx + 2);
      }

      // Detected obstacle wall/furniture cells (amber/orange dots)
      ctx.fillStyle = "#F59E0B";
      for (const [gx, gy] of map.obstacles) {
        ctx.fillRect(gx * cellPx, gy * cellPx, Math.max(2.5, cellPx), Math.max(2.5, cellPx));
      }

      // Discovery pins
      for (const item of discoveries) {
        const dx = (grid / 2 + item.mapX / map.cellCm) * cellPx;
        const dy = (grid / 2 - item.mapY / map.cellCm) * cellPx;
        ctx.fillStyle = "#38BDF8";
        ctx.beginPath();
        ctx.arc(dx, dy, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Home origin marker (H)
      ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
      ctx.beginPath();
      ctx.arc(center, center, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#E2E8F0";
      ctx.font = "bold 8px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("H", center, center + 0.5);

      // Robot pose & 68° forward camera FOV cone
      const rx = map.robotX * cellPx;
      const ry = map.robotY * cellPx;
      const rad = ((map.headingDeg - 90) * Math.PI) / 180;

      ctx.fillStyle = "rgba(56, 189, 248, 0.22)";
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.arc(rx, ry, 28, rad - 0.56, rad + 0.56);
      ctx.closePath();
      ctx.fill();

      // Crisp directional rover triangle
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate((map.headingDeg * Math.PI) / 180);
      ctx.fillStyle = "#F97316";
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5.5, 6);
      ctx.lineTo(0, 3.5);
      ctx.lineTo(-5.5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, [discoveries, map]);

  return (
    <div className="map-card" aria-label="Live 2D exploration room map">
      <div className="panel-head-inline">
        <span className="map-title">
          <IconMap size={15} />
          <strong>Live 2D Room Map</strong>
        </span>
        <button type="button" className="chip-btn chip-compact" onClick={onResetMap}>
          Reset Map
        </button>
      </div>

      <div className="map-canvas-wrap">
        <canvas ref={canvasRef} width={256} height={256} className="room-map-canvas" />
      </div>

      <div className="map-stats-grid mono-num">
        <div>
          <span className="engraved-label">Explored</span>
          <strong>{map ? `${map.coveragePct}%` : "0%"}</strong>
        </div>
        <div>
          <span className="engraved-label">Distance</span>
          <strong>{map ? `${map.distanceMeters} m` : "0.0 m"}</strong>
        </div>
        <div>
          <span className="engraved-label">Finds</span>
          <strong>{discoveries.length}</strong>
        </div>
        <div>
          <span className="engraved-label">Unsticks</span>
          <strong>{recoveries}</strong>
        </div>
      </div>
    </div>
  );
};
