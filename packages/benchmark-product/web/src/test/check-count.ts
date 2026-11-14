// One pattern for the wrong-denominator guard (issues #3311, #3817): copy must not state a check
// count, because the verifier's closure size differs by bundle format. Spelled numerals cover
// `one` through `twenty`, so the next format's count (the /8 closure is eight) is caught too.
const SPELLED_NUMERALS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";

export const CHECK_COUNT_PATTERN = new RegExp(
  `\\b(?:${SPELLED_NUMERALS}|[0-9]+)[\\s-]+(?:bundle\\s+)?checks?\\b`,
  "iu",
);
