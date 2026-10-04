import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "../src/index.js";

describe("формула контраста WCAG 2.2", () => {
  it("чёрный на белом — 21 : 1, одинаковые цвета — 1 : 1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 10);
    expect(contrastRatio("#2F5BEA", "#2F5BEA")).toBe(1);
  });

  it("не зависит от порядка цветов", () => {
    expect(contrastRatio("#11161F", "#F6F7F9")).toBe(contrastRatio("#F6F7F9", "#11161F"));
  });

  it("совпадает с эталоном: #767676 на белом — 4,54 : 1 (WebAIM)", () => {
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });

  it("яркость — от 0 до 1, регистр букв не важен", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(relativeLuminance("#2f5bea")).toBe(relativeLuminance("#2F5BEA"));
  });

  it.each(["#FFF", "#GGGGGG", "2F5BEA", "#2F5BEA80"] as const)("отклоняет %s", (value) => {
    expect(() => relativeLuminance(value as `#${string}`)).toThrow(TypeError);
  });
});
