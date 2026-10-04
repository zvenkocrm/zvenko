import { describe, expect, it } from "vitest";
import { color, renderCss } from "../src/index.js";

describe("tokens.css", () => {
  it("совпадает с src/tokens.ts — после правки токенов запустите `pnpm tokens:css`", async () => {
    await expect(renderCss()).toMatchFileSnapshot("../tokens.css");
  });

  it("содержит переменную для каждого цвета", () => {
    const css = renderCss();
    for (const value of Object.values(color)) expect(css).toContain(`: ${value.toLowerCase()};`);
    expect(css).toContain("--zv-color-text-secondary: #4a5263;");
  });
});
