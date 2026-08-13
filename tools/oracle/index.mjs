/**
 * Общий модуль сверки с машиночитаемым оракулом.
 *
 * Формат описан в ADR-0012. До него у каждого полигона была своя форма и своя
 * сверка, общего кода не было ни строки, и каждый следующий полигон стоил как
 * первый.
 *
 * Живёт вне `src/`, потому что это оснастка проверки самого инструмента,
 * а не часть поставляемого пакета (`files: ["dist"]`).
 */

/**
 * Виды видимости дефекта. Обоснование перечня — ADR-0012.
 *
 * Первые два означают «инструмент это находит», остальные — почему не находит.
 * Причины разведены намеренно: «живёт на POST», «эндпоинт трогать нельзя»
 * и «вопрос не про матрицу доступа» — три разных пробела с тремя разными
 * способами закрыть их, и один общий `invisible` стирал это различие.
 */
export const VISIBILITIES = [
  /** Виден по коду ответа. */
  "status",
  /** Виден через необратимый скаляр над телом (ADR-0011). */
  "body-signal",
  /** Разница в теле, но невыразима объявленным скаляром: значения полей. */
  "body-only",
  /** Живёт на методе записи: без `--unsafe-methods` эндпоинт не опрашивается. */
  "unsafe-method",
  /** Был бы виден, но эндпоинт исключён намеренно: обращение ломает стенд. */
  "excluded",
  /** Вне области модуля 1: вопрос не о матрице «роль × эндпоинт». */
  "out-of-scope",
];

/** Виды, при которых дефект обязан обнаруживаться. */
export const DETECTABLE = ["status", "body-signal"];

export class GroundTruthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GroundTruthError";
  }
}

function requireObject(value, where) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GroundTruthError(`${where}: ожидался объект`);
  }
  return value;
}

/**
 * Разбирает и проверяет оракул.
 *
 * Проверки не косметические. Находка, ссылающаяся на несуществующий дефект,
 * означает, что оракул рассинхронизирован с собственным перечнем дефектов, —
 * и сверка по нему подтвердит что угодно.
 */
export function loadGroundTruth(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new GroundTruthError(`не разбирается как JSON: ${cause.message}`);
  }
  requireObject(parsed, "оракул");

  const defects = requireObject(parsed.defects, "defects");
  for (const [id, defect] of Object.entries(defects)) {
    requireObject(defect, `defects.${id}`);
    if (!VISIBILITIES.includes(defect.visibility)) {
      throw new GroundTruthError(
        `defects.${id}.visibility = ${JSON.stringify(defect.visibility)}; ` +
          `допустимы ${VISIBILITIES.join(", ")}. Дефект без объявленной видимости ` +
          `не отличить от забытого: именно поэтому поле обязательно.`,
      );
    }
  }

  if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    throw new GroundTruthError("variants: ожидался непустой массив");
  }

  const seen = new Set();
  for (const variant of parsed.variants) {
    requireObject(variant, "variants[]");
    if (typeof variant.id !== "string" || variant.id === "") {
      throw new GroundTruthError("variants[].id: ожидалась непустая строка");
    }
    if (seen.has(variant.id)) {
      throw new GroundTruthError(`вариант "${variant.id}" объявлен больше одного раза`);
    }
    seen.add(variant.id);
    requireObject(variant.selector, `variants.${variant.id}.selector`);
    if (!Number.isInteger(variant.expectedExitCode)) {
      throw new GroundTruthError(`variants.${variant.id}.expectedExitCode: ожидалось целое`);
    }
    if (!Array.isArray(variant.findings)) {
      throw new GroundTruthError(`variants.${variant.id}.findings: ожидался массив`);
    }
    for (const finding of variant.findings) {
      requireObject(finding, `variants.${variant.id}.findings[]`);
      if (!Array.isArray(finding.defects) || finding.defects.length === 0) {
        throw new GroundTruthError(
          `вариант "${variant.id}": у находки нет ни одного дефекта в поле defects. ` +
            `Находка, которую нечем объяснить, — это либо забытый дефект, ` +
            `либо ошибка в самом оракуле.`,
        );
      }
      for (const id of finding.defects) {
        if (!Object.hasOwn(defects, id)) {
          throw new GroundTruthError(
            `вариант "${variant.id}": находка ссылается на дефект "${id}", ` +
              `которого нет в перечне. Оракул рассинхронизирован сам с собой.`,
          );
        }
      }
    }
  }

  return parsed;
}

/**
 * Проверяет оракул на полноту.
 *
 * Отвечает не на вопрос «совпало ли», а на вопрос «а всё ли объявленное вообще
 * проверяется». Дефект, объявленный видимым и не встречающийся ни в одном
 * варианте, — это либо забытый вариант, либо неверная пометка видимости.
 * Дефект, объявленный недостижимым и при этом ожидаемый в находках, —
 * противоречие в самом оракуле.
 */
export function checkCoverage(groundTruth) {
  const used = new Set();
  for (const variant of groundTruth.variants) {
    for (const finding of variant.findings) {
      for (const id of finding.defects) {
        used.add(id);
      }
    }
  }

  const problems = [];
  for (const [id, defect] of Object.entries(groundTruth.defects)) {
    const detectable = DETECTABLE.includes(defect.visibility);
    if (!detectable && used.has(id)) {
      problems.push(
        `дефект "${id}" объявлен недостижимым (${defect.visibility}), но ожидается в находках`,
      );
    }
    if (detectable && !used.has(id)) {
      problems.push(
        `дефект "${id}" объявлен видимым (${defect.visibility}), но не ожидается ни в одном варианте`,
      );
    }
  }
  return problems;
}

/**
 * Ключ ячейки.
 *
 * Понимает и расхождения матрицы, и находки проверок: у первых третья
 * координата — объект, у вторых — второй аккаунт пары, потому что дефект
 * списка проявляется не на объекте, а на совпадении двух ответов.
 */
export function cellKey(finding) {
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

/**
 * Сверяет отчёт инструмента с ожиданиями варианта.
 *
 * Сравнение множествами в обе стороны: пропущенное и лишнее — разные ошибки.
 * Одного числа находок недостаточно, оно совпадает и при взаимной компенсации.
 */
export function compareVariant(variant, report, exitCode) {
  const expected = new Set(variant.findings.map(cellKey));
  // Список находок один: способ обнаружения — поле `source`, а не отдельный
  // массив. Прежний запасной `report.checks` держался на форме отчёта,
  // которой больше нет, и молча ничего не добавлял.
  const actual = new Set(report.findings.map(cellKey));

  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const unexpected = [...actual].filter((key) => !expected.has(key)).sort();

  const problems = [];
  if (missing.length > 0) {
    problems.push(`не найдено (${missing.length}):\n    ${missing.join("\n    ")}`);
  }
  if (unexpected.length > 0) {
    problems.push(
      `найдено сверх оракула (${unexpected.length}):\n    ${unexpected.join("\n    ")}`,
    );
  }
  if (exitCode !== variant.expectedExitCode) {
    problems.push(`код возврата ${exitCode}, ожидался ${variant.expectedExitCode}`);
  }
  // Признаки недостоверности прогона: находок может не быть просто потому,
  // что до них не дошли.
  if (report.truncated === true) {
    problems.push("прогон оборван, хвост матрицы не проверен");
  }
  if ((report.unauthenticated ?? []).length > 0) {
    problems.push(`аккаунты без доступа нигде: ${report.unauthenticated.join(", ")}`);
  }

  return { missing, unexpected, problems };
}
