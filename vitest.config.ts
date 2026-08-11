import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Пороги применяются к ядру. Адаптеры покрываются интеграционно,
      // включать их сюда — значит размыть требование до бессмысленного среднего.
      include: ["src/core/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
