/**
 * Camera QR scanner using jsQR.
 *
 * Opens the rear camera, continuously captures frames into a hidden canvas, and
 * calls `onCode` whenever a new QR code string is detected. Debounces per-code
 * to avoid firing repeatedly for the same physical scan (1.5 s cooldown).
 */

import jsQR from 'jsqr';

const SCAN_COOLDOWN_MS = 1500;

export interface ScannerOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onCode: (code: string) => void;
}

export class Scanner {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onCode: (code: string) => void;
  private rafId: number | null = null;
  private lastSeen: Map<string, number> = new Map();
  private stream: MediaStream | null = null;

  constructor(opts: ScannerOptions) {
    this.video = opts.video;
    this.canvas = opts.canvas;
    const ctx = opts.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2d context unavailable');
    this.ctx = ctx;
    this.onCode = opts.onCode;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.loop();
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  private loop = (): void => {
    if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (w > 0 && h > 0) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.ctx.drawImage(this.video, 0, 0, w, h);
        const imageData = this.ctx.getImageData(0, 0, w, h);
        const code = jsQR(imageData.data, w, h, {
          inversionAttempts: 'dontInvert',
        });
        if (code) {
          this.handleCode(code.data);
        }
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private handleCode(data: string): void {
    const now = Date.now();
    const last = this.lastSeen.get(data);
    if (last !== undefined && now - last < SCAN_COOLDOWN_MS) return;
    this.lastSeen.set(data, now);
    this.onCode(data);
  }
}
