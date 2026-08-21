/**
 * One rule for ordering the strings this tool sorts.
 *
 * Not exported from `src/core/index.ts`, and so not part of the package's public
 * surface: it is how this tool arranges its own output, not something a consumer
 * is promised. It lives in its own module all the same, because the alternative
 * is the shape ADR-0024 was written against — the same comparison decided
 * separately in four files, which is how the four came to disagree.
 */

/**
 * Compares by UTF-16 code units — the same order the default `.sort()` gives.
 *
 * ## What was wrong
 *
 * Ten calls to `localeCompare()` with no locale argument decided the order of
 * the finding rows, the defect groups, the pairs a check compares and the
 * suggestions a configuration error lists; an eleventh decided the order of the
 * entries `configDigest` is hashed from. `localeCompare()` with no argument uses
 * the locale the process started in, which is the machine's `LC_ALL` or `LANG`.
 * The audit of 21 August 2026 (L-2) ran the same matrix twice: `LC_ALL=sv_SE`
 * gave a different row order and a different `configDigest` than `en_US`.
 *
 * Two of those consequences are not cosmetic. `docs/report.md` offers
 * `configDigest` as the way to tell "the platform changed" from "we changed the
 * declaration"; a digest that moves with the machine answers that question
 * wrong. And `MAX_ROWS_PER_DEFECT` cuts the evidence rows **after** the sort, so
 * two machines walking one matrix do not merely order the same rows differently
 * — they keep different rows.
 *
 * ## Why code units and not an explicit locale
 *
 * `localeCompare(other, "en-US")` would also be reproducible, and it is the
 * wrong half of the fix here. `canonical()` in `src/report/build.ts` is the
 * reason: its `Map` branch sorted through `localeCompare`, while its `Set`
 * branch and its object-key branch went through the default `.sort()` — one
 * function answering by two rules, with the digest built on top of it. The
 * default `.sort()` compares the string conversions with `<` and `>` and cannot
 * be given a locale, so pinning a locale means rewriting every plain `.sort()`
 * in the project into a comparator call and keeping the next one from being
 * written plainly. Code units go the other way: this function *is* what the
 * default already does, so a bare `.sort()` written tomorrow agrees with it by
 * construction rather than by vigilance.
 *
 * The second reason is that a locale is not as fixed as it looks. Collation
 * comes from the ICU data compiled into the Node build — `small-icu` and
 * `full-icu` do not carry the same tables, and the tables change between ICU
 * versions. Code-unit order is a property of the string itself and of nothing
 * else.
 *
 * What is given up is typographic correctness for a reader: `Ä` lands after `Z`,
 * and `Z` before `a`. That is the right thing to give up. The strings sorted
 * here are `id`s out of a run configuration — ASCII in the overwhelming majority
 * — and what the report needs from their order is that two machines produce one
 * file, not that a Swedish reader recognises the alphabet.
 */
export function byCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
