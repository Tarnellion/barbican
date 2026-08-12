#!/usr/bin/env node

/**
 * Точка входа CLI.
 *
 * Ограничения безопасности здесь не реализуются, а настраиваются: обязательный
 * allowlist хостов, запрет небезопасных методов, троттлинг и отказ от редиректов
 * живут в HTTP-клиенте и действуют независимо от того, что передал CLI.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { styleText } from "node:util";
import { Command, InvalidArgumentError } from "commander";
import { createHttpClient } from "./adapters/http.js";
import { createOpenApiParser } from "./adapters/openapi.js";
import { createThrottle } from "./adapters/throttle.js";
import { buildAccessMatrix, diffAccess } from "./core/index.js";
import { parseRunConfig, resolveTokens, toAccounts } from "./io/config.js";
import { buildReport, exitCodeFor } from "./report/build.js";
import { collectObservations } from "./runner.js";

// Версия читается из package.json, а не дублируется константой: разошедшись,
// дубликат заставил бы CLI врать о собственной версии в отчётах о прогонах.
const requireFromHere = createRequire(import.meta.url);
const { version } = requireFromHere("../package.json") as { readonly version: string };

function paint(text: string, format: Parameters<typeof styleText>[0]): string {
  // Без TTY управляющие последовательности только мусорят в перенаправленном выводе.
  return process.stderr.isTTY === true ? styleText(format, text) : text;
}

const SKIP_LABELS: Readonly<Record<string, string>> = {
  "path-parameters": "с параметрами в пути",
  "unsafe-method": "небезопасным методом",
  excluded: "исключено вручную",
};

/** Расшифровка пропусков: одно число без причин читается как «что-то не проверено». */
function skipBreakdown(report: {
  readonly skipped: readonly { readonly reason: string }[];
}): string {
  const counts = new Map<string, number>();
  for (const item of report.skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  const parts = [...counts].map(([reason, count]) => `${SKIP_LABELS[reason] ?? reason} ${count}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function positiveInteger(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError("ожидается целое положительное число");
  }
  return value;
}

interface RunFlags {
  readonly config: string;
  readonly spec: string;
  readonly report?: string;
  readonly unsafeMethods?: boolean;
  readonly concurrency?: number;
  readonly rps?: number;
  readonly maxRequests?: number;
}

async function run(flags: RunFlags): Promise<number> {
  const config = parseRunConfig(await readFile(flags.config, "utf8"));
  const endpoints = await createOpenApiParser().parse(await readFile(flags.spec, "utf8"));
  const tokens = resolveTokens(config, process.env);

  const throttle = createThrottle({
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.rps === undefined ? {} : { requestsPerSecond: flags.rps }),
    ...(flags.maxRequests === undefined ? {} : { maxRequests: flags.maxRequests }),
  });

  const client = createHttpClient({
    allowedHosts: config.target.allowedHosts,
    throttle,
    allowUnsafeMethods: flags.unsafeMethods === true,
  });

  const startedAt = new Date();
  const accounts = toAccounts(config);
  const { observations, skipped, failures } = await collectObservations({
    baseUrl: config.target.baseUrl,
    endpoints,
    accounts,
    tokens,
    client,
    allowUnsafeMethods: flags.unsafeMethods === true,
    exclude: config.exclude,
  });
  const finishedAt = new Date();

  const matrix = buildAccessMatrix({ endpoints, accounts, observations });
  const findings = diffAccess(matrix, config.policy);

  const report = buildReport({
    version,
    config,
    endpoints,
    observations,
    skipped,
    failures,
    findings,
    startedAt,
    finishedAt,
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (flags.report === undefined) {
    process.stdout.write(json);
  } else {
    await writeFile(flags.report, json, "utf8");
  }

  const { summary } = report;
  const escalations = summary.byKind["privilege-escalation"];
  const lines = [
    `Опрошено: ${summary.observations} пар, эндпоинтов ${summary.endpoints}, аккаунтов ${summary.accounts}`,
    summary.skipped > 0
      ? `Не опрошено эндпоинтов: ${summary.skipped}${skipBreakdown(report)}`
      : undefined,
    summary.failures > 0
      ? paint(`Сорвалось обращений: ${summary.failures} (причины в отчёте)`, "yellow")
      : undefined,
    escalations > 0
      ? paint(`Эскалация привилегий: ${escalations}`, "red")
      : paint("Эскалации привилегий не найдено", "green"),
    `Прочие расхождения: неожиданных отказов ${summary.byKind["unexpected-denial"]}, ` +
      `не наблюдалось ${summary.byKind["not-observed"]}, ошибок обращения ${summary.byKind["probe-error"]}`,
    flags.report === undefined ? undefined : `Отчёт: ${flags.report}`,
  ].filter((line): line is string => line !== undefined);

  process.stderr.write(`${lines.join("\n")}\n`);
  return exitCodeFor(report);
}

const program = new Command();

program
  .name("barbican")
  .description("Проверка RBAC и изоляции тенантов в API мультитенантных платформ")
  .version(version);

program
  .command("run")
  .description("Пройти матрицу «роль × эндпоинт» и сравнить с объявленной политикой")
  .requiredOption("-c, --config <path>", "конфигурация прогона (YAML или JSON)")
  .requiredOption("-s, --spec <path>", "спецификация OpenAPI проверяемого API")
  .option("-r, --report <path>", "куда записать JSON-отчёт (по умолчанию в stdout)")
  .option("--unsafe-methods", "разрешить методы, изменяющие состояние")
  .option("--concurrency <n>", "одновременных обращений", positiveInteger)
  .option("--rps <n>", "обращений в секунду", positiveInteger)
  .option("--max-requests <n>", "потолок обращений на прогон", positiveInteger)
  .action(async (flags: RunFlags) => {
    try {
      process.exitCode = await run(flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${paint("Прогон прерван:", "red")} ${message}\n`);
      process.exitCode = 2;
    }
  });

await program.parseAsync();
