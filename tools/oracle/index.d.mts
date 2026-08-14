/**
 * The types of the shared comparison module. The implementation — `index.mjs`.
 *
 * Written by hand rather than inferred: the module lies outside `tsconfig.include`,
 * because it is testing tooling, not part of the package. The types are there so
 * that the comparison can be covered by real tests in TypeScript.
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
   * The defects that explain this cell. There may be several: when one defect is a
   * special case of another, the shared cell is explained by both.
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
