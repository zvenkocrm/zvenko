import { color, focus, font, fontWeight, radius, size, space, text } from "./tokens.js";

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Размеры — в rem: интерфейс растёт вместе с размером шрифта в настройках браузера. */
const rem = (px: number): string => (px === 0 ? "0" : `${String(px / 16)}rem`);

const HEADER = `/* Сгенерировано из src/tokens.ts — не править вручную.
   Обновить: pnpm --filter @zvenko/design-tokens tokens:css */`;

/** CSS-переменные дизайн-системы. Префикс --zv- не пересекается со стилями чужих сайтов, где стоят виджеты. */
export const renderCss = (): string => {
  const lines: string[] = [];
  const add = (name: string, value: string): void => {
    lines.push(`  --zv-${name}: ${value};`);
  };

  // В CSS — строчные буквы, как оформляет Prettier.
  for (const [name, value] of Object.entries(color)) {
    add(`color-${kebab(name)}`, value.toLowerCase());
  }
  add("font-sans", font.sans);
  add("font-mono", font.mono);
  for (const [name, value] of Object.entries(fontWeight)) add(`font-weight-${name}`, String(value));
  for (const [name, style] of Object.entries(text)) {
    add(`text-${name}`, rem(style.size));
    add(`text-${name}--line-height`, rem(style.lineHeight));
  }
  for (const [name, value] of Object.entries(space)) add(`space-${name}`, rem(value));
  for (const [name, value] of Object.entries(radius)) {
    add(`radius-${name}`, name === "full" ? `${String(value)}px` : rem(value));
  }
  for (const [name, value] of Object.entries(size)) add(`size-${kebab(name)}`, rem(value));
  add("focus-width", `${String(focus.width)}px`);
  add("focus-offset", `${String(focus.offset)}px`);

  return [HEADER, ":root {", "  color-scheme: light;", ...lines, "}", ""].join("\n");
};
