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
import { checkCoverage, compareVariant, loadGroundTruth } from "../../tools/oracle/index.mjs";
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
    fail(`target.baseUrl not found in ${CONFIG}`);
  }
  return new URL(match[1]);
}

function readTokenEnvNames(configText) {
  const names = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (names.length === 0) {
    fail(`no tokenEnv found in ${CONFIG}`);
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
      fail(`the configuration needs ${name}, but tokens.mjs does not provide that variable`);
    }
  }
  for (const user of USERS) {
    if (!configText.includes(`username: ${user.username}`)) {
      fail(`tokens.mjs creates user "${user.username}", but ${CONFIG} has no such resource`);
    }
    if (!configText.includes(`book_title: ${user.book}`)) {
      fail(`tokens.mjs creates book "${user.book}", but ${CONFIG} has no such resource`);
    }
  }
}

/**
 * Проверяет оракул на внутреннюю согласованность и полноту.
 *
 * Разбор формата и связь «находка → дефект» проверяет общий модуль (ADR-0012).
 * Здесь остаётся то, что общий модуль знать не обязан: полнота — дефект,
 * объявленный видимым и не ожидаемый ни в одном варианте, есть либо забытый
 * вариант, либо неверная пометка видимости.
 */
function assertOracleIsSound(groundTruth) {
  const gaps = checkCoverage(groundTruth);
  if (gaps.length > 0) {
    fail(`the ground truth is incomplete:\n  ${gaps.join("\n  ")}`);
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
    fail(`docker compose up exited with code ${result.code}:\n${result.stderr}`);
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

async function checkMode(mode, baseUrl, reportDir) {
  const environment = composeEnvironment(baseUrl.port, mode.selector.vulnerable);

  process.stdout.write(`\n=== ${mode.id} === vulnerable=${mode.selector.vulnerable}\n`);

  await composeUp(environment);
  const banner = await waitForBanner(baseUrl);
  if (banner === undefined) {
    await composeDown(environment);
    fail(`VAmPI did not come up on ${baseUrl.origin}`);
  }
  if (banner.vulnerable !== mode.selector.vulnerable) {
    await composeDown(environment);
    fail(
      `the deployment came up with vulnerable=${banner.vulnerable}, expected ${mode.selector.vulnerable}`,
    );
  }

  const tokens = await provision({
    baseUrl: baseUrl.origin,
    log: (message) => process.stdout.write(`  setup: ${message}\n`),
  });

  const reportPath = join(reportDir, `${mode.id}.report.json`);
  const result = await runCli(reportPath, { ...environment, ...Object.fromEntries(tokens) });

  if (!existsSync(reportPath)) {
    process.stdout.write(
      `  MISMATCH: no report was produced, exit code ${result.code}\n${result.stderr}`,
    );
    return false;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  // Сравнение и проверки достоверности — общие для всех полигонов (ADR-0012).
  const { problems: shared } = compareVariant(mode, report, result.code);
  const problems = [...shared];

  // Разрушающий эндпоинт обязан остаться нетронутым: опрошенный, он стирает
  // пользователей и книги, и остаток матрицы проверяется против пустой базы.
  const destructive = report.skipped.find((item) => item.endpointId === DESTRUCTIVE_ENDPOINT);
  if (destructive?.reason !== "excluded") {
    problems.push(
      `${DESTRUCTIVE_ENDPOINT} was not excluded from the run — the deployment may have been reset`,
    );
  }
  // Признаки недостоверного прогона: находок может не быть просто потому,
  // что до них не дошли.
  if (report.truncated) {
    problems.push("the run was cut short (truncated), the tail of the matrix was never tested");
  }
  if (report.unauthenticated.length > 0) {
    problems.push(`accounts with no access anywhere: ${report.unauthenticated.join(", ")}`);
  }
  if (report.summary.failures > 0) {
    problems.push(`failed requests: ${report.summary.failures}`);
  }
  if (report.canariesChecked === 0) {
    problems.push("no canary was checked: authentication is unconfirmed");
  }

  process.stdout.write(
    `  cells probed: ${report.summary.observations}, ` +
      `canaries: ${report.canariesChecked}, ` +
      `findings: ${report.summary.findings} (oracle expects ${mode.findings.length})\n`,
  );

  if (problems.length === 0) {
    process.stdout.write(`  MATCHES the ground truth, exit code ${result.code}\n`);
    return true;
  }
  for (const problem of problems) {
    process.stdout.write(`  MISMATCH: ${problem}\n`);
  }
  process.stdout.write(`  tool output:\n${result.stderr.replace(/^/gm, "    ")}`);
  return false;
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`${CLI} not found. Build the tool: pnpm run build`);
  }

  const docker = await run("docker", ["image", "inspect", IMAGE]);
  if (docker.code !== 0) {
    fail(
      `image ${IMAGE} is not present locally (docker image inspect: ${docker.code}). ` +
        `Run docker pull ${IMAGE} — pulling it silently mid-verification is not something this script does.`,
    );
  }

  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl points at ${baseUrl.hostname}; the polygon is published on loopback only`);
  }
  assertProvisioningMatchesConfig(configText);

  const groundTruth = loadGroundTruth(await readFile(GROUND_TRUTH, "utf8"));
  assertOracleIsSound(groundTruth);

  const keep = process.argv.includes("--keep");
  const selected = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const modes = groundTruth.variants.filter(
    (mode) => selected.length === 0 || selected.includes(mode.id),
  );
  if (modes.length === 0) {
    fail(`no mode matched the filter: ${selected.join(", ")}`);
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
      await composeDown(composeEnvironment(baseUrl.port, mode.selector.vulnerable));
      fail(`mode ${mode.id}: ${error.message}`);
    }
    if (!matched) {
      mismatched += 1;
    }
    if (!keep) {
      await composeDown(composeEnvironment(baseUrl.port, mode.selector.vulnerable));
    }
  }

  process.stdout.write(
    `\nTotal: ${modes.length} modes, ${mismatched} mismatches. Reports: ${reportDir}\n`,
  );
  if (keep) {
    process.stdout.write(`The deployment was left running: docker compose -f ${COMPOSE} down -v\n`);
  }
  return mismatched === 0 ? 0 : 1;
}

process.exitCode = await main();
