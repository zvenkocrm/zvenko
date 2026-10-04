import { describe, expect, it } from "vitest";
import {
  color,
  contrastPairs,
  contrastRatio,
  decorativeColors,
  minimumContrast,
  type ColorToken,
} from "../src/index.js";

const tokens = Object.keys(color) as ColorToken[];

describe("контраст цветов (WCAG 2.2 AA, UX-03)", () => {
  it.each(contrastPairs)(
    "$foreground на $background ($level)",
    ({ foreground, background, level }) => {
      const ratio = contrastRatio(color[foreground], color[background]);
      expect(ratio).toBeGreaterThanOrEqual(minimumContrast[level]);
    },
  );
});

describe("полнота проверки", () => {
  it("каждый цвет проверен на контраст или явно помечен как декоративный", () => {
    const covered = new Set<ColorToken>(decorativeColors);
    for (const pair of contrastPairs) {
      covered.add(pair.foreground);
      covered.add(pair.background);
    }
    expect(tokens.filter((token) => !covered.has(token))).toEqual([]);
  });

  it("декоративные цвета не используются как цвет текста", () => {
    const textColors = contrastPairs
      .filter((pair) => pair.level === "text")
      .map((pair) => pair.foreground);
    expect(textColors.filter((token) => decorativeColors.includes(token))).toEqual([]);
  });

  it("все цвета записаны как #RRGGBB заглавными буквами", () => {
    expect(Object.values(color).filter((value) => !/^#[0-9A-F]{6}$/.test(value))).toEqual([]);
  });
});
