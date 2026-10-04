import type { Hex } from "./tokens.js";

const HEX = /^#[0-9a-f]{6}$/i;

/** Относительная яркость цвета sRGB по WCAG 2.2: от 0 (чёрный) до 1 (белый). */
export const relativeLuminance = (hex: Hex): number => {
  if (!HEX.test(hex)) {
    throw new TypeError(`Ожидается цвет вида #RRGGBB, получено: ${hex}`);
  }
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number): number => {
    const srgb = ((value >> shift) & 0xff) / 0xff;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
};

/** Контраст двух цветов по WCAG 2.2: от 1 (одинаковые) до 21 (чёрный на белом). */
export const contrastRatio = (a: Hex, b: Hex): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
