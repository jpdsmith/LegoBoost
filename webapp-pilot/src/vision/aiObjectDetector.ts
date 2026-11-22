// SPDX-License-Identifier: MIT
// Optional On-Device AI Object Detector (MediaPipe Tasks Vision EfficientDet-Lite0).
// Lazy-loaded on demand when the user enables AI Vision so the PWA stays tiny & fast offline;
// degrades gracefully to built-in zero-dependency vision when offline or WebGL is unavailable.

import { DetectedObjectBox } from "../rtc/roverBridge";

interface MediaPipeDetection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories?: Array<{ categoryName?: string; score?: number }>;
}

interface MediaPipeDetectorLike {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { detections: MediaPipeDetection[] };
  close(): void;
}

const MEDIAPIPE_BUNDLE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const MEDIAPIPE_WASM_DIR =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const EFFICIENTDET_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

export class OnDeviceObjectDetector {
  private detector: MediaPipeDetectorLike | null = null;
  private loadingPromise: Promise<boolean> | null = null;
  private errorMsg: string | null = null;
  private activeDelegate: "GPU" | "CPU" | null = null;

  isReady(): boolean {
    return this.detector !== null;
  }

  getDelegate(): "GPU" | "CPU" | null {
    return this.activeDelegate;
  }

  getError(): string | null {
    return this.errorMsg;
  }

  async load(): Promise<boolean> {
    if (this.detector) return true;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        this.errorMsg = null;
        // Dynamic URL import kept opaque to Vite bundler so offline/CI builds need zero external fetches
        const dynamicImport = new Function("u", "return import(u)") as (
          u: string
        ) => Promise<{
          FilesetResolver: { forVisionTasks: (wasmDir: string) => Promise<unknown> };
          ObjectDetector: {
            createFromOptions: (
              fileset: unknown,
              opts: Record<string, unknown>
            ) => Promise<MediaPipeDetectorLike>;
          };
        }>;

        const mod = await dynamicImport(MEDIAPIPE_BUNDLE_URL);
        const fileset = await mod.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_DIR);

        // Try GPU first (fast on Pixel Fold Tensor G2), automatically falling back to CPU WASM if GPU WebGL fails
        try {
          this.detector = await mod.ObjectDetector.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: EFFICIENTDET_MODEL_URL,
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            scoreThreshold: 0.42,
            maxResults: 6,
          });
          this.activeDelegate = "GPU";
          return true;
        } catch {
          this.detector = await mod.ObjectDetector.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: EFFICIENTDET_MODEL_URL,
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            scoreThreshold: 0.42,
            maxResults: 6,
          });
          this.activeDelegate = "CPU";
          return true;
        }
      } catch (err) {
        this.activeDelegate = null;
        this.errorMsg =
          err instanceof Error
            ? `AI Vision offline/unavailable (${err.message.slice(0, 60)}) — using built-in floor & color vision.`
            : "AI Vision unavailable — using built-in floor & color vision.";
        return false;
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  detectVideo(video: HTMLVideoElement, nowMs = performance.now()): DetectedObjectBox[] {
    if (!this.detector || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return [];
    }
    try {
      const result = this.detector.detectForVideo(video, nowMs);
      const w = video.videoWidth;
      const h = video.videoHeight;
      const boxes: DetectedObjectBox[] = [];
      result.detections.forEach((det, idx) => {
        const bb = det.boundingBox;
        const cat = det.categories?.[0];
        if (!bb || !cat?.categoryName) return;
        boxes.push({
          id: `ai-${cat.categoryName}-${idx}`,
          label: cat.categoryName,
          score: cat.score ?? 0.5,
          x: Math.max(0, Math.min(1, bb.originX / w)),
          y: Math.max(0, Math.min(1, bb.originY / h)),
          w: Math.max(0.02, Math.min(1, bb.width / w)),
          h: Math.max(0.02, Math.min(1, bb.height / h)),
          source: "ai",
        });
      });
      return boxes;
    } catch {
      return [];
    }
  }

  dispose(): void {
    try {
      this.detector?.close();
    } catch {
      // ignore
    }
    this.detector = null;
  }
}
