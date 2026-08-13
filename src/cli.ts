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
import { createCredentialProvider } from "./adapters/credentials.js";
import { createEndpointListParser } from "./adapters/endpoint-list.js";
import { createHttpClient } from "./adapters/http.js";
import { createOpenApiParser } from "./adapters/openapi.js";
import type { SpecParser } from "./adapters/ports.js";
import { createPostmanCollectionParser } from "./adapters/postman.js";
import { createSignalExtractor } from "./adapters/signals.js";
import { createThrottle } from "./adapters/throttle.js";
import {
  buildAccessMatrix,
  CheckRegistry,
  createIdenticalResponseCheck,
  describeBodyComparison,
  diffAccess,
  expandPolicy,
} from "./core/index.js";
import {
  applyBodySignals,
  assertReferencesResolve,
  parseRunConfig,
  resolveTokens,
  toAccounts,
} from "./io/config.js";
import { findUnauthenticated } from "./report/authenticity.js";
import { buildReport, exitCodeFor } from "./report/build.js";
import { collectObservations, probeCanaries } from "./runner.js";

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
  "escapes-target": "путь уводит за пределы цели",
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
  readonly spec?: string;
  readonly endpoints?: string;
  readonly postman?: string;
  readonly report?: string;
  readonly unsafeMethods?: boolean;
  readonly concurrency?: number;
  readonly rps?: number;
  readonly maxRequests?: number;
}

