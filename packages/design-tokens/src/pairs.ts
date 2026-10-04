import type { ColorToken } from "./tokens.js";

/** Минимальный контраст по WCAG 2.2 AA (UX-03). */
export const minimumContrast = {
  /** Обычный текст — критерий 1.4.3. */
  text: 4.5,
  /** Границы полей, значки, кольцо фокуса — критерий 1.4.11. */
  nonText: 3,
} as const;

export type ContrastLevel = keyof typeof minimumContrast;

export interface ContrastPair {
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly level: ContrastLevel;
}

const on = (
  foreground: ColorToken,
  backgrounds: readonly ColorToken[],
  level: ContrastLevel = "text",
): ContrastPair[] => backgrounds.map((background) => ({ foreground, background, level }));

const neutralBackgrounds: readonly ColorToken[] = ["surface", "bg", "subtle", "muted"];

/**
 * Все сочетания цветов, которые встречаются в интерфейсе. Новое сочетание — сначала сюда:
 * тест не пропустит его, если контраст ниже нормы.
 */
export const contrastPairs: readonly ContrastPair[] = [
  ...on("text", neutralBackgrounds),
  ...on("textSecondary", neutralBackgrounds),
  ...on("textTertiary", neutralBackgrounds),
  ...on("accent", ["surface", "bg", "accentSoft"]),
  ...on("onAccent", ["accent", "accentHover"]),
  ...on("success", ["surface", "successSoft"]),
  ...on("warning", ["surface", "warningSoft", "warningSurface"]),
  ...on("danger", ["surface", "dangerSoft"]),
  ...on("onDanger", ["danger"]),
  ...on("note", ["noteSoft"]),
  ...on("borderControl", ["surface", "bg"], "nonText"),
];

/**
 * Декоративные цвета: смысл передают текст или форма элемента, поэтому контраст для них
 * не нормируется (WCAG 1.4.11). Текстом их не пишем.
 */
export const decorativeColors: readonly ColorToken[] = [
  "border",
  "borderStrong",
  "indicator",
  "warningBorder",
  "noteBorder",
];
