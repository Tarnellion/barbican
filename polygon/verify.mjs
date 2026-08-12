#!/usr/bin/env node

/**
 * Сверка инструмента с оракулом референс-платформы.
 *
 * Для каждой комбинации флагов дефектов: поднимает платформу, прогоняет
 * собранный `dist/cli.js run`, сравнивает находки с `ground-truth.json`
 * и печатает расхождения в обе стороны — пропущенное и лишнее.
 *
 * Важнее обнаружения — пустой результат при выключенных флагах. Инструмент,
 * который находит дефекты, но фабрикует находки на корректной платформе,
 * бесполезен одинаково.
 *
 * Ноль зависимостей: только встроенные модули.
 *
 * Использование:
 *   node polygon/verify.mjs            # все комбинации
 *   node polygon/verify.mjs clean all  # только названные
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const POLYGON_DIR = import.meta.dirname;
const REPO_ROOT = resolve(POLYGON_DIR, "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const SERVER = join(POLYGON_DIR, "server.mjs");
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");
const ENDPOINTS = join(POLYGON_DIR, "endpoints.yaml");
const GROUND_TRUTH = join(POLYGON_DIR, "ground-truth.json");

/** Имя переменной окружения → поле в ответе `/v1/health`. */
const FLAG_FIELDS = {
  POLYGON_DEFECT_CROSS_TENANT: "crossTenant",
  POLYGON_DEFECT_NO_ROLE_CHECK: "noRoleCheck",
  POLYGON_DEFECT_IDOR_SAME_TENANT: "idorSameTenant",
  POLYGON_DEFECT_LIST_NO_FILTER: "listNoFilter",
  POLYGON_DEFECT_CROSS_HOLDING: "crossHolding",
  POLYGON_DEFECT_ANCESTOR_LEAK: "ancestorLeak",
  POLYGON_DEFECT_PARENT_LEAK: "parentLeak",
};

/**
 * Локальная петля терпит частоту выше дефолтной.
 *
 * Дефолты инструмента (2 одновременно, 5 в секунду) рассчитаны на чужой стенд.
 * Здесь стенд свой, в том же процессе-родителе, и 80 обращений по 5 в секунду
 * растянули бы каждую из девятнадцати комбинаций на полминуты.
 */
const RUN_FLAGS = ["--rps", "50", "--concurrency", "4"];

function fail(message) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(2);
}

/**
 * Достаёт baseUrl из конфигурации прогона.
 *
 * Регулярным выражением, а не YAML-разбором: у скрипта не должно быть
 * зависимостей. Значение нужно ровно одно, и формат файла мы контролируем.
 */
function readBaseUrl(configText) {
  const match = /^\s*baseUrl:\s*(\S+)\s*$/m.exec(configText);
  if (match === null) {
    fail(`в ${CONFIG} не найден target.baseUrl`);
  }
  return new URL(match[1]);
}

/** Имена переменных с токенами берутся из той же конфигурации — чтобы не разошлись. */
function readTokenEnvNames(configText) {
  const names = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (names.length === 0) {
    fail(`в ${CONFIG} нет ни одного tokenEnv`);
  }
  return names;
}

async function waitForHealth(baseUrl, child, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null) {
      return undefined;
    }
    try {
      const response = await fetch(new URL("/v1/health", baseUrl));
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Ещё не слушает — пробуем снова.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return undefined;
}

