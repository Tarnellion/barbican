/**
 * The types of the managed-block helpers. The implementation and the reasoning —
 * `managed-block.mjs`.
 *
 * Written by hand rather than inferred: the module lies outside
 * `tsconfig.include`, because it is testing tooling and not part of the package.
 * The types are here so that the helpers can be covered by real tests in
 * TypeScript.
 */

export declare class ManagedBlockError extends Error {
  constructor(message: string);
}

export declare function normalizeNewlines(text: string): string;
export declare function extractManagedBlock(text: string, begin: string, end: string): string;
export declare function managedBlockMatches(
  text: string,
  begin: string,
  end: string,
  block: string,
): boolean;
export declare function replaceManagedBlock(
  text: string,
  begin: string,
  end: string,
  block: string,
): string;
