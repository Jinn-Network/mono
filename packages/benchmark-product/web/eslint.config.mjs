// DEVIATION from the create-next-app "FlatCompat.extends('next/core-web-vitals',
// 'next/typescript')" shape: as of eslint-config-next@16.3.0, `eslint-config-next`
// ships pure flat-config arrays (its plugin values are live plugin object
// references, not shareable-config name strings). Feeding that through
// `@eslint/eslintrc`'s `FlatCompat.extends()` — which expects a legacy eslintrc
// shape — throws `TypeError: Converting circular structure to JSON` while it
// tries to validate/serialize the plugin objects. The fix is to import the flat
// configs directly, which is what the package's `exports` map (`./core-web-vitals`,
// `./typescript`) is for. `@eslint/eslintrc` stays an unused devDependency per the
// pinned package.json; nothing else here changed.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
