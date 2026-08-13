/**
 * Тесты общего модуля сверки с оракулом.
 *
 * Модуль несущий: на нём держатся все утверждения вида «расхождений 0».
 * Сверка, не умеющая падать, подтверждает что угодно.
 */

import { describe, expect, it } from "vitest";
import type { GroundTruth, Variant } from "../../tools/oracle/index.mjs";
import {
  cellKey,
  checkCoverage,
  compareVariant,
  GroundTruthError,
  loadGroundTruth,
} from "../../tools/oracle/index.mjs";

const MINIMAL: GroundTruth = {
  defects: {
    "missing-filter": { title: "нет фильтра", visibility: "status" },
  },
  variants: [
    {
      id: "clean",
      selector: { FLAG: false },
      expectedExitCode: 0,
      findings: [],
    },
    {
      id: "broken",
      selector: { FLAG: true },
      expectedExitCode: 1,
      findings: [
        {
          account: "alice",
          endpoint: "orders.read",
          resource: "o-1",
          kind: "privilege-escalation",
          defects: ["missing-filter"],
        },
      ],
    },
  ],
};

function sourceOf(patch: (value: GroundTruth) => unknown): string {
  return JSON.stringify(patch(structuredClone(MINIMAL)));
}

describe("loadGroundTruth", () => {
  it("принимает корректный оракул", () => {
    expect(loadGroundTruth(JSON.stringify(MINIMAL)).variants).toHaveLength(2);
  });

  it("отвергает неразбираемый JSON", () => {
    expect(() => loadGroundTruth("{не json")).toThrow(GroundTruthError);
  });

  /**
   * Видимость обязательна: дефект без неё не отличить от забытого, а именно
   * это различие ADR-0012 и вводил.
   */
  it("отвергает дефект без объявленной видимости", () => {
    const source = sourceOf((value) => ({
      ...value,
      defects: { "missing-filter": { title: "нет фильтра" } },
    }));

    expect(() => loadGroundTruth(source)).toThrow(/visibility/);
  });

  it("отвергает неизвестное значение видимости", () => {
    const source = sourceOf((value) => ({
      ...value,
      defects: { "missing-filter": { visibility: "maybe" } },
    }));

    expect(() => loadGroundTruth(source)).toThrow(GroundTruthError);
  });

  /** Оракул, ссылающийся на несуществующий дефект, подтвердит что угодно. */
  it("отвергает находку со ссылкой на несуществующий дефект", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: value.variants.map((variant) =>
        variant.id === "broken"
          ? { ...variant, findings: [{ ...variant.findings[0], defects: ["опечатка"] }] }
          : variant,
      ),
    }));

    expect(() => loadGroundTruth(source)).toThrow(/out of sync with itself/);
  });

  /**
   * Находка без дефекта — либо забытый дефект, либо ошибка в оракуле.
   * Молча принятая, она делает проверку полноты бессмысленной.
   */
  it("отвергает находку без единого дефекта", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: value.variants.map((variant) =>
        variant.id === "broken"
          ? { ...variant, findings: [{ ...variant.findings[0], defects: [] }] }
          : variant,
      ),
    }));

    expect(() => loadGroundTruth(source)).toThrow(/has no defect/);
  });

  it("отвергает повторяющийся идентификатор варианта", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: [value.variants[0], value.variants[0]],
    }));

    expect(() => loadGroundTruth(source)).toThrow(/more than once/);
  });

  it("отвергает пустой перечень вариантов", () => {
    expect(() => loadGroundTruth(sourceOf((value) => ({ ...value, variants: [] })))).toThrow(
      GroundTruthError,
    );
  });
});

