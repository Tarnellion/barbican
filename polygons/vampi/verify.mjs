#!/usr/bin/env node

/**
 * Сверка инструмента с оракулом полигона VAmPI.
 *
 * Поднимает VAmPI в docker, заводит пользователей и книги, получает токены,
 * прогоняет собранный `dist/cli.js run` и сравнивает находки с `ground-truth.json`
 * в обе стороны — пропущенное и лишнее. Ложное срабатывание обесценивает
 * инструмент не меньше пропуска, поэтому «найдено сверх оракула» — такое же
 * расхождение, как «не найдено».
 *
 * Режимов два: `vulnerable` и `secure`. Это не «есть дефекты / нет дефектов»:
 * по кодам ответов режимы различаются ровно одним дефектом (ADR-0009), поэтому
 * у каждого свой список находок, и защищённый режим — не проверка на ноль,
 * а проверка на другое непустое множество.
 *
 * Ноль зависимостей: только встроенные модули и docker.
 *
 * Использование:
 *   node polygons/vampi/verify.mjs                 # оба режима
 *   node polygons/vampi/verify.mjs vulnerable      # только названный
 *   node polygons/vampi/verify.mjs --keep          # не гасить стенд после прогона
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provision, USERS } from "./tokens.mjs";

const POLYGON_DIR = import.meta.dirname;
const REPO_ROOT = resolve(POLYGON_DIR, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const COMPOSE = join(POLYGON_DIR, "docker-compose.yaml");
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");
const ENDPOINTS = join(POLYGON_DIR, "endpoints.yaml");
const GROUND_TRUTH = join(POLYGON_DIR, "ground-truth.json");

/** Образ проверяется до запуска: `compose up` иначе молча уходит в долгую тягу. */
const IMAGE = "erev0s/vampi:latest";

/**
 * Эндпоинт, обращение к которому разрушает стенд.
 *
 * Проверяется отдельно: если он окажется опрошенным, все находки после него
 * получены против пустой базы, и совпадение с оракулом было бы случайным.
 */
const DESTRUCTIVE_ENDPOINT = "db.createdb";

/**
 * Локальная петля терпит частоту выше дефолтной.
 *
 * Дефолты инструмента (2 одновременно, 5 в секунду) рассчитаны на чужой стенд.
 * Здесь стенд свой и в контейнере на той же машине.
 */
const RUN_FLAGS = ["--rps", "25", "--concurrency", "4"];

function fail(message) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(2);
}

function run(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => done({ code: -1, stdout: out, stderr: error.message }));
    child.on("exit", (code) => done({ code: code ?? -1, stdout: out, stderr: err }));
  });
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

function readTokenEnvNames(configText) {
  const names = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (names.length === 0) {
    fail(`в ${CONFIG} нет ни одного tokenEnv`);
  }
  return names;
}

/**
 * Сверяет, что скрипт заводит ровно тех, кого объявляет конфигурация.
 *
 * Расхождение здесь не падает, а тихо портит прогон: несозданный пользователь
 * даёт 404 на каждое обращение, 404 читается как отказ, отказ совпадает
 * с политикой — и отчёт выходит чистым, не проверив ничего.
 */
function assertProvisioningMatchesConfig(configText) {
  const declared = new Set(readTokenEnvNames(configText));
  const provided = new Set(USERS.map((user) => user.tokenEnv));
  for (const name of declared) {
    if (!provided.has(name)) {
      fail(`конфигурация требует ${name}, но tokens.mjs такой переменной не выдаёт`);
    }
  }
  for (const user of USERS) {
    if (!configText.includes(`username: ${user.username}`)) {
      fail(`tokens.mjs заводит пользователя "${user.username}", но в ${CONFIG} такого объекта нет`);
    }
    if (!configText.includes(`book_title: ${user.book}`)) {
      fail(`tokens.mjs создаёт книгу "${user.book}", но в ${CONFIG} такого объекта нет`);
    }
  }
}

/**
 * Проверяет оракул на внутреннюю согласованность.
 *
 * Опечатка в имени дефекта сама по себе безобидна, но означает, что находка
 * приписана несуществующему дефекту, — а список дефектов и есть то, ради чего
 * оракул написан. Видимость `status` обязательна: находкой может обернуться
 * только то, что различимо по коду ответа.
 */
function assertOracleIsSound(groundTruth) {
  for (const mode of groundTruth.modes) {
    for (const finding of mode.findings) {
      const defect = groundTruth.defects[finding.defect];
      if (defect === undefined) {
        fail(`режим ${mode.id}: находка ссылается на неизвестный дефект "${finding.defect}"`);
      }
      if (defect.visibility !== "status") {
        fail(
          `режим ${mode.id}: дефект "${finding.defect}" помечен как ${defect.visibility}, ` +
            `но заявлен находкой. Находкой может быть только видимое по коду ответа.`,
        );
      }
    }
  }
}

function composeEnvironment(port, vulnerable) {
  return { ...process.env, VAMPI_PORT: String(port), VAMPI_VULNERABLE: String(vulnerable) };
}

async function composeUp(environment) {
  const result = await run("docker", ["compose", "-f", COMPOSE, "up", "-d"], {
    env: environment,
  });
  if (result.code !== 0) {
    fail(`docker compose up завершился с кодом ${result.code}:\n${result.stderr}`);
  }
}

async function composeDown(environment) {
  await run("docker", ["compose", "-f", COMPOSE, "down", "-v"], { env: environment });
}

/**
 * Ждёт баннер `GET /` и возвращает его тело.
 *
 * Тело читает сверка, а не инструмент: в баннере VAmPI объявляет свой режим,
 * и это единственный способ убедиться, что стенд поднялся именно тем, каким
 * запрошен. Недолетевшая переменная иначе выглядела бы пропуском инструмента.
 */
