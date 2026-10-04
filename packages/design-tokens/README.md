# @zvenko/design-tokens

Дизайн-система v1 в коде: цвета, шрифты, отступы, скругления, размеры элементов.

- **Источник значений** — [`src/tokens.ts`](src/tokens.ts). Из него генерируется [`tokens.css`](tokens.css) с CSS-переменными `--zv-*`.
- **Контраст** проверяют тесты: каждое сочетание цветов из [`src/pairs.ts`](src/pairs.ts) должно соответствовать WCAG 2.2 AA — 4,5 : 1 для текста, 3 : 1 для границ полей и значков. Новый цвет без проверки контраста тест не пропустит: его нужно добавить в пару или явно пометить декоративным.
- **Шрифты** Onest и JetBrains Mono подключаются с нашего сервера, без Google Fonts.

## Подключение

```css
@import "@zvenko/design-tokens/tokens.css";

body {
  font: var(--zv-text-base) / var(--zv-text-base--line-height) var(--zv-font-sans);
  color: var(--zv-color-text);
  background: var(--zv-color-bg);
}
```

## Изменение токенов

1. Поменять значение в `src/tokens.ts`; для нового сочетания цветов — добавить пару в `src/pairs.ts`.
2. Пересобрать CSS: `pnpm --filter @zvenko/design-tokens tokens:css`.
3. `pnpm --filter @zvenko/design-tokens test` — тесты контраста и актуальности `tokens.css`.
