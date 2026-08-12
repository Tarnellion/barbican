/**
 * Тесты HTTP-клиента.
 *
 * Против настоящего локального сервера, без подмены fetch: проверяется то,
 * что реально ушло в сеть и что реально вернулось, а не то, как оформлен вызов.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  CircuitOpenError,
  createHttpClient,
  EmptyScopeError,
  HostNotAllowedError,
  parseRetryAfter,
  RequestFailedError,
  UnsafeMethodError,
  UnsupportedProtocolError,
} from "../../src/adapters/http.js";
import { createThrottle } from "../../src/adapters/throttle.js";
import { createTestClock } from "../fixtures/clock.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly port: number;
  readonly paths: readonly string[];
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? "");
    handler(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("не удалось поднять тестовый сервер");
  }
  return {
    port: address.port,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function clientFor(overrides: Record<string, unknown> = {}) {
  const clock = createTestClock();
  const client = createHttpClient({
    allowedHosts: ["127.0.0.1"],
    throttle: createThrottle({ concurrency: 4, requestsPerSecond: 1000, maxRequests: 100 }, clock),
    clock,
    random: () => 0.5,
    ...overrides,
  });
  return { client, clock };
}

const GET = (port: number, path = "/") =>
  ({ method: "GET", url: `http://127.0.0.1:${port}${path}`, headers: {} }) as const;

describe("область проверки", () => {
  it("отказывается работать без allowlist", () => {
    const throttle = createThrottle();

    expect(() => createHttpClient({ allowedHosts: [], throttle })).toThrow(EmptyScopeError);
    expect(() => createHttpClient({ allowedHosts: ["  "], throttle })).toThrow(EmptyScopeError);
  });

  it("не обращается к хосту вне области", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      const { client } = clientFor({ allowedHosts: ["example.test"] });

      await expect(client.send(GET(server.port))).rejects.toThrow(HostNotAllowedError);
      expect(server.paths).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("отвергает протоколы кроме http и https", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      const { client } = clientFor();

      await expect(
        client.send({ method: "GET", url: "file:///etc/passwd", headers: {} }),
      ).rejects.toThrow(UnsupportedProtocolError);
    } finally {
      await server.close();
    }
  });
});

describe("безопасные методы по умолчанию", () => {
  it("не отправляет изменяющий запрос без явного разрешения", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      const { client } = clientFor();

      await expect(
        client.send({ method: "DELETE", url: `http://127.0.0.1:${server.port}/`, headers: {} }),
      ).rejects.toThrow(UnsafeMethodError);

      // Ничего не ушло: запрет действует до отправки, а не после.
      expect(server.paths).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("пропускает изменяющий запрос при явном разрешении", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(204).end();
    });
    try {
      const { client } = clientFor({ allowUnsafeMethods: true });

      const response = await client.send({
        method: "DELETE",
        url: `http://127.0.0.1:${server.port}/x`,
        headers: {},
      });

      expect(response.status).toBe(204);
      expect(server.paths).toEqual(["/x"]);
    } finally {
      await server.close();
    }
  });
});

describe("тело ответа и чувствительные заголовки", () => {
  const CANARY = "pii-канарейка-3f9a2b";

  it("не возвращает тело ни в каком виде", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ email: CANARY, balance: 1000 }));
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(server.port));

      expect(Object.keys(response).sort()).toEqual(["headers", "status"]);
      expect(JSON.stringify(response)).not.toContain(CANARY);
    } finally {
      await server.close();
    }
  });

  it("редактирует set-cookie: там сессионный токен платформы", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "set-cookie": "session=super-secret-token; HttpOnly",
        "x-request-id": "abc-123",
      });
      response.end();
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(server.port));

      expect(response.headers["set-cookie"]).toBe("[REDACTED]");
      expect(JSON.stringify(response)).not.toContain("super-secret-token");
      // Несекретные заголовки сохраняются: они нужны для разбора прогона.
      expect(response.headers["x-request-id"]).toBe("abc-123");
    } finally {
      await server.close();
    }
  });
});

describe("редиректы", () => {
  it("не переходит по 3xx: это увело бы запрос за пределы allowlist", async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    const source = await startServer((_request, response) => {
      response.writeHead(302, { location: `http://localhost:${target.port}/secret` });
      response.end();
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(source.port));

      expect(response.status).toBe(302);
      // Хост localhost в allowlist не входит — и обращения к нему не было.
      expect(target.paths).toEqual([]);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe("повторы и backoff", () => {
  it("повторяет 429 и слушается Retry-After вместо своей формулы", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(429, { "retry-after": "7" }).end();
        return;
      }
      response.writeHead(200).end();
    });
    try {
      const { client, clock } = clientFor();

      const response = await client.send(GET(server.port));

      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      expect(clock.sleeps).toEqual([7000]);
    } finally {
      await server.close();
    }
  });

  it("наращивает паузу экспоненциально, когда сервер молчит о сроке", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503).end();
    });
    try {
      const { client, clock } = clientFor({
        retry: { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 30_000 },
        breaker: { consecutiveFailures: 99 },
      });

      const response = await client.send(GET(server.port));

      // Последняя попытка возвращает ответ как есть — выдумывать исход нельзя.
      expect(response.status).toBe(503);
      // Полный джиттер при random=0.5: 400*0.5, затем 800*0.5.
      expect(clock.sleeps).toEqual([200, 400]);
    } finally {
      await server.close();
    }
  });

  it("не повторяет успешный и не повторяет 403", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      response.writeHead(403).end();
    });
    try {
      const { client, clock } = clientFor();

      const response = await client.send(GET(server.port));

      expect(response.status).toBe(403);
      expect(calls).toBe(1);
      expect(clock.sleeps).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("сетевой сбой", () => {
  it("повторяет и сообщает об отказе, а не выдаёт результат", async () => {
    // Поднимаем и сразу гасим сервер, чтобы получить заведомо закрытый порт.
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    const closedPort = server.port;
    await server.close();

    const { client, clock } = clientFor({
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      breaker: { consecutiveFailures: 99 },
    });

    await expect(client.send(GET(closedPort))).rejects.toThrow(RequestFailedError);
    // Две паузы между тремя попытками.
    expect(clock.sleeps).toEqual([50, 100]);
  });
});

describe("circuit breaker", () => {
  it("останавливает прогон после серии неудач и больше не ходит в сеть", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(500).end();
    });
    try {
      const { client } = clientFor({
        retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10 },
        breaker: { consecutiveFailures: 3 },
      });

      await expect(client.send(GET(server.port))).rejects.toThrow(CircuitOpenError);
      const afterOpen = server.paths.length;

      // Следующее обращение обрывается до сети.
      await expect(client.send(GET(server.port, "/another"))).rejects.toThrow(CircuitOpenError);
      expect(server.paths.length).toBe(afterOpen);
    } finally {
      await server.close();
    }
  });

  it("сбрасывает счётчик после удачного ответа", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      response.writeHead(calls % 2 === 1 ? 500 : 200).end();
    });
    try {
      const { client } = clientFor({
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
        breaker: { consecutiveFailures: 3 },
      });

      for (let i = 0; i < 3; i += 1) {
        await expect(client.send(GET(server.port))).resolves.toMatchObject({ status: 200 });
      }
    } finally {
      await server.close();
    }
  });
});

describe("parseRetryAfter", () => {
  it("понимает секунды", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter(" 0 ", 0)).toBe(0);
    expect(parseRetryAfter("-5", 0)).toBe(0);
  });

  it("понимает HTTP-дату", () => {
    const now = Date.parse("2026-08-12T10:00:00Z");
    expect(parseRetryAfter("Wed, 12 Aug 2026 10:00:30 GMT", now)).toBe(30_000);
    // Дата в прошлом не даёт отрицательной паузы.
    expect(parseRetryAfter("Wed, 12 Aug 2026 09:00:00 GMT", now)).toBe(0);
  });

  it("возвращает undefined на мусоре и отсутствии заголовка", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("", 0)).toBeUndefined();
    expect(parseRetryAfter("скоро", 0)).toBeUndefined();
  });
});
