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
  describeCells,
  diffAccess,
  expandPolicy,
} from "./core/index.js";
import {
  applyBodySignals,
  assertContextsCannotWrite,
  assertReferencesResolve,
  parseRunConfig,
  resolveContextValues,
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
  "path-parameters": "have path parameters",
  "unsafe-method": "use an unsafe method",
  excluded: "excluded by hand",
  "escapes-target": "path leaves the target",
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
    throw new InvalidArgumentError("a positive integer is expected");
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
      `${paint("The target is unnamed:", "yellow")} target has no label field. ` +
        `The report will not identify the system under test, and a reader cannot tell ` +
        `a run against a real environment from a run against a demo polygon.\n`,
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
      "Give exactly one endpoint source: --spec (OpenAPI), " +
        "--endpoints (a hand-written list) or --postman (a Postman collection).",
    );
  }
  const parsed = await source.create().parse(await readFile(source.path, "utf8"));
  // Ссылки сверяются после разбора спецификации: раньше эндпоинтов ещё нет.
  assertReferencesResolve(config, parsed);
  // Значения атрибутов условий: литералы как есть, ссылки — из окружения.
  // Разрешаются до проверки подмены метода, потому что проверять надо то,
  // что реально уйдёт по проводу, а не то, что написано в файле.
  const contextValues = resolveContextValues(config, process.env);
  assertContextsCannotWrite(contextValues, { allowUnsafeMethods: flags.unsafeMethods === true });
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
  const { accounts, attributes: contextAttributes } = toAccounts(config, contextValues);

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
      `${paint("Authentication is unverified:", "yellow")} no account has a canary. ` +
        `If the tokens do not work, the run will report «no escalations found» having ` +
        `tested nothing. The run will end with exit code 2.\n`,
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
          (r) =>
            `  ${r.accountId}: ${r.endpointId} returned ${r.status === 0 ? "a failure" : r.status}`,
        )
        .join("\n");
      throw new Error(
        `Accounts are not authenticated, the run stopped:\n${details}\n` +
          `Continuing is not an option: 401 reads as a denial, and the report would ` +
          `come out clean.`,
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
  // Один обход на оба ответа: находки и вердикты по всем ячейкам, включая
  // совпавшие. Второй проход разошёлся бы, и отчёт утверждал бы «проверено
  // и совпало» о ячейке, попавшей в находки. См. ADR-0020.
  const cells = describeCells(matrix, policy);
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
    // Те же строки, что у матрицы: находка ссылается на аккаунт в условиях,
    // и он обязан быть в списке аккаунтов, иначе ссылка повисает.
    accounts,
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
    cells,
    checksRun,
    bodyComparison,
    // Как их разрешил сам троттлинг, а не как их написали флагами: умолчания
    // живут в адаптере, и второй их источник в отчёте разошёлся бы молча.
    ...(throttle.limits === undefined ? {} : { throttle: throttle.limits }),
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
      `${paint("The run was cut short:", "red")} the request budget ran out or the ` +
        `circuit breaker tripped. The tail of the matrix was never tested — the absence ` +
        `of findings there means nothing.\n`,
    );
  }
  if (unauthenticated.length > 0) {
    process.stderr.write(
      `${paint("No access anywhere:", "red")} ${suspicions
        .map(
          (s) => `${s.accountId} (${s.refused}/${s.expectedAllowed}, mostly ${s.dominantStatus})`,
        )
        .join(", ")}. ` +
        `Not a single endpoint declared accessible opened up — that is a sign of ` +
        `broken credentials or a wrong address, not of policy. The results cannot ` +
        `be trusted.\n`,
    );
  }
  const lines = [
    // Не «пар»: ячейка — это тройка «аккаунт × эндпоинт × объект», и 6×8 ≠ 80.
    // Читатель, проверяющий арифметику, решал, что отчёт врёт.
    `Cells probed: ${summary.observations} (matrix rows ${summary.accountRows}` +
      (summary.accountRows === summary.accounts
        ? ""
        : `, of them accounts ${summary.accounts} and the same accounts under contexts`) +
      `, endpoints ${summary.endpoints}, resources ${summary.resources})`,
    summary.skipped > 0
      ? `Endpoints not probed: ${summary.skipped}${skipBreakdown(report)}`
      : undefined,
    summary.failures > 0
      ? paint(`Requests that failed: ${summary.failures} (reasons in the report)`, "yellow")
      : undefined,
    escalations > 0
      ? paint(`Privilege escalation: ${escalations}`, "red")
      : paint("No privilege escalation found", "green"),
    `Other discrepancies: unexpected denials ${summary.byKind["unexpected-denial"] ?? 0}, ` +
      `not observed ${summary.byKind["not-observed"] ?? 0}, ` +
      `probe errors ${summary.byKind["probe-error"] ?? 0}`,
    // С чего начинать читателю: 17 находок в одном списке — это не отчёт.
    summary.findings === 0
      ? undefined
      : `Rows by severity: critical ${summary.bySeverity.critical}, ` +
        `high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, ` +
        `low ${summary.bySeverity.low}`,
    // Рядом — то же по дефектам. Иначе «критических 10» читается как десять
    // проблем, тогда как это один отсутствующий фильтр в десяти ячейках.
    summary.findings === 0
      ? undefined
      : `Defects by severity: critical ${summary.defectsBySeverity.critical}, ` +
        `high ${summary.defectsBySeverity.high}, medium ${summary.defectsBySeverity.medium}, ` +
        `low ${summary.defectsBySeverity.low}`,
    // Число строк говорит о размере матрицы, число сигнатур — о числе проблем.
    // «Не менее», а не «ровно»: два дефекта с одинаковой сигнатурой снаружи
    // неразличимы, и завышать точность нельзя.
    summary.findings === 0
      ? undefined
      : `Distinct defects: at least ${summary.defectGroups} (finding rows ${summary.findings})`,
    // Находки проверок называются отдельной строкой: они увидены не по статусу,
    // и смешивать их с эскалацией значило бы стереть это различие.
    summary.checkFindings > 0
      ? paint(`Of those, found by body rather than status: ${summary.checkFindings}`, "red")
      : undefined,
    flags.report === undefined ? undefined : `Report: ${flags.report}`,
  ].filter((line): line is string => line !== undefined);

  process.stderr.write(`${lines.join("\n")}\n`);
  return exitCodeFor(report);
}

const program = new Command();

program
  .name("barbican")
  .description("Tests RBAC and tenant isolation in the APIs of multi-tenant platforms")
  .version(version);

program
  .command("run")
  .description("Walk the role × endpoint matrix and compare it with the declared policy")
  .requiredOption("-c, --config <path>", "run configuration (YAML or JSON)")
  .option("-s, --spec <path>", "OpenAPI specification of the API under test")
  .option("-e, --endpoints <path>", "hand-written endpoint list, when there is no spec")
  .option("-p, --postman <path>", "Postman collection v2.1")
  .option("-r, --report <path>", "where to write the JSON report (stdout by default)")
  .option("--unsafe-methods", "allow methods that change state")
  .option("--concurrency <n>", "concurrent requests", positiveInteger)
  .option("--rps <n>", "requests per second", positiveInteger)
  .option("--max-requests <n>", "per-run request budget", positiveInteger)
  .action(async (flags: RunFlags) => {
    try {
      process.exitCode = await run(flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${paint("Run aborted:", "red")} ${message}\n`);
      process.exitCode = 2;
    }
  });

await program.parseAsync();
