/**
 * Типы общего модуля сверки. Реализация — `index.mjs`.
 *
 * Написаны вручную, а не выведены: модуль лежит вне `tsconfig.include`,
 * потому что это оснастка проверки, а не часть пакета. Типы нужны затем,
 * чтобы сверку можно было покрыть настоящими тестами на TypeScript.
 */

export type Visibility =
  | "status"
  | "body-signal"
  | "body-only"
  | "unsafe-method"
  | "excluded"
  | "out-of-scope";

export declare const VISIBILITIES: readonly Visibility[];
export declare const DETECTABLE: readonly Visibility[];

export declare class GroundTruthError extends Error {
  constructor(message: string);
}

export interface DefectDeclaration {
  readonly title?: string;
  readonly visibility: Visibility;
  readonly note?: string;
}

export interface OracleFinding {
  readonly account: string;
  readonly endpoint: string;
  readonly resource?: string | null;
  readonly other?: string | null;
  readonly kind: string;
  /**
   * Дефекты, которыми объясняется эта ячейка. Их может быть несколько: если
   * один дефект — частный случай другого, общая ячейка объясняется обоими.
   */
  readonly defects: readonly string[];
}

export interface Variant {
  readonly id: string;
  readonly selector: Readonly<Record<string, unknown>>;
  readonly expectedExitCode: number;
  readonly findings: readonly OracleFinding[];
}

export interface GroundTruth {
  readonly note?: string;
  readonly cellKey?: string;
  readonly target?: string;
  readonly defects: Readonly<Record<string, DefectDeclaration>>;
  readonly variants: readonly Variant[];
}

export interface Comparison {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly problems: readonly string[];
}

export declare function loadGroundTruth(source: string): GroundTruth;
export declare function checkCoverage(groundTruth: GroundTruth): readonly string[];
export declare function cellKey(finding: Readonly<Record<string, unknown>>): string;
export declare function compareVariant(
  variant: Variant,
  report: Readonly<Record<string, unknown>>,
  exitCode: number,
): Comparison;
