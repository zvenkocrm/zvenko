import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Тесты поднимают настоящий PostgreSQL в контейнере (Testcontainers).
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
