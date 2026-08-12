/**
 * Тесты сигналов над телом ответа.
 *
 * Главный из них — не про вычисление, а про то, что тело никуда не попадает.
 * ADR-0011 разрешил читать тело; цена этого разрешения в том, что запрет на PII
 * в отчёте теперь держится на типе значения сигнала, и это надо доказывать.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/adapters/http.js";
import type { SignalSpec } from "../../src/adapters/ports.js";
import {
  createSignalExtractor,
  InvalidSignalSpecError,
  parseSignalPath,
} from "../../src/adapters/signals.js";
import { createThrottle } from "../../src/adapters/throttle.js";
import { createTestClock } from "../fixtures/clock.js";

const SALT = new Uint8Array([1, 2, 3, 4]);

function streamOf(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (body === null) {
    throw new Error("тестовый поток не создался");
  }
  return body;
}

const DIGEST: readonly SignalSpec[] = [{ name: "digest", kind: "digest" }];

async function digestOf(text: string, salt = SALT): Promise<number | boolean | undefined> {
  const extractor = createSignalExtractor({ salt });
  const signals = await extractor.extract(streamOf(text), DIGEST);
  return signals["digest"];
}

describe("parseSignalPath", () => {
  it("разбирает сегменты через точку, пустой путь — корень", () => {
    expect(parseSignalPath("")).toEqual([]);
    expect(parseSignalPath("data.items")).toEqual(["data", "items"]);
  });

  it("отвергает пустой сегмент", () => {
    expect(() => parseSignalPath("data..items")).toThrow(InvalidSignalSpecError);
  });
});

describe("дайджест", () => {
  it("совпадает у одинаковых тел и расходится у разных", async () => {
    const left = await digestOf('{"orders":[1,2]}');
    const right = await digestOf('{"orders":[1,2]}');
    const other = await digestOf('{"orders":[1,3]}');

    expect(left).toBe(right);
    expect(left).not.toBe(other);
  });

  it("помещается в безопасное целое", async () => {
    const value = await digestOf('{"orders":[1,2]}');

    expect(typeof value).toBe("number");
    expect(Number.isSafeInteger(value)).toBe(true);
  });

  /**
   * Соль — не украшение. Без неё дайджест предсказуемого тела подбирается
   * перебором, и отчёт начинает подтверждать догадки о содержимом.
   */
  it("зависит от соли: одно и то же тело даёт разные значения в разных прогонах", async () => {
    const first = await digestOf('{"error":"forbidden"}', new Uint8Array([9, 9]));
    const second = await digestOf('{"error":"forbidden"}', new Uint8Array([7, 7]));

    expect(first).not.toBe(second);
  });

  /**
   * Проверяет именно **умолчание**, а не переданную соль: тесты выше подставляют
   * соль явно и потому не заметили бы, если бы умолчание стало константой.
   * Мутация «соль по умолчанию пустая» их все проходила.
   */
  it("по умолчанию солится случайно, поэтому дайджест не переносится между прогонами", async () => {
    const body = '{"error":"forbidden"}';
    const first = await createSignalExtractor().extract(streamOf(body), DIGEST);
    const second = await createSignalExtractor().extract(streamOf(body), DIGEST);

    expect(typeof first["digest"]).toBe("number");
    expect(first["digest"]).not.toBe(second["digest"]);
  });

  it("вычисляется и для тела, которое не является JSON", async () => {
    const value = await digestOf("не json вовсе");

    expect(typeof value).toBe("number");
  });
});

