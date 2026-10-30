// scripts/polyfill-canvas.mjs —— 只用文本提取时，给 pdfjs 补最小的几何/画布替身
// 目的：不装 @napi-rs/canvas（38MB 原生二进制），也能在 Node 里跑 pdfjs 文本提取
class DOMMatrixStub {
  constructor(init) {
    const m = Array.isArray(init) ? init : (init && init.m) || [1, 0, 0, 1, 0, 0];
    [this.a, this.b, this.c, this.d, this.e, this.f] = m;
    this.m = m;
  }
  multiplySelf(o) { const [a, b, c, d, e, f] = (o && o.m) || [1, 0, 0, 1, 0, 0];
    const [A, B, C, D, E, F] = this.m;
    this.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
    [this.a, this.b, this.c, this.d, this.e, this.f] = this.m; return this; }
  translateSelf(x = 0, y = 0) { return this.multiplySelf([1, 0, 0, 1, x, y]); }
  scaleSelf(x = 1, y = 1) { return this.multiplySelf([x, 0, 0, y, 0, 0]); }
  rotateSelf() { return this; }
  invertSelf() {
    const [A, B, C, D, E, F] = this.m;
    const det = A * D - B * C || 1e-9;
    this.m = [D / det, -B / det, -C / det, A / det, (C * F - D * E) / det, (B * E - A * F) / det];
    [this.a, this.b, this.c, this.d, this.e, this.f] = this.m; return this;
  }
  get isIdentity() { return this.m.join() === '1,0,0,1,0,0'; }
}
class Path2DStub { constructor() {} addPath() {} }
class ImageDataStub { constructor(w, h) { this.width = w; this.height = h; } }
const noop = () => {};

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrixStub;
if (!globalThis.DOMMatrixReadOnly) globalThis.DOMMatrixReadOnly = DOMMatrixStub;
if (!globalThis.Path2D) globalThis.Path2D = Path2DStub;
if (!globalThis.ImageData) globalThis.ImageData = ImageDataStub;
if (!globalThis.document) {
  globalThis.document = {
    createElement: () => ({ getContext: () => ({
      fillRect: noop, drawImage: noop, getImageData: (x, y, w, h) => new ImageDataStub(w, h),
      putImageData: noop, save: noop, restore: noop, transform: noop, scale: noop, translate: noop,
    }), style: {}, setAttribute: noop, appendChild: noop }),
  };
}
