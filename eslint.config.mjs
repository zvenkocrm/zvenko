// @ts-check
// Линтинг (ADR-0008): проверки с учётом типов из typescript-eslint.
// Правила для границ модулей монолита (eslint-plugin-boundaries) добавятся вместе с модулями.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/dist/**", "**/coverage/**", "**/.turbo/**", "**/node_modules/**"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Забытый await — частый источник потерь данных и гонок.
      "@typescript-eslint/no-floating-promises": "error",
      // Новый вариант в union обязан обрабатываться во всех switch.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Модули NestJS — классы с одним декоратором @Module, это норма фреймворка.
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
    },
  },
  {
    // drizzle-orm — только через @zvenko/db: две копии библиотеки дают несовместимые типы схемы.
    files: ["apps/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "drizzle-orm", message: "Импортируйте операторы запросов из @zvenko/db." },
          ],
        },
      ],
    },
  },
  {
    // Конфиги и скрипты на JS: без проверок по типам.
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
