// SPDX-License-Identifier: MIT
// Meta Quest 1 / 2 / 3 WebXR Hand Controller & Curved VR Cockpit Geometry Tests.

import { describe, expect, it, vi } from "vitest";
import {
  mixQuestToTank,
  QuestControllerReader,
  readXrThumbstick,
  XrInputSourceLike,
} from "./xr/questControllers";
import {
  buildCockpitModelMatrix,
  buildCurvedScreenGeometry,
  extractViewerYawRad,
} from "./xr/questVrCockpit";

function makeHand(
  handedness: "left" | "right",
  opts: {
    stickX?: number;
    stickY?: number;
    trigger?: number;
    grip?: number;
    stickClick?: boolean;
    primary?: boolean; // Left X, Right A
    secondary?: boolean; // Left Y, Right B
    hapticPulse?: ReturnType<typeof vi.fn>;
  } = {}
): XrInputSourceLike {
  const buttons = [
    { pressed: (opts.trigger ?? 0) > 0.5, value: opts.trigger ?? 0 }, // 0: Index Trigger
    { pressed: (opts.grip ?? 0) > 0.5, value: opts.grip ?? 0 }, // 1: Grip
    { pressed: false, value: 0 }, // 2: Touchpad placeholder
    { pressed: Boolean(opts.stickClick), value: opts.stickClick ? 1 : 0 }, // 3: Stick click
    { pressed: Boolean(opts.primary), value: opts.primary ? 1 : 0 }, // 4: X (left) / A (right)
    { pressed: Boolean(opts.secondary), value: opts.secondary ? 1 : 0 }, // 5: Y (left) / B (right)
  ];
  return {
    handedness,
    gamepad: {
      // W3C xr-standard: axes[0..1] touchpad, axes[2..3] thumbstick X/Y (-1 = up/forward)
      axes: [0, 0, opts.stickX ?? 0, opts.stickY ?? 0],
      buttons,
      hapticActuators: opts.hapticPulse ? [{ pulse: opts.hapticPulse }] : undefined,
    },
  };
}

describe("Meta Quest WebXR Oculus Touch Hand Controllers", () => {
  it("reads W3C xr-standard axes[2..3] thumbstick with deadzone and inverted Y", () => {
    const idle = readXrThumbstick({ axes: [0, 0, 0.08, -0.09], buttons: [] });
    expect(idle).toEqual({ x: 0, y: 0 });

    const fwdRight = readXrThumbstick({ axes: [0, 0, 1, -1], buttons: [] });
    expect(fwdRight).toEqual({ x: 1, y: 1 });
  });

  it("supports Arcade/Trigger drive, Twin-Stick Tank toggle, edge actions, and haptics", () => {
    const reader = new QuestControllerReader();
    const pulseLeft = vi.fn();
    const pulseRight = vi.fn();

    // 1. Arcade Trigger Car mode: Right trigger full gas + Left stick right steer + Right stick turret
    const s1 = reader.poll(
      [
        makeHand("left", { stickX: 1, primary: true, hapticPulse: pulseLeft }), // X = headlights
        makeHand("right", { trigger: 1, stickX: -0.8, primary: true, hapticPulse: pulseRight }), // A = horn
      ],
      80
    );
    expect(s1.leftConnected).toBe(true);
    expect(s1.rightConnected).toBe(true);
    expect(s1.driveStyle).toBe("arcade");
    expect(s1.usingTriggers).toBe(true);
    expect(s1.leftMotor).toBe(80);
    expect(s1.rightMotor).toBe(0);
    expect(s1.turretX).toBeLessThan(-0.3);
    expect(s1.actions).toContain("headlights");
    expect(s1.actions).toContain("horn");

    // Holding same buttons on next frame emits zero duplicate edge actions
    const held = reader.poll(
      [
        makeHand("left", { stickX: 1, primary: true }),
        makeHand("right", { trigger: 1, primary: true }),
      ],
      80
    );
    expect(held.actions).toEqual([]);

    // 2. Left thumbstick click switches cleanly into Twin-Stick Tank mode!
    const toggle = reader.poll(
      [
        makeHand("left", { stickClick: true, stickY: -1 }), // Left tread full forward (+1)
        makeHand("right", { stickY: 1, secondary: true }), // Right tread full reverse (-1) + Right B STOP
      ],
      70
    );
    expect(toggle.driveStyle).toBe("twin-stick");
    expect(toggle.actions).toContain("toggle-drive-style");
    expect(toggle.actions).toContain("stop");
    expect(toggle.leftMotor).toBe(70);
    expect(toggle.rightMotor).toBe(-70);

    // 3. Haptic pulse routes accurately to left/right/both actuators
    const hands = [
      makeHand("left", { hapticPulse: pulseLeft }),
      makeHand("right", { hapticPulse: pulseRight }),
    ];
    reader.pulseHaptics(hands, "both", 0.6, 80);
    expect(pulseLeft).toHaveBeenCalledWith(0.6, 80);
    expect(pulseRight).toHaveBeenCalledWith(0.6, 80);
  });

  it("mixQuestToTank maps twin-stick treads independently within speedCap", () => {
    const res = mixQuestToTank({
      driveStyle: "twin-stick",
      leftStickX: 0,
      leftStickY: 0.5,
      rightStickX: 0,
      rightStickY: -0.5,
      leftTrigger: 0,
      rightTrigger: 0,
      speedCap: 60,
    });
    expect(res.leftMotor).toBe(30);
    expect(res.rightMotor).toBe(-30);
    expect(res.steer).toBeCloseTo(0.5, 4);
    expect(res.throttle).toBeCloseTo(0, 4);
  });
});

