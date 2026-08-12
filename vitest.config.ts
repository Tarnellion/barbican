import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // cli.ts не включён: это разбор аргументов и печать, которые проверяются
      // запуском собранного бинаря, а не юнит-тестами.
      include: [
        "src/core/**/*.ts",
        "src/adapters/**/*.ts",
        "src/io/**/*.ts",
        "src/report/**/*.ts",
        "src/runner.ts",
      ],
      reporter: ["text", "json-summary"],
      // Пороги заданы отдельно по каталогам намеренно: общий порог позволил бы
      // стопроцентному ядру замаскировать просадку в остальных слоях.
      thresholds: {
        "src/core/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // У адаптеров ниже порог по функциям: часть из них — обёртки над системным
        // временем, которые в тестах намеренно подменяются.
        "src/adapters/**/*.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        "src/io/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/report/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/runner.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});