describe("count и present", () => {
  const specs: readonly SignalSpec[] = [
    { name: "orders", kind: "count", path: "data.orders" },
    { name: "hasNext", kind: "present", path: "next" },
  ];

  it("считает элементы массива по пути и находит присутствие", async () => {
    const extractor = createSignalExtractor({ salt: SALT });

    const signals = await extractor.extract(
      streamOf('{"data":{"orders":[1,2,3]},"next":"cursor"}'),
      specs,
    );

    expect(signals["orders"]).toBe(3);
    expect(signals["hasNext"]).toBe(true);
  });

  /**
   * Ноль был бы утверждением о пустоте, которого мы не делали: путь мог указывать
   * на объект, число или отсутствовать вовсе. Отсутствие сигнала честнее.
   */
  it("не выдаёт count, если по пути не массив", async () => {
    const extractor = createSignalExtractor({ salt: SALT });

    const signals = await extractor.extract(streamOf('{"data":{"orders":42}}'), specs);

    expect(signals["orders"]).toBeUndefined();
    expect(signals["hasNext"]).toBe(false);
  });

  /**
   * Тело приходит с чужого стенда. Без `Object.hasOwn` путь `constructor`
   * находился бы через цепочку прототипов у любого объекта — та же ошибка,
   * что уже была допущена в связывании объектов с эндпоинтами.
   */
  it("не находит унаследованные свойства через прототип", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [
      { name: "ctor", kind: "present", path: "constructor" },
      { name: "str", kind: "present", path: "toString" },
    ];

    const signals = await extractor.extract(streamOf('{"orders":[]}'), probes);

    expect(signals["ctor"]).toBe(false);
    expect(signals["str"]).toBe(false);
  });

  /**
   * Найдено ресерчем по аффилиатским кабинетам: видимость полей там задаётся
   * флагами на аккаунте, поэтому лишняя колонка не меняет статус ответа —
   * это BOPLA по конструкции. Проверять её нечем, пока путь не входит в список.
   *
   * Прежнее поведение было не просто пробелом: `present` отвечал `false` для
   * поля, которое в ответе ЕСТЬ, и такой сигнал неотличим от честного «нет».
   */
  it("видит поле внутри элемента списка по числовому индексу", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [
      { name: "emailCol", kind: "present", path: "rows.0.email" },
      { name: "phoneCol", kind: "present", path: "rows.0.phone" },
    ];

    const signals = await extractor.extract(
      streamOf('{"rows":[{"id":1,"email":"klient@example.com"}]}'),
      probes,
    );

    expect(signals["emailCol"]).toBe(true);
    expect(signals["phoneCol"]).toBe(false);
  });

  /**
   * Индексом считается только запись из десятичных цифр.
   *
   * Первая версия этого теста брала сегмент `email` и не проверяла ничего:
   * `Number("email")` — это `NaN`, обращение по `NaN` тоже даёт `undefined`,
   * и результат совпадал при снятой проверке. Мутация «индексировать любым
   * сегментом» её проходила. Разница видна только там, где строка численно
   * приводится: `Number("1e0")` — это 1, `Number(" 0 ")` — это 0.
   */
  it("не индексирует список сегментом, который лишь приводится к числу", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [
      { name: "sci", kind: "present", path: "rows.1e0.email" },
      { name: "padded", kind: "present", path: "rows. 0 .email" },
      { name: "hex", kind: "present", path: "rows.0x0.email" },
      { name: "word", kind: "present", path: "rows.email" },
    ];

    const signals = await extractor.extract(streamOf('{"rows":[{"email":"a@b.c"}]}'), probes);

    expect(signals["sci"]).toBe(false);
    expect(signals["padded"]).toBe(false);
    expect(signals["hex"]).toBe(false);
    expect(signals["word"]).toBe(false);
  });

  it("за границей списка сигнала нет, а не ложное присутствие", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [{ name: "x", kind: "present", path: "rows.7.email" }];

    const signals = await extractor.extract(streamOf('{"rows":[{"email":"a@b.c"}]}'), probes);

    expect(signals["x"]).toBe(false);
  });

  it("не выдаёт сигналы по путям, если тело не разбирается как JSON", async () => {
    const extractor = createSignalExtractor({ salt: SALT });

    const signals = await extractor.extract(streamOf("<html>сервер отдал страницу</html>"), specs);

    expect(signals["orders"]).toBeUndefined();
    expect(signals["hasNext"]).toBeUndefined();
  });
});

describe("потолок размера", () => {
  /**
   * Префикс не годится: два ответа, различающихся за границей отсечки,
   * дали бы одинаковый дайджест, и инструмент утверждал бы совпадение,
   * которого нет. Отсутствие сигнала лучше неверного.
   */
  it("не вычисляет ничего, если тело больше потолка", async () => {
    const extractor = createSignalExtractor({ salt: SALT, maxBodyBytes: 16 });

    const signals = await extractor.extract(streamOf("x".repeat(64)), DIGEST);

    expect(signals).toEqual({});
  });

  it("вычисляет, если тело ровно по потолку", async () => {
    const extractor = createSignalExtractor({ salt: SALT, maxBodyBytes: 16 });

    const signals = await extractor.extract(streamOf("x".repeat(16)), DIGEST);

    expect(typeof signals["digest"]).toBe("number");
  });

  it("отвергает неположительный потолок", () => {
    expect(() => createSignalExtractor({ maxBodyBytes: 0 })).toThrow(InvalidSignalSpecError);
  });
});

describe("HTTP-клиент и тела", () => {
  async function startServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ port: number; close(): Promise<void> }> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("не удалось поднять тестовый сервер");
    }
    return {
      port: address.port,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  function clientFor() {
    const clock = createTestClock();
    return createHttpClient({
      allowedHosts: ["127.0.0.1"],
      throttle: createThrottle({ concurrency: 2, requestsPerSecond: 1000, maxRequests: 50 }, clock),
      clock,
      signalExtractor: createSignalExtractor({ salt: SALT }),
    });
  }

  const SECRET = '{"orders":[{"email":"klient@example.com","card":"4111111111111111"}]}';

  /**
   * Несущий тест ADR-0011. Тело прочитано, сигнал вычислен — и при этом
   * ни одного байта содержимого в ответе порта нет. Помечать `skip` нельзя.
   */
  it("не проносит содержимое тела в HttpResponse даже когда читает его", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(SECRET);
    });

    try {
      const response = await clientFor().send({
        method: "GET",
        url: `http://127.0.0.1:${server.port}/orders`,
        headers: {},
        signals: [
          { name: "digest", kind: "digest" },
          { name: "orders", kind: "count", path: "orders" },
        ],
      });

      expect(response.signals?.["orders"]).toBe(1);
      expect(typeof response.signals?.["digest"]).toBe("number");

      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain("klient@example.com");
      expect(serialized).not.toContain("4111111111111111");
      expect(serialized).not.toContain('orders":[{');
      // Значения сигналов — только скаляры: строке, вмещающей тело, взяться неоткуда.
      for (const value of Object.values(response.signals ?? {})) {
        expect(["number", "boolean"]).toContain(typeof value);
      }
    } finally {
      await server.close();
    }
  });

  it("без объявленных сигналов тело не читается и сигналов нет", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(SECRET);
    });

    try {
      const response = await clientFor().send({
        method: "GET",
        url: `http://127.0.0.1:${server.port}/orders`,
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.signals).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain("klient@example.com");
    } finally {
      await server.close();
    }
  });
});