function startServer(environment) {
  const child = spawn(process.execPath, [SERVER], {
    env: environment,
    stdio: ["ignore", "inherit", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return { child, readStderr: () => stderr };
}

function stopServer(child) {
  return new Promise((done) => {
    if (child.exitCode !== null) {
      done();
      return;
    }
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });
}

function runCli(reportPath, environment) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [CLI, "run", "-c", CONFIG, "-e", ENDPOINTS, "-r", reportPath, ...RUN_FLAGS],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/** Ключ ячейки. Объект отсутствует у эндпоинтов без параметров пути. */
/**
 * Ключ ячейки. Понимает и расхождения матрицы, и находки проверок.
 *
 * У расхождения третья координата — объект, у находки проверки — второй аккаунт
 * пары: дефект списка проявляется не на объекте, а на совпадении двух ответов.
 */
function cellKey(finding) {
  const account = finding.account ?? finding.accountId;
  const endpoint = finding.endpoint ?? finding.endpointId;
  const kind = finding.kind ?? finding.checkId;
  const detail =
    finding.other ??
    finding.evidence?.otherAccountId ??
    finding.resource ??
    finding.resourceId ??
    "—";
  return `${account} × ${endpoint} × ${detail} [${kind}]`;
}

function difference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`не найден ${CLI}. Соберите инструмент: pnpm run build`);
  }

  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl указывает на ${baseUrl.hostname}; платформа слушает только 127.0.0.1`);
  }
  const tokenEnvNames = readTokenEnvNames(configText);

  const groundTruth = JSON.parse(await readFile(GROUND_TRUTH, "utf8"));
  const selected = process.argv.slice(2);
  const combinations = groundTruth.combinations.filter(
    (combination) => selected.length === 0 || selected.includes(combination.id),
  );
  if (combinations.length === 0) {
    fail(`не найдено ни одной комбинации по фильтру: ${selected.join(", ")}`);
  }

  // Токены случайны на каждый запуск: в файлах их нет и быть не должно.
  const tokens = Object.fromEntries(
    tokenEnvNames.map((name) => [name, randomBytes(24).toString("hex")]),
  );
  const reportDir = await mkdtemp(join(tmpdir(), "barbican-polygon-"));

  let mismatched = 0;

  for (const combination of combinations) {
    const flags = Object.fromEntries(
      Object.entries(combination.flags).map(([name, on]) => [name, on ? "1" : "0"]),
    );
    const environment = {
      ...process.env,
      ...tokens,
      ...flags,
      POLYGON_PORT: baseUrl.port,
    };

    const enabled = Object.entries(combination.flags)
      .filter(([, on]) => on)
      .map(([name]) => name);
    process.stdout.write(
      `\n=== ${combination.id} === флаги: ${enabled.length === 0 ? "все выключены" : enabled.join(", ")}\n`,
    );

    const { child, readStderr } = startServer(environment);
    const health = await waitForHealth(baseUrl, child);
    if (health === undefined) {
      await stopServer(child);
      fail(`платформа не поднялась на ${baseUrl.origin}:\n${readStderr()}`);
    }

    // Флаг мог не долететь — например, из-за опечатки в имени переменной.
    // Тогда прогон дал бы ноль находок и выглядел бы пропуском инструмента.
    for (const [name, on] of Object.entries(combination.flags)) {
      const field = FLAG_FIELDS[name];
      if (health.defects?.[field] !== on) {
        await stopServer(child);
        fail(`платформа поднялась с ${field}=${health.defects?.[field]}, ожидалось ${on}`);
      }
    }

    const reportPath = join(reportDir, `${combination.id}.report.json`);
    const result = await runCli(reportPath, environment);
    await stopServer(child);

    if (!existsSync(reportPath)) {
      process.stdout.write(`  РАСХОЖДЕНИЕ: отчёт не создан, код ${result.code}\n${result.stderr}`);
      mismatched += 1;
      continue;
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    const expected = new Set(combination.findings.map(cellKey));
    // Находки проверок сравниваются наравне с расхождениями матрицы: дефект,
    // невидимый по статусу, — такой же дефект.
    const actual = new Set([...report.findings, ...report.checks].map(cellKey));
    const missing = difference(expected, actual);
    const extra = difference(actual, expected);

    const problems = [];
    if (missing.length > 0) {
      problems.push(`не найдено (${missing.length}):\n    ${missing.join("\n    ")}`);
    }
    if (extra.length > 0) {
      problems.push(`найдено сверх оракула (${extra.length}):\n    ${extra.join("\n    ")}`);
    }
    if (result.code !== combination.expectedExitCode) {
      problems.push(`код возврата ${result.code}, ожидался ${combination.expectedExitCode}`);
    }
    // Признаки недостоверного прогона: находок может не быть просто потому,
    // что до них не дошли.
    if (report.truncated) {
      problems.push("прогон оборван (truncated), хвост матрицы не проверен");
    }
    if (report.unauthenticated.length > 0) {
      problems.push(`аккаунты без доступа нигде: ${report.unauthenticated.join(", ")}`);
    }
    if (report.summary.failures > 0) {
      problems.push(`сорвавшихся обращений: ${report.summary.failures}`);
    }
    if (report.canariesChecked === 0) {
      problems.push("канарейки не проверялись: аутентификация не подтверждена");
    }

    process.stdout.write(
      `  опрошено ячеек: ${report.summary.observations}, ` +
        `канареек: ${report.canariesChecked}, ` +
        `находок: ${report.summary.findings + report.summary.checkFindings} ` +
        `(из них по телу ${report.summary.checkFindings}) ` +
        `(ожидалось ${combination.findings.length})\n`,
    );

    if (problems.length === 0) {
      process.stdout.write(`  СОВПАЛО с оракулом, код возврата ${result.code}\n`);
    } else {
      mismatched += 1;
      for (const problem of problems) {
        process.stdout.write(`  РАСХОЖДЕНИЕ: ${problem}\n`);
      }
      process.stdout.write(`  вывод инструмента:\n${result.stderr.replace(/^/gm, "    ")}`);
    }
  }

  process.stdout.write(
    `\nИтог: комбинаций ${combinations.length}, расхождений ${mismatched}. ` +
      `Отчёты: ${reportDir}\n`,
  );
  process.exitCode = mismatched === 0 ? 0 : 1;
}

await main();
