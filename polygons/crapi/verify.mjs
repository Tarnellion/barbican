#!/usr/bin/env node

/**
 * Сверка инструмента с оракулом полигона crAPI.
 *
 * Поднимает crAPI в docker, логинит предзаведённых пользователей, прогоняет
 * собранный `dist/cli.js run` и сравнивает находки с `ground-truth.json`
 * в обе стороны — пропущенное и лишнее. Ложное срабатывание обесценивает
 * инструмент не меньше пропуска, поэтому «найдено сверх оракула» — такое же
 * расхождение, как «не найдено».
 *
 * Вариант ровно один: у crAPI нет переключателя уязвимостей, и `selector`
 * оракула пуст. Подробности — в самом оракуле; проверка на пустоту ниже.
 *
 * Сам crAPI в репозиторий не вкладывается: чужой проект под своей лицензией.
 * Путь к его `deploy/docker` берётся из `CRAPI_DEPLOY_DIR`, спецификация —
 * из `CRAPI_SPEC` либо из того же дерева.
 *
 * Ноль зависимостей: только встроенные модули и docker.
 *
 * Использование:
 *   CRAPI_DEPLOY_DIR=/путь/к/crAPI/deploy/docker node polygons/crapi/verify.mjs
 *   ... node polygons/crapi/verify.mjs --keep    # не гасить стенд после прогона
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
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");
const OVERRIDE = join(POLYGON_DIR, "docker-compose.override.yaml");
const GROUND_TRUTH = join(POLYGON_DIR, "ground-truth.json");

/**
 * Образы crAPI. Проверяются до запуска: `compose up` иначе молча уходит
 * тянуть полтора гигабайта посреди сверки.
 */
const IMAGES = [
  "crapi/crapi-web",
  "crapi/crapi-identity",
  "crapi/crapi-community",
  "crapi/crapi-workshop",
];

/**
 * Эндпоинт, обращение к которому пишет в стенд.
 *
 * `GET /workshop/api/mechanic/receive_report` называется в спецификации
 * create_service_report и создаёт сервис-отчёт: безопасный метод, небезопасное
 * действие. Проверяется отдельно — опрошенный, он менял бы состояние стенда
 * посреди прогона, и совпадение с оракулом было бы случайным.
 */
const WRITING_ENDPOINT = "create_service_report";

/**
 * Локальная петля терпит частоту выше дефолтной.
 *
 * Дефолты инструмента (2 одновременно, 5 в секунду) рассчитаны на чужой стенд.
 * Здесь стенд свой и в контейнерах на той же машине.
 */
const RUN_FLAGS = ["--rps", "20", "--concurrency", "4"];

const PREFIX = "verify: ";

const NL = "\n";

/** Всё, что печатает скрипт, идёт в stdout: это отчёт о сверке, а не диагностика. */
function say(text) {
  process.stdout.write(text + NL);
}

function fail(message) {
  process.stderr.write(PREFIX + message + NL);
  process.exit(2);
}

/** Обёртка над spawn: собирает вывод и никогда не бросает. */
function run(command, args, options) {
  return new Promise((done) => {
    const settings = {};
    settings.stdio = ["ignore", "pipe", "pipe"];
    settings.env = options?.env ?? process.env;
    const child = spawn(command, args, settings);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
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
    fail("в конфигурации прогона не найден target.baseUrl");
  }
  return new URL(match[1]);
}

/**
 * Сверяет, что скрипт логинит ровно тех, кого объявляет конфигурация.
 *
 * Расхождение здесь не падает, а тихо портит прогон: аккаунт без токена
 * получает 401 на каждое обращение, 401 читается как отказ, отказ совпадает
 * с политикой — и отчёт выходит чистым, не проверив ничего.
 */
function assertLoginsMatchConfig(configText) {
  const hits = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)];
  const declared = hits.map((hit) => hit[1]);
  if (declared.length === 0) {
    fail("в конфигурации прогона нет ни одного tokenEnv");
  }
  const provided = new Set(USERS.map((account) => account.tokenEnv));
  for (const name of declared) {
    if (!provided.has(name)) {
      fail(`конфигурация требует ${name}, но tokens.mjs его не выдаёт`);
    }
  }
  for (const account of USERS) {
    if (!declared.includes(account.tokenEnv)) {
      fail(`tokens.mjs логинит ${account.id}, но в конфигурации такого аккаунта нет`);
    }
  }
}