describe("checkCoverage", () => {
  /**
   * Вложенные дефекты: ячейки одного — подмножество ячеек другого. Общая ячейка
   * объясняется обоими, и без этого частный случай выглядел бы непроверяемым.
   * Найдено при миграции оракула платформы: PARENT_LEAK числился неохваченным,
   * потому что все его ячейки принадлежали и ANCESTOR_LEAK.
   */
  it("засчитывает дефект, объясняющий ячейку наравне с другим", () => {
    const nested: GroundTruth = {
      defects: {
        "whole-chain": { visibility: "status" },
        "one-step": { visibility: "status" },
      },
      variants: [
        {
          id: "both",
          selector: {},
          expectedExitCode: 1,
          findings: [
            {
              account: "a",
              endpoint: "e",
              kind: "privilege-escalation",
              defects: ["whole-chain", "one-step"],
            },
          ],
        },
      ],
    };

    expect(checkCoverage(nested)).toEqual([]);
  });

  it("молчит, когда каждый видимый дефект где-то ожидается", () => {
    expect(checkCoverage(MINIMAL)).toEqual([]);
  });

  /** Забытый вариант и неверная пометка видимости выглядят одинаково. */
  it("замечает видимый дефект, не ожидаемый ни в одном варианте", () => {
    const withOrphan: GroundTruth = {
      ...MINIMAL,
      defects: { ...MINIMAL.defects, forgotten: { visibility: "status" } },
    };

    expect(checkCoverage(withOrphan)).toEqual([
      expect.stringContaining("forgotten") as unknown as string,
    ]);
  });

  /** Причина недостижимости разная, а следствие одно: в находках его быть не должно. */
  it("замечает противоречие: недостижимый дефект ожидается в находках", () => {
    const contradictory: GroundTruth = {
      ...MINIMAL,
      defects: { "missing-filter": { visibility: "unsafe-method" } },
    };

    expect(checkCoverage(contradictory)[0]).toMatch(/unreachable/);
  });
});

describe("cellKey", () => {
  it("одинаково ключует запись оракула и находку инструмента", () => {
    const fromOracle = cellKey({
      account: "alice",
      endpoint: "orders.read",
      resource: "o-1",
      kind: "privilege-escalation",
    });
    const fromReport = cellKey({
      accountId: "alice",
      endpointId: "orders.read",
      resourceId: "o-1",
      kind: "privilege-escalation",
    });

    expect(fromOracle).toBe(fromReport);
  });

  /** У находки проверки третья координата — второй аккаунт пары, а не объект. */
  it("ключует находку проверки по второму аккаунту пары", () => {
    const fromOracle = cellKey({
      account: "alice",
      endpoint: "orders.list",
      other: "carol",
      kind: "identical-response-across-tenants",
    });
    const fromReport = cellKey({
      accountId: "alice",
      endpointId: "orders.list",
      evidence: { otherAccountId: "carol" },
      checkId: "identical-response-across-tenants",
    });

    expect(fromOracle).toBe(fromReport);
  });
});

describe("compareVariant", () => {
  const broken = MINIMAL.variants[1] as Variant;
  const matching = {
    findings: [
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "o-1",
        kind: "privilege-escalation",
      },
    ],
    checks: [],
  };

  it("молчит при полном совпадении", () => {
    expect(compareVariant(broken, matching, 1).problems).toEqual([]);
  });

  it("замечает пропущенную находку", () => {
    const result = compareVariant(broken, { findings: [], checks: [] }, 1);

    expect(result.missing).toHaveLength(1);
    expect(result.problems[0]).toMatch(/not found/);
  });

  it("замечает находку сверх оракула", () => {
    const result = compareVariant(MINIMAL.variants[0] as Variant, matching, 0);

    expect(result.unexpected).toHaveLength(1);
    expect(result.problems[0]).toMatch(/beyond the ground truth/);
  });

  /**
   * Одного числа находок мало: пропуск и лишнее в равном количестве
   * компенсируют друг друга, и счётчик совпадёт при полном расхождении.
   */
  it("замечает взаимную компенсацию, которую не увидел бы счётчик", () => {
    const wrongCell = {
      findings: [
        {
          accountId: "bob",
          endpointId: "orders.read",
          resourceId: "o-1",
          kind: "privilege-escalation",
        },
      ],
      checks: [],
    };

    const result = compareVariant(broken, wrongCell, 1);

    expect(wrongCell.findings).toHaveLength(broken.findings.length);
    expect(result.missing).toHaveLength(1);
    expect(result.unexpected).toHaveLength(1);
  });

  it("замечает несовпадение кода возврата", () => {
    expect(compareVariant(broken, matching, 0).problems[0]).toMatch(/exit code/);
  });

  /** Находок может не быть просто потому, что до них не дошли. */
  it("не считает оборванный прогон совпадением", () => {
    const result = compareVariant(
      MINIMAL.variants[0] as Variant,
      {
        findings: [],
        checks: [],
        truncated: true,
      },
      0,
    );

    expect(result.problems[0]).toMatch(/cut short/);
  });

  it("не считает совпадением прогон с неаутентифицированными аккаунтами", () => {
    const result = compareVariant(
      MINIMAL.variants[0] as Variant,
      {
        findings: [],
        checks: [],
        unauthenticated: ["alice"],
      },
      0,
    );

    expect(result.problems[0]).toMatch(/no access anywhere/);
  });
});
