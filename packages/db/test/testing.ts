/**
 * Тестовые помощники для других пакетов: `import … from "@zvenko/db/testing"`.
 * Доступны только с условием `development` (Vitest, проверка типов) — в сборку не попадают.
 */
export { pgErrorCode, startTestDatabase, type TestDatabase } from "./database.js";
export { ids, seed } from "./fixtures.js";