/**
 * Где лежит сам crAPI.
 *
 * В репозиторий он не вкладывается: чужой проект под своей лицензией. Каталог
 * `deploy/docker` его дерева задаётся переменной CRAPI_DEPLOY_DIR, спецификация —
 * CRAPI_SPEC либо тем же деревом.
 */
function locateCrapi() {
  const deployDir = process.env.CRAPI_DEPLOY_DIR;
  if (deployDir === undefined) {
    fail("не задана CRAPI_DEPLOY_DIR: каталог deploy/docker дерева crAPI");
  }
  const compose = join(deployDir, "docker-compose.yml");
  if (!existsSync(compose)) {
    fail(`не найден ${compose}`);
  }
  const guess = join(deployDir, "..", "..", "openapi-spec", "crapi-openapi-spec.json");
  const spec = process.env.CRAPI_SPEC ?? guess;
  if (!existsSync(spec)) {
    fail(`не найдена спецификация ${spec}; задайте CRAPI_SPEC`);
  }
  return { compose, spec };
}

/**
 * Окружение compose.
 *
 * LISTEN_IP выставляется явно: полигон намеренно уязвим, и публиковать его
 * куда-либо кроме петли нельзя. Значение из .env самого crAPI при этом
 * перекрывается — переменная окружения в compose сильнее файла.
 */
function composeEnvironment() {
  const environment = { ...process.env };
  environment.LISTEN_IP = "127.0.0.1";
  return environment;
}

/**
 * Поднимается только веб-контейнер: остальное compose дотянет сам по
 * depends_on. Чат-бот в этот список не входит — см. наложение рядом.
 */
async function composeUp(compose, environment) {
  const args = ["compose", "-f", compose, "-f", OVERRIDE, "up", "-d", "crapi-web"];
  const result = await run("docker", args, { env: environment });
  if (result.code !== 0) {
    fail(`docker compose up завершился с кодом ${result.code}${NL}${result.stderr}`);
  }
}

/** Гасится всё вместе с томами: намеренно уязвимый стенд не оставляют поднятым. */
async function composeDown(compose, environment) {
  const args = ["compose", "-f", compose, "-f", OVERRIDE, "down", "-v"];
  await run("docker", args, { env: environment });
}

/**
 * Ждёт `GET /health` веб-контейнера.
 *
 * Ждёт сверка, а не инструмент: crAPI поднимается минуту и дольше, а прогон
 * по неготовому стенду дал бы сплошные 502 — отчёт без единой находки,
 * снаружи неотличимый от чистого.
 */
async function waitForHealth(baseUrl, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const options = { signal: AbortSignal.timeout(5000) };
      const response = await fetch(new URL("/health", baseUrl), options);
      if (response.ok) {
        return true;
      }
    } catch {
      // Ещё не слушает — пробуем снова.
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  return false;
}

/** Эндпоинты берутся из спецификации самого crAPI — своего списка полигон не ведёт. */
function runCli(spec, reportPath, environment) {
  const args = [CLI, "run", "-c", CONFIG, "-s", spec, "-r", reportPath, ...RUN_FLAGS];
  return run("node", args, { env: environment });
}

