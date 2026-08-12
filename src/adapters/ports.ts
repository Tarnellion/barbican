/**
 * Порты адаптеров: только интерфейсы, без реализаций.
 *
 * Ядро зависит от этих типов, но никогда от конкретных HTTP-клиентов и парсеров.
 * Замена клиента или парсера не должна трогать src/core.
 * Реализации появятся в сессии 3.
 */

import type { Endpoint, HttpMethod, SignalSpec, SignalValue } from "../core/types.js";

export type { SignalSpec, SignalValue };

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Сигналы, ради которых тело будет прочитано. Пусто или отсутствует —
   * поток отменяется непрочитанным, как было до ADR-0011.
   */
  readonly signals?: readonly SignalSpec[];
}

/**
 * Ответ без тела.
 *
 * Это не упущение: тела не сохраняются, потому что содержат PII. Порт не даёт
 * возможности «случайно» их протащить — поля для тела просто нет, а `signals`
 * по типу вмещает только скаляры.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly signals?: Readonly<Record<string, SignalValue>>;
}

export interface HttpClient {
  send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

export interface SpecParser {
  /**
   * Разбирает спецификацию в список эндпоинтов.
   *
   * `source` — **текст документа**, а не путь к файлу. Чтение файла остаётся
   * за `src/io`: парсер, которому нечего открывать, не может стать примитивом
   * для path traversal.
   *
   * Реализация обязана отключить резолвинг внешних `$ref` — и по http, и по
   * файловой системе. Это защита от SSRF и path traversal, а не оптимизация.
   * Тест-доказательство этого поведения обязателен.
   */
  parse(source: string): Promise<readonly Endpoint[]>;
}

/**
 * Как аккаунт представляется проверяемой системе.
 *
 * Порт, а не константа в коде: реальные платформы расходятся здесь
 * категорически — JWT в `Authorization`, ключ в своём заголовке, сессия
 * в куке, Basic. Привязка к одной схеме делала инструмент неприменимым
 * к большинству API.
 */
export interface CredentialProvider {
  /**
   * Заголовки для обращения от имени аккаунта.
   *
   * Пустой набор — обращение без учётных данных, то есть анонимное.
   */
  headersFor(accountId: string): Readonly<Record<string, string>>;
}

export interface Throttle {
  /** Пропускает задачу через лимиты конкурентности и частоты. */
  run<T>(task: () => Promise<T>): Promise<T>;
}
