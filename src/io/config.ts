/**
 * Parsing and validation of the run configuration.
 *
 * The format and the reasoning behind it — ADR-0008. The key point: **no
 * credentials are kept in the file**. An account names the environment variable,
 * not the token, so the configuration can be committed and reviewed — which is
 * what the declaration was introduced for.
 *
 * The module is a directory now (ADR-0055), and this file is the door: every
 * import in the repository and every consumer of the library names
 * `src/io/config.js`, and none of them had to change.
 *
 * The re-exports are written out one by one rather than with `export *`, and
 * that is the point of the file. `src/index.ts` re-exports this module in full,
 * so whatever leaves here is a promise the package makes: `configSchema` once
 * left by accident and put 100 lines of `z.ZodObject<…>` into `config.d.ts`,
 * naming zod's internal namespace (the audit of 14 August 2026, E-6). The
 * modules behind this file export more than this — a shape one of them hands to
 * another — and a star would publish all of it. A list is the only spelling that
 * says which names are the contract; `tests/public-surface.test.ts` and the two
 * counts in `docs/library.md` are what keep the list honest.
 */

export {
  assertAttributesKeepTheBasis,
  assertContextsCannotWrite,
  ForbiddenContextHeaderError,
  ForbiddenContextQueryError,
  ForbiddenResourceQueryError,
  MethodOverrideInContextError,
} from "./config/basis.js";
export {
  DuplicateContextIdError,
  toAccounts,
  UnknownContextAccountError,
  UnknownContextReferenceError,
  UnusedContextError,
} from "./config/contexts.js";
export {
  InvalidContextValueError,
  InvalidCredentialError,
  MissingContextValueError,
  MissingCredentialError,
  resolveContextValues,
  resolveTokens,
  SharedCredentialError,
} from "./config/environment.js";
export {
  AuthSchemeWithoutTokenError,
  CompareSubtreeWithoutComparisonError,
  CredentialsInUrlError,
  DuplicateAcceptanceError,
  DuplicateAccountIdError,
  DuplicateCompareSubtreeError,
  DuplicateResourceIdError,
  HostOutsideScopeError,
  parseRunConfig,
  ReservedSignalNameError,
  UnacceptableFindingKindError,
  UnknownAcceptanceContextError,
  UnknownAuthSchemeError,
  UnknownResourceOwnerError,
  UnknownTenantError,
  UnusablePathParameterError,
  UnusedAuthSchemeError,
} from "./config/parse.js";
export {
  applyBodySignals,
  assertReferencesResolve,
  DuplicateSignalNameError,
  UnknownEndpointReferenceError,
  UnknownRoleReferenceError,
  UnusedResourceError,
} from "./config/references.js";
export {
  CONFIG_SCHEMA_ID,
  ConfigParseError,
  ConfigTooDeepError,
  ConfigTooLargeError,
  ConfigValidationError,
  configJsonSchema,
  UncarriableKeyError,
} from "./config/schema.js";
export type {
  AccountConfig,
  BodySignalsConfig,
  CompareSubtree,
  ContextAttributeValue,
  ContextValues,
  DeclaredSignal,
  RequestContextConfig,
  RunConfig,
  RunTarget,
  TenantConfig,
} from "./config/types.js";
