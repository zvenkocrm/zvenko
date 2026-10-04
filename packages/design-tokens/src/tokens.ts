/**
 * Дизайн-система v1: строгий и быстрый интерфейс — плотно, спокойно, один акцент.
 * Единственный источник значений: tokens.css генерируется отсюда (`pnpm tokens:css`).
 */

export type Hex = `#${string}`;

/**
 * Цвета названы по назначению, а не по оттенку: тёмная тема (дизайн v2) сменит значения, не имена.
 * Каждый цвет проверяется на контраст — см. pairs.ts.
 */
export const color = {
  // Нейтральные
  bg: "#F6F7F9", // подложка приложения
  surface: "#FFFFFF", // карточки, панели, поля ввода
  subtle: "#EEF0F3", // переключатели, нейтральные этапы
  muted: "#F1F3F6", // входящие сообщения, значки каналов
  border: "#E3E6EB", // разделители
  borderStrong: "#C9CED6", // вторичные кнопки, клавиши
  borderControl: "#868D9A", // граница поля ввода — без неё поле не найти (WCAG 1.4.11)
  indicator: "#9AA1AD", // точки этапов; смысл всегда продублирован текстом
  text: "#11161F",
  textSecondary: "#4A5263",
  textTertiary: "#646C7B",

  // Акцент — только главное действие и выбранное состояние
  accent: "#2F5BEA",
  accentHover: "#1E3FAF",
  accentSoft: "#EFF2FD",
  onAccent: "#FFFFFF",

  // Смысловые — всегда вместе со словом или значком, а не только цветом
  success: "#127A55",
  successSoft: "#E6F4EE",
  warning: "#A64D09",
  warningSoft: "#FDF1E7",
  warningSurface: "#FFFBF7",
  warningBorder: "#F0C9A6",
  danger: "#C2332B",
  dangerSoft: "#FBEAEA",
  onDanger: "#FFFFFF",

  // Внутренний комментарий — клиент его не видит
  note: "#6B5214",
  noteSoft: "#FFF8E6",
  noteBorder: "#E5C46B",
} as const satisfies Record<string, Hex>;

export type ColorToken = keyof typeof color;

/**
 * Шрифты подключаются с нашего сервера, без Google Fonts:
 * браузер пользователя не должен ходить к зарубежным сервисам.
 */
export const font = {
  sans: '"Onest", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** Размер шрифта и межстрочный интервал, px. Основной текст — 14/20: плотно, но читается. */
export const text = {
  caption: { size: 11, lineHeight: 14 },
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 13, lineHeight: 18 },
  base: { size: 14, lineHeight: 20 },
  md: { size: 16, lineHeight: 24 },
  lg: { size: 18, lineHeight: 26 },
  xl: { size: 20, lineHeight: 28 },
  "2xl": { size: 24, lineHeight: 32 },
  "3xl": { size: 32, lineHeight: 40 },
} as const;

/** Отступы, px — шаг 4, как в шкале Tailwind: space[3] = p-3 = 12 px. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  12: 48,
} as const;

/** Скругления, px. */
export const radius = {
  xs: 4, // клавиши
  sm: 6, // кнопки, поля
  md: 8, // карточки в воронке
  lg: 10, // панели
  full: 9999, // пилюли этапов и каналов
} as const;

/** Размеры элементов, px. */
export const size = {
  control: 32, // кнопки и поля на компьютере
  row: 36, // строка списка на компьютере
  touchTarget: 44, // минимальная цель касания на телефоне
  rowTouch: 48, // строка списка на телефоне
} as const;

/** Кольцо фокуса цвета accent: видно на любом фоне интерфейса (WCAG 2.4.7). */
export const focus = {
  width: 2,
  offset: 2,
} as const;
