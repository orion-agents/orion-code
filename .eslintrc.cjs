module.exports = {
  root: true,
  extends: [
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/ban-types': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
    'prefer-const': 'warn',
    'no-console': 'off',
    // A parameterless `catch {}` discards the error object outright, which is
    // how persistence and auth failures used to become invisible (#9).
    // `no-empty` still allows a catch block containing a comment, so the rule
    // forces an explicit decision: log it, handle it, or justify ignoring it.
    'no-empty': ['error', { allowEmptyCatch: false }],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js'],
};