async function checkVariant(variant, baseUrl, spec, reportDir, compose) {
  const environment = composeEnvironment();
  say("");
  say(`=== ${variant.id} ===`);

  // Пустой selector — устройство полигона, а не недосмотр: переключателя
  // уязвимостей у crAPI нет. Непустой означал бы, что оракул поменялся,
  // а скрипт нет, и передать это стенду нечем.
  if (Object.keys(variant.selector).length > 0) {
    fail(`вариант ${variant.id} задаёт selector, а crAPI переключать нечем`);
  }

  await composeUp(compose, environment);
  const healthy = await waitForHealth(baseUrl, 240);
  if (!healthy) {
    await composeDown(compose, environment);
    fail(`crAPI не поднялась на ${baseUrl.origin}`);
  }

  const note = (message) => say(`  подготовка: ${message}`);
  const tokens = await provision({ baseUrl: baseUrl.origin, log: note });

  const reportPath = join(reportDir, `${variant.id}.report.json`);
  const withTokens = { ...environment, ...Object.fromEntries(tokens) };
  const result = await runCli(spec, reportPath, withTokens);

  if (!existsSync(reportPath)) {
    say(`  РАСХОЖДЕНИЕ: отчёт не создан, код ${result.code}`);
    say(result.stderr);
    return false;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  // Сравнение и проверки достоверности — общие для всех полигонов (ADR-0012).
  // Своего кода сравнения здесь нет и быть не должно.
  const shared = compareVariant(variant, report, result.code);
  const problems = [...shared.problems];

  // Пишущий эндпоинт обязан остаться нетронутым: опрошенный, он создаёт
  // сервис-отчёт, и остаток матрицы проверяется уже по изменённому стенду.
  const writing = report.skipped.find((item) => item.endpointId === WRITING_ENDPOINT);
  if (writing?.reason !== "excluded") {
    problems.push(`${WRITING_ENDPOINT} не исключён из прогона — стенд мог измениться`);
  }
  if (report.summary.failures > 0) {
    problems.push(`сорвавшихся обращений: ${report.summary.failures}`);
  }
  if (report.canariesChecked === 0) {
    problems.push("канарейки не проверялись: аутентификация не подтверждена");
  }

  const seen = report.summary.findings + report.summary.checkFindings;
  const counts = `  опрошено ячеек: ${report.summary.observations}`;
  const detail = `, канареек: ${report.canariesChecked}, находок: ${seen}`;
  say(`${counts + detail} (ожидалось ${variant.findings.length})`);

  if (problems.length === 0) {
    say(`  СОВПАЛО с оракулом, код возврата ${result.code}`);
    return true;
  }
  for (const problem of problems) {
    say(`  РАСХОЖДЕНИЕ: ${problem}`);
  }
  say("  вывод инструмента:");
  say(result.stderr.replace(/^/gm, "    "));
  return false;
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`не найден ${CLI}. Соберите инструмент: pnpm run build`);
  }

  for (const image of IMAGES) {
    const inspected = await run("docker", ["image", "inspect", image]);
    if (inspected.code !== 0) {
      fail(
        "образ " +
          image +
          " не найден локально. Вытяните образы crAPI заранее: тянуть полтора гигабайта посреди сверки незачем.",
      );
    }
  }

  const located = locateCrapi();
  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl указывает на ${baseUrl.hostname}; полигон живёт только в петле`);
  }
  assertLoginsMatchConfig(configText);

  // Полнота проверяется до прогона: дефект, объявленный видимым и не ожидаемый
  // ни в одном варианте, — это забытый вариант либо неверная пометка видимости.
  const groundTruth = loadGroundTruth(await readFile(GROUND_TRUTH, "utf8"));
  const gaps = checkCoverage(groundTruth);
  if (gaps.length > 0) {
    fail(`оракул неполон:${NL}  ${gaps.join(`${NL}  `)}`);
  }

  const keep = process.argv.includes("--keep");
  const named = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const chosen = (variant) => named.length === 0 || named.includes(variant.id);
  const variants = groundTruth.variants.filter(chosen);
  if (variants.length === 0) {
    fail(`не найдено ни одного варианта по фильтру: ${named.join(", ")}`);
  }

  const reportDir = await mkdtemp(join(tmpdir(), "barbican-crapi-"));
  let mismatched = 0;

  for (const variant of variants) {
    let matched = false;
    try {
      matched = await checkVariant(variant, baseUrl, located.spec, reportDir, located.compose);
    } catch (error) {
      // Сорвавшаяся подготовка — не расхождение, а невозможность проверить.
      // Стенд гасится в любом случае: оставить поднятым намеренно уязвимый API,
      // отдающий чужие заказы без токена, — плохой способ закончить сверку.
      await composeDown(located.compose, composeEnvironment());
      fail(`вариант ${variant.id}: ${error.message}`);
    }
    if (!matched) {
      mismatched += 1;
    }
    if (!keep) {
      await composeDown(located.compose, composeEnvironment());
    }
  }

  say("");
  const tail = `Итог: вариантов ${variants.length}, расхождений ${mismatched}`;
  say(`${tail}. Отчёты: ${reportDir}`);
  if (keep) {
    say("Стенд оставлен поднятым. Погасить: docker compose down -v в дереве crAPI.");
  }
  return mismatched === 0 ? 0 : 1;
}

process.exitCode = await main();