async function waitForBanner(baseUrl, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(new URL("/", baseUrl), { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Ещё не слушает — пробуем снова.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return undefined;
}

function runCli(reportPath, environment) {
  return run("node", [CLI, "run", "-c", CONFIG, "-e", ENDPOINTS, "-r", reportPath, ...RUN_FLAGS], {
    env: environment,
  });
}

/** Ключ ячейки. Объект отсутствует у эндпоинтов без параметров пути. */
function cellKey(finding) {
  const resource = finding.resource ?? finding.resourceId ?? "—";
  const account = finding.account ?? finding.accountId;
  const endpoint = finding.endpoint ?? finding.endpointId;
  return `${account} × ${endpoint} × ${resource} [${finding.kind}]`;
}

function difference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

async function checkMode(mode, baseUrl, reportDir) {
  const environment = composeEnvironment(baseUrl.port, mode.vulnerable);

  process.stdout.write(`\n=== ${mode.id} === vulnerable=${mode.vulnerable}\n`);

  await composeUp(environment);
  const banner = await waitForBanner(baseUrl);
  if (banner === undefined) {
    await composeDown(environment);
    fail(`VAmPI не поднялась на ${baseUrl.origin}`);
  }
  if (banner.vulnerable !== mode.vulnerable) {
    await composeDown(environment);
    fail(`стенд поднялся с vulnerable=${banner.vulnerable}, ожидалось ${mode.vulnerable}`);
  }

  const tokens = await provision({
    baseUrl: baseUrl.origin,
    log: (message) => process.stdout.write(`  подготовка: ${message}\n`),
  });

  const reportPath = join(reportDir, `${mode.id}.report.json`);
  const result = await runCli(reportPath, { ...environment, ...Object.fromEntries(tokens) });

  if (!existsSync(reportPath)) {
    process.stdout.write(`  РАСХОЖДЕНИЕ: отчёт не создан, код ${result.code}\n${result.stderr}`);
    return false;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  const expected = new Set(mode.findings.map(cellKey));
  const actual = new Set(report.findings.map(cellKey));
  const missing = difference(expected, actual);
  const extra = difference(actual, expected);

  const problems = [];
  if (missing.length > 0) {
    problems.push(`не найдено (${missing.length}):\n    ${missing.join("\n    ")}`);
  }
  if (extra.length > 0) {
    problems.push(`найдено сверх оракула (${extra.length}):\n    ${extra.join("\n    ")}`);
  }
  if (result.code !== mode.expectedExitCode) {
    problems.push(`код возврата ${result.code}, ожидался ${mode.expectedExitCode}`);
  }
  // Разрушающий эндпоинт обязан остаться нетронутым: опрошенный, он стирает
  // пользователей и книги, и остаток матрицы проверяется против пустой базы.
  const destructive = report.skipped.find((item) => item.endpointId === DESTRUCTIVE_ENDPOINT);
  if (destructive?.reason !== "excluded") {
    problems.push(`${DESTRUCTIVE_ENDPOINT} не исключён из прогона — стенд мог быть сброшен`);
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
      `находок: ${report.summary.findings} (ожидалось ${mode.findings.length})\n`,
  );

  if (problems.length === 0) {
    process.stdout.write(`  СОВПАЛО с оракулом, код возврата ${result.code}\n`);
    return true;
  }
  for (const problem of problems) {
    process.stdout.write(`  РАСХОЖДЕНИЕ: ${problem}\n`);
  }
  process.stdout.write(`  вывод инструмента:\n${result.stderr.replace(/^/gm, "    ")}`);
  return false;
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`не найден ${CLI}. Соберите инструмент: pnpm run build`);
  }

  const docker = await run("docker", ["image", "inspect", IMAGE]);
  if (docker.code !== 0) {
    fail(
      `образ ${IMAGE} не найден локально (docker image inspect: ${docker.code}). ` +
        `Выполните docker pull ${IMAGE} — тянуть его молча посреди сверки незачем.`,
    );
  }

  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl указывает на ${baseUrl.hostname}; полигон публикуется только на петле`);
  }
  assertProvisioningMatchesConfig(configText);

  const groundTruth = JSON.parse(await readFile(GROUND_TRUTH, "utf8"));
  assertOracleIsSound(groundTruth);

  const keep = process.argv.includes("--keep");
  const selected = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const modes = groundTruth.modes.filter(
    (mode) => selected.length === 0 || selected.includes(mode.id),
  );
  if (modes.length === 0) {
    fail(`не найдено ни одного режима по фильтру: ${selected.join(", ")}`);
  }

  const reportDir = await mkdtemp(join(tmpdir(), "barbican-vampi-"));
  let mismatched = 0;

  for (const mode of modes) {
    let matched = false;
    try {
      matched = await checkMode(mode, baseUrl, reportDir);
    } catch (error) {
      // Сорвавшаяся подготовка — не расхождение, а невозможность проверить.
      // Стенд гасится в любом случае: оставить поднятым намеренно уязвимый API,
      // отдающий пароли без токена, — плохой способ закончить сверку.
      await composeDown(composeEnvironment(baseUrl.port, mode.vulnerable));
      fail(`режим ${mode.id}: ${error.message}`);
    }
    if (!matched) {
      mismatched += 1;
    }
    if (!keep) {
      await composeDown(composeEnvironment(baseUrl.port, mode.vulnerable));
    }
  }

  process.stdout.write(
    `\nИтог: режимов ${modes.length}, расхождений ${mismatched}. Отчёты: ${reportDir}\n`,
  );
  if (keep) {
    process.stdout.write(`Стенд оставлен поднятым: docker compose -f ${COMPOSE} down -v\n`);
  }
  return mismatched === 0 ? 0 : 1;
}

process.exitCode = await main();
