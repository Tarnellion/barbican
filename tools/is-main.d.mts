/**
 * The type of the entry-point check. The implementation and the reasoning —
 * `is-main.mjs`.
 *
 * Written by hand rather than inferred: the module lies outside
 * `tsconfig.include`, because it is testing tooling and not part of the package.
 * The type is here so that the check can be covered by a real test in TypeScript.
 */

export declare function isMainModule(moduleUrl: string): boolean;