describe("Meta Quest Curved WebXR Cockpit Geometry & Head-Yaw Anchoring", () => {
  it("builds a smooth curved cylindrical windshield mesh centered along -Z", () => {
    const mesh = buildCurvedScreenGeometry({
      radius: 2.2,
      arcRad: Math.PI / 2,
      height: 1.8,
      centerY: 0.1,
      segments: 16,
    });
    expect(mesh.vertices.length).toBe((16 + 1) * 2 * 5);
    expect(mesh.indices.length).toBe(16 * 6);

    // Center column (i = 8) sits directly ahead at x ≈ 0, z ≈ -2.2
    const midTopIdx = 8 * 2 * 5;
    expect(mesh.vertices[midTopIdx]).toBeCloseTo(0, 4);
    expect(mesh.vertices[midTopIdx + 1]).toBeCloseTo(1.0, 4); // 0.1 + 0.9
    expect(mesh.vertices[midTopIdx + 2]).toBeCloseTo(-2.2, 4);
    expect(mesh.vertices[midTopIdx + 3]).toBeCloseTo(0.5, 4); // u
    expect(mesh.vertices[midTopIdx + 4]).toBe(0); // v = 0 (top of texture)
  });

  it("extracts viewer yaw accurately and anchors cockpit directly ahead of head heading", () => {
    // Viewer facing +X (turned 90 deg right): local +Z points along -X -> col2 = (-1, 0, 0)
    const turnedRightMat = new Float32Array([
      0, 0, 1, 0,
      0, 1, 0, 0,
      -1, 0, 0, 0,
      0, 1.5, 0, 1,
    ]);
    const yaw = extractViewerYawRad(turnedRightMat);
    expect(yaw).toBeCloseTo(Math.PI / 2, 4);

    // Transform cockpit center (0, 0, -2.2) with model matrix -> must land at (+2.2, 1.5, 0)
    const m = buildCockpitModelMatrix(0, 1.5, 0, yaw);
    const z = -2.2;
    const wx = m[8] * z + m[12];
    const wy = m[9] * z + m[13];
    const wz = m[10] * z + m[14];
    expect(wx).toBeCloseTo(2.2, 4);
    expect(wy).toBeCloseTo(1.5, 4);
    expect(wz).toBeCloseTo(0, 4);
  });
});
