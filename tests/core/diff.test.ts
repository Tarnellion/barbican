import { describe, expect, it } from "vitest";
import { buildAccessMatrix, diffAccess } from "../../src/core/index.js";
import {
  accounts,
  cleanObservations,
  denialObservations,
  endpoints,
  escalationObservations,
  observe,
  policy,
} from "../fixtures/scenario.js";

function matrixWith(observations: Parameters<typeof buildAccessMatrix>[0]["observations"]) {
  return buildAccessMatrix({ endpoints, accounts, observations });
}

describe("diffAccess", () => {
  // Главный тест набора. Инструмент, находящий несуществующее, теряет доверие
  // быстрее, чем тот, который что-то пропускает.
  it("не находит ничего, когда платформа ведёт себя как объявлено", () => {
    expect(diffAccess(matrixWith(cleanObservations), policy)).toEqual([]);
  });

  it("находит эскалацию привилегий: ожидался отказ, доступ получен", () => {
    const diffs = diffAccess(matrixWith(escalationObservations), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        actual: "allowed",
        kind: "privilege-escalation",
      },
    ]);
  });

  it("находит неожиданный отказ: ожидался доступ, получен отказ", () => {
    const diffs = diffAccess(matrixWith(denialObservations), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.support.a",
        endpointId: "ep.tickets.list",
        expected: "allowed",
        actual: "denied",
        kind: "unexpected-denial",
      },
    ]);
  });

  it("сообщает о непокрытой паре вместо того, чтобы додумать исход", () => {
    const partial = cleanObservations.filter(
      (o) => !(o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"),
    );

    const diffs = diffAccess(matrixWith(partial), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        kind: "not-observed",
      },
    ]);
  });

  it("не делает вывода о доступе, если обращение завершилось ошибкой", () => {
    const withError = cleanObservations.map((o) =>
      o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"
        ? observe(o.accountId, o.endpointId, "error")
        : o,
    );

    const diffs = diffAccess(matrixWith(withError), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        actual: "error",
        kind: "probe-error",
      },
    ]);
  });

  it("считает 404 отказом, а не отдельным расхождением", () => {
    const withNotFound = cleanObservations.map((o) =>
      o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"
        ? observe(o.accountId, o.endpointId, "not-found")
        : o,
    );

    expect(diffAccess(matrixWith(withNotFound), policy)).toEqual([]);
  });

  it("выдаёт расхождения в детерминированном порядке", () => {
    const broken = cleanObservations.map((o) =>
      o.endpointId === "ep.users.list" && o.accountId !== "acc.admin.a"
        ? observe(o.accountId, o.endpointId, "allowed")
        : o,
    );

    const first = diffAccess(matrixWith(broken), policy);
    const second = diffAccess(matrixWith(broken), policy);

    expect(first).toEqual(second);
    expect(first.map((d) => d.accountId)).toEqual([
      "acc.player.a",
      "acc.support.a",
      "acc.player.b",
    ]);
  });
});
