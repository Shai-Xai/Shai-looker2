// ESLint flat config. Two worlds: the CommonJS Node server (server/, test/,
// scripts/) and the ESM + JSX React client (client/src/). The intent is a CI
// *bug* gate, not a style police: genuine-correctness rules are errors
// (no-undef catches typo'd variables, no-dupe-keys, no-unreachable, …), while
// hygiene (unused vars, empty blocks, exhaustive-deps) is a warning so the gate
// stays green and signal stays high. Tighten over time.

const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

const hygiene = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      'client/dist/**',
      'client/node_modules/**',
      'server/data/**',
      '**/*.min.js',
    ],
  },

  // ── Server / tests / scripts — CommonJS, Node ────────────────────────────────
  {
    files: ['server/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...hygiene },
  },

  // ── Client app — ESM + JSX, browser ─────────────────────────────────────────
  {
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...hygiene,
      'react/react-in-jsx-scope': 'off', // new JSX transform (vite) — no React import needed
      'react/prop-types': 'off',         // this codebase doesn't use prop-types
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX-used components/PascalCase imports read as "unused" to base rule.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^[_A-Z]' }],
    },
  },

  // ── Client build config — ESM, Node ──────────────────────────────────────────
  {
    files: ['client/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, ...hygiene },
  },
];
