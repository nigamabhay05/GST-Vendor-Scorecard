import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/*
 * Privacy is this project's defining architectural constraint.
 * The app makes two promises to the user in its own interface:
 *
 *   1. "Nothing is uploaded"  -> no network egress of any kind at runtime.
 *   2. Client tax data is never persisted by the browser; the only persistence
 *      is an explicit "Save project" download the user initiates.
 *
 * A promise enforced only by good intentions is one that breaks during a late-night
 * refactor. The rules below turn both promises into build failures: package.json runs
 * `eslint .` as the first step of `npm run build`, so a `fetch` or a
 * `localStorage.setItem` cannot reach a production bundle.
 */

const NO_NETWORK =
  'Zero network requests at runtime: this app promises the user "Nothing is uploaded". ' +
  'All processing happens in the browser.';

const NO_STORAGE =
  'Client tax data must never be persisted by the browser. Persistence is an explicit ' +
  '"Save project" file download only (see engine/export/projectFile.ts).';

const RESTRICTED_GLOBALS = [
  { name: 'fetch', message: NO_NETWORK },
  { name: 'XMLHttpRequest', message: NO_NETWORK },
  { name: 'WebSocket', message: NO_NETWORK },
  { name: 'EventSource', message: NO_NETWORK },
  { name: 'importScripts', message: NO_NETWORK },
  { name: 'localStorage', message: NO_STORAGE },
  { name: 'sessionStorage', message: NO_STORAGE },
  { name: 'indexedDB', message: NO_STORAGE },
];

/*
 * ESLint *replaces* a rule's options when a later config block sets the same rule
 * rather than merging them. The engine and UI blocks below both need their own
 * `no-restricted-imports` entries, so these paths are spread into every one of them --
 * otherwise adding a layering rule would silently delete the network ban for that
 * directory, which is exactly the kind of quiet regression this file exists to prevent.
 */
const RESTRICTED_IMPORT_PATHS = [
  { name: 'axios', message: NO_NETWORK },
  { name: 'ky', message: NO_NETWORK },
  { name: 'got', message: NO_NETWORK },
  { name: 'superagent', message: NO_NETWORK },
  { name: 'node-fetch', message: NO_NETWORK },
  { name: 'undici', message: NO_NETWORK },
];

const networkAndStorageBans = {
  'no-restricted-globals': ['error', ...RESTRICTED_GLOBALS],

  // Catches the qualified forms that the global ban above cannot see.
  'no-restricted-properties': [
    'error',
    { object: 'navigator', property: 'sendBeacon', message: NO_NETWORK },
    { object: 'window', property: 'fetch', message: NO_NETWORK },
    { object: 'window', property: 'localStorage', message: NO_STORAGE },
    { object: 'window', property: 'sessionStorage', message: NO_STORAGE },
    { object: 'window', property: 'indexedDB', message: NO_STORAGE },
    { object: 'globalThis', property: 'fetch', message: NO_NETWORK },
    { object: 'self', property: 'fetch', message: NO_NETWORK },
  ],

  'no-restricted-imports': ['error', { paths: RESTRICTED_IMPORT_PATHS }],

  'no-restricted-syntax': [
    'error',
    // A remote module specifier, static or dynamic.
    {
      selector: 'ImportDeclaration[source.value=/^(https?:)?\\u002F\\u002F/]',
      message: NO_NETWORK,
    },
    {
      selector: 'ImportExpression > Literal[value=/^(https?:)?\\u002F\\u002F/]',
      message: NO_NETWORK,
    },
    // A dynamic import whose target cannot be read at build time could be anything.
    {
      selector: 'ImportExpression > :not(Literal)',
      message:
        'Dynamic import targets must be static string literals so the no-network rule can ' +
        'verify them. ' + NO_NETWORK,
    },
    // Constructor forms, in case the identifier was shadowed past the global ban.
    {
      selector:
        'NewExpression[callee.name=/^(WebSocket|EventSource|XMLHttpRequest|BroadcastChannel)$/]',
      message: NO_NETWORK,
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'src/fixtures/sample'] },

  // ---------------------------------------------------------------- base
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...networkAndStorageBans,

      // "No silently swallowed exceptions". These need type information, which is why
      // this config is type-checked rather than syntax-only.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ------------------------------------------------------- engine layering
  /*
   * The engine is "the backend": pure TypeScript, no React, no DOM, runnable from a
   * Node script with no browser. That is an architectural claim, so it is enforced
   * rather than documented. Without this block the engine grows a `document`
   * reference one day and silently stops being testable in Node.
   */
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...RESTRICTED_IMPORT_PATHS,
            { name: 'react', message: 'The engine is pure TypeScript. No React inside src/engine.' },
            {
              name: 'react-dom',
              message: 'The engine is pure TypeScript. No React inside src/engine.',
            },
            { name: 'recharts', message: 'The engine returns data; charting belongs to the UI.' },
          ],
          patterns: [
            {
              group: ['**/ui/**'],
              message: 'The engine must not depend on the UI. Data flows engine -> UI, never back.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...RESTRICTED_GLOBALS,
        {
          name: 'document',
          message: 'The engine must run in Node with no DOM (see scripts/verify-fixture.ts).',
        },
        {
          name: 'window',
          message: 'The engine must run in Node with no DOM (see scripts/verify-fixture.ts).',
        },
        {
          name: 'alert',
          message: 'The engine reports through its return value, never through the DOM.',
        },
      ],
    },
  },

  // ----------------------------------------------------------- ui layering
  /*
   * "The UI must never compute a business number. It only renders what AnalysisResult
   * contains." The UI may import domain types, the tunable config (to render threshold
   * labels), the pure export builders and the worker hook -- but not the modules that
   * decide anything.
   */
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/main.tsx'],
    // v7 keeps the eslintrc-shaped configs at the top level; the flat-config
    // equivalents live under `.flat`.
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: RESTRICTED_IMPORT_PATHS,
          patterns: [
            {
              group: [
                '**/engine/match/*',
                '**/engine/analyse/*',
                '**/engine/parse/*',
                '**/engine/validate/*',
                '**/engine/normalize/*',
              ],
              message:
                'The UI renders numbers, it never computes them. Read them off AnalysisResult ' +
                '(via useEngine); if the number you need is missing, add it to the engine.',
            },
          ],
        },
      ],
    },
  },

  // ------------------------------------------------- tests, scripts, config
  {
    files: [
      'src/**/*.test.ts',
      'scripts/**/*.ts',
      'src/fixtures/**/*.ts',
      '*.config.{ts,js}',
      'eslint.config.js',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      // Fixture generation and the headless verification script are command-line tools;
      // printing is their entire purpose.
      'no-console': 'off',
    },
  },
);