async function run(flags: RunFlags): Promise<number> {
  const config = parseRunConfig(await readFile(flags.config, "utf8"));

  // Предупреждение, а не отказ: на своём полигоне метка не нужна, а на чужой
  // платформе отчёт без неё нельзя приложить к тикету — он не называет цель.
  if (config.target.label === undefined) {
    process.stderr.write(
      `${paint("Цель не названа:", "yellow")} в target нет поля label. ` +
        `Отчёт не сможет опознать проверяемую систему, и читатель не отличит ` +
        `прогон против стенда от прогона демонстрационного полигона.\n`,
    );
  }

  // Ровно один источник эндпоинтов: два молча разошлись бы, а ни одного
  // дало бы отчёт без находок, неотличимый от успешного.
  const sources = [
    { path: flags.spec, create: createOpenApiParser },
    { path: flags.endpoints, create: createEndpointListParser },
    { path: flags.postman, create: createPostmanCollectionParser },
  ].filter(
    (entry): entry is { path: string; create: () => SpecParser } => entry.path !== undefined,
  );
  const [source] = sources;
  if (sources.length !== 1 || source === undefined) {
    throw new Error(
      "Укажите ровно один источник эндпоинтов: --spec (OpenAPI), " +
        "--endpoints (ручной список) или --postman (коллекция Postman).",
    );
  }
  const parsed = await source.create().parse(await readFile(source.path, "utf8"));
  // Ссылки сверяются после разбора спецификации: раньше эндпоинтов ещё нет.
  assertReferencesResolve(config, parsed);
  // responseMustDifferByTenant — заявление человека об ожидании; источники
  // эндпоинтов (спека, список, коллекция) о нём не знают и знать не должны.
  const endpoints = applyBodySignals(parsed, config);
  // Шаблоны раскрываются здесь, до построения матрицы: шаблон, не совпавший
  // ни с одним эндпоинтом, обязан упасть на старте, а не увести пары в fallback.
  const policy = expandPolicy(config.policy, endpoints);

  const credentials = createCredentialProvider(
    config.auth,
    resolveTokens(config, process.env),
    config.accountAuth,
  );

  const throttle = createThrottle({
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.rps === undefined ? {} : { requestsPerSecond: flags.rps }),
    ...(flags.maxRequests === undefined ? {} : { maxRequests: flags.maxRequests }),
  });

  const client = createHttpClient({
    allowedHosts: config.target.allowedHosts,
    throttle,
    allowUnsafeMethods: flags.unsafeMethods === true,
    ...(config.bodySignals?.maxBodyBytes === undefined
      ? {}
      : {
          signalExtractor: createSignalExtractor({ maxBodyBytes: config.bodySignals.maxBodyBytes }),
        }),
  });

  // Аккаунты в объявленных условиях — отдельные строки матрицы. Атрибуты
  // (заголовки, параметры запроса) в ядро не идут: там достаточно метки.
  const { accounts, attributes: contextAttributes } = toAccounts(config);

  // Бренды часто разнесены по поддоменам; адрес выбирается по тенанту объекта,
  // потому что спрашиваем мы именно за чужие данные, а лежат они на чужом хосте.
  const tenantBaseUrls = new Map(
    (config.tenants ?? [])
      .filter((tenant) => tenant.baseUrl !== undefined)
      .map((tenant) => [tenant.id, tenant.baseUrl ?? ""]),
  );

  const canaries = config.accounts
    .filter((account) => account.canary !== undefined)
    .map((account) => ({ accountId: account.id, endpointId: account.canary ?? "" }));

  let canariesChecked = 0;
  let canaryOutcomes: readonly {
    readonly accountId: string;
    readonly endpointId: string;
    readonly status: number;
    readonly authenticated: boolean;
  }[] = [];
  if (canaries.length === 0) {
    process.stderr.write(
      `${paint("Аутентификация не проверена:", "yellow")} ни у одного аккаунта нет канарейки. ` +
        `Если токены не работают, прогон покажет «эскалаций не найдено», ничего не проверив.\n`,
    );
  } else {
    const results = await probeCanaries({
      baseUrl: config.target.baseUrl,
      endpoints,
      canaries,
      credentials,
      client,
      exclude: config.exclude,
      // Канарейки проверяют аутентификацию, а не условия: аккаунт в условиях
      // предъявляет те же учётные данные, и второй прогон по нему ничего
      // нового не подтвердил бы, зато удвоил бы обращения.
      accounts: accounts.filter((account) => account.contextId === undefined),
      tenantBaseUrls,
    });
    canariesChecked = results.length;
    canaryOutcomes = results;
    const broken = results.filter((result) => !result.authenticated);
    if (broken.length > 0) {
      const details = broken
        .map(
          (r) => `  ${r.accountId}: ${r.endpointId} вернул ${r.status === 0 ? "сбой" : r.status}`,
        )
        .join("\n");
      throw new Error(
        `Аккаунты не аутентифицированы, прогон остановлен:\n${details}\n` +
          `Продолжать нельзя: 401 читается как отказ, и отчёт выглядел бы чистым.`,
      );
    }
  }

  const startedAt = new Date();
  const { observations, skipped, failures, probed, truncated } = await collectObservations({
    baseUrl: config.target.baseUrl,
    endpoints,
    accounts,
    credentials,
    client,
    allowUnsafeMethods: flags.unsafeMethods === true,
    exclude: config.exclude,
    resources: config.resources,
    tenantBaseUrls,
    contextAttributes,
  });
  const finishedAt = new Date();

  // Матрица только из опрошенного: пропуск — пробел покрытия, а не расхождение
  // на каждый аккаунт. Иначе один пропуск даёт столько находок, сколько аккаунтов.
  const matrix = buildAccessMatrix({
    endpoints: probed,
    accounts,
    resources: config.resources,
    observations,
    ...(config.tenants === undefined ? {} : { tenants: config.tenants }),
  });
  const findings = diffAccess(matrix, policy);

  // Реестр создаётся явно и локально: глобального состояния в ядре нет (ADR-0003).
  // Проверка сама промолчит, если ни у одного эндпоинта нет объявления
  // responseMustDifferByTenant.
  const registry = new CheckRegistry();
  registry.register(createIdenticalResponseCheck());
  const checksRun = registry.list().map((check) => check.id);
  // Что проверка сравнивала, а что пропустила по родству. Пересчитывается
  // рядом с ней самой: правило пропуска описано там, и дубль тут разошёлся бы.
  const bodyComparison = describeBodyComparison({ matrix });
  const checks = registry.list().flatMap((check) => check.run({ matrix }));
  const suspicions = findUnauthenticated(
    accounts,
    observations,
    policy,
    config.resources,
    config.tenants,
  );
  const unauthenticated = suspicions.map((s) => s.accountId);

  const report = buildReport({
    // Та же карта, что у прогона: находка ссылается на аккаунт в условиях,
    // и он обязан быть в списке аккаунтов, иначе ссылка повисает.
    contextAccounts: contextAttributes,
    version,
    config,
    endpoints,
    probed,
    observations,
    skipped,
    failures,
    unauthenticated,
    canariesChecked,
    canaries: canaryOutcomes,
    truncated,
    unsafeMethods: flags.unsafeMethods === true,
    findings,
    policy,
    checks,
    checksRun,
    bodyComparison,
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
  const escalations = summary.byKind["privilege-escalation"] ?? 0;
  if (truncated) {
    process.stderr.write(
      `${paint("Прогон оборван:", "red")} исчерпан потолок обращений или сработал ` +
        `размыкатель. Хвост матрицы не проверен — отсутствие находок там ничего не значит.\n`,
    );
  }
  if (unauthenticated.length > 0) {
    process.stderr.write(
      `${paint("Доступа нет нигде:", "red")} ${suspicions
        .map(
          (s) =>
            `${s.accountId} (${s.refused}/${s.expectedAllowed}, чаще всего ${s.dominantStatus})`,
        )
        .join(", ")}. ` +
        `Ни один объявленный доступным эндпоинт не открылся — это признак неработающих ` +
        `учётных данных или неверного адреса, а не результата политики. Результатам верить нельзя.\n`,
    );
  }
  const lines = [
    // Не «пар»: ячейка — это тройка «аккаунт × эндпоинт × объект», и 6×8 ≠ 80.
    // Читатель, проверяющий арифметику, решал, что отчёт врёт.
    `Опрошено ячеек: ${summary.observations} (аккаунтов ${summary.accounts}, ` +
      `эндпоинтов ${summary.endpoints}, объектов ${summary.resources})`,
    summary.skipped > 0
      ? `Не опрошено эндпоинтов: ${summary.skipped}${skipBreakdown(report)}`
      : undefined,
    summary.failures > 0
      ? paint(`Сорвалось обращений: ${summary.failures} (причины в отчёте)`, "yellow")
      : undefined,
    escalations > 0
      ? paint(`Эскалация привилегий: ${escalations}`, "red")
      : paint("Эскалации привилегий не найдено", "green"),
    `Прочие расхождения: неожиданных отказов ${summary.byKind["unexpected-denial"] ?? 0}, ` +
      `не наблюдалось ${summary.byKind["not-observed"] ?? 0}, ошибок обращения ${summary.byKind["probe-error"] ?? 0}`,
    // С чего начинать читателю: 17 находок в одном списке — это не отчёт.
    summary.findings === 0
      ? undefined
      : `По серьёзности строк: критических ${summary.bySeverity.critical}, ` +
        `высоких ${summary.bySeverity.high}, средних ${summary.bySeverity.medium}, ` +
        `низких ${summary.bySeverity.low}`,
    // Рядом — то же по дефектам. Иначе «критических 10» читается как десять
    // проблем, тогда как это один отсутствующий фильтр в десяти ячейках.
    summary.findings === 0
      ? undefined
      : `По серьёзности дефектов: критических ${summary.defectsBySeverity.critical}, ` +
        `высоких ${summary.defectsBySeverity.high}, средних ${summary.defectsBySeverity.medium}, ` +
        `низких ${summary.defectsBySeverity.low}`,
    // Число строк говорит о размере матрицы, число сигнатур — о числе проблем.
    // «Не менее», а не «ровно»: два дефекта с одинаковой сигнатурой снаружи
    // неразличимы, и завышать точность нельзя.
    summary.findings === 0
      ? undefined
      : `Различных дефектов: не менее ${summary.defectGroups} (строк находок ${summary.findings})`,
    // Находки проверок называются отдельной строкой: они увидены не по статусу,
    // и смешивать их с эскалацией значило бы стереть это различие.
    summary.checkFindings > 0
      ? paint(`Из общего числа найдено по телу, а не по статусу: ${summary.checkFindings}`, "red")
      : undefined,
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
  .option("-s, --spec <path>", "спецификация OpenAPI проверяемого API")
  .option("-e, --endpoints <path>", "ручной список эндпоинтов, если спецификации нет")
  .option("-p, --postman <path>", "коллекция Postman v2.1")
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
