// Shared helpers for the route charts drawn on canvas.

/** Sizes a canvas for the device's pixel ratio and returns a context in CSS pixels. */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const ratio = globalThis.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

/** Reads a design token at draw time, so a theme change is picked up on redraw. */
export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function chartFont(size = 11) {
  return `${size}px ${cssVar('--font-body')}`;
}

/** Shortens text with an ellipsis until it fits. */
export function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** Index of the last sorted position at or before `value`, or -1. */
export function lastAtOrBefore(positions: number[], value: number) {
  let low = 0;
  let high = positions.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (positions[middle] <= value) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
