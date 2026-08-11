/**
 * Порты адаптеров: только интерфейсы, без реализаций.
 *
 * Ядро зависит от этих типов, но никогда от конкретных HTTP-клиентов и парсеров.
 * Замена клиента или парсера не должна трогать src/core.
 * Реализации появятся в сессии 3.
 */

import type { Endpoint, HttpMethod } from "../core/types.js";

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Ответ без тела.
 *
 * Это не упущение: тела не сохраняются по умолчанию, потому что содержат PII.
 * Порт не даёт возможности «случайно» их протащить.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpClient {
  send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

export interface SpecParser {
  /**
   * Разбирает спецификацию в список эндпоинтов.
   *
   * Реализация обязана отключить резолвинг внешних `$ref` — и по http, и по
   * файловой системе. Это защита от SSRF и path traversal, а не оптимизация.
   * Тест-доказательство этого поведения обязателен (см. tasks.md).
   */
  parse(source: string): Promise<readonly Endpoint[]>;
}

export interface Throttle {
  /** Пропускает задачу через лимиты конкурентности и частоты. */
  run<T>(task: () => Promise<T>): Promise<T>;
}
