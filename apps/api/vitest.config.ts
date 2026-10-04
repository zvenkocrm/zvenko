import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Интеграционные тесты поднимают настоящий PostgreSQL в контейнере (Testcontainers).
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
