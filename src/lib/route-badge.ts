const RGB_HEX = /^[0-9a-f]{6}$/i;
const MIN_TEXT_CONTRAST = 4.5;

function linearChannel(hex: string) {
  const channel = Number.parseInt(hex, 16) / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  return 0.2126 * linearChannel(hex.slice(0, 2))
    + 0.7152 * linearChannel(hex.slice(2, 4))
    + 0.0722 * linearChannel(hex.slice(4, 6));
}

/** GTFS colors are six-digit sRGB hex values without a leading hash. */
export function hasRouteBadgeContrast(color: string, textColor: string) {
  if (!RGB_HEX.test(color) || !RGB_HEX.test(textColor)) return false;
  const background = luminance(color);
  const text = luminance(textColor);
  return (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05) >= MIN_TEXT_CONTRAST;
}
