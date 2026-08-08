module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  // Keep source inside Jest's search roots so collectCoverageFrom can instrument
  // files that no test imports. Limiting roots to tests silently dropped those
  // files from the coverage denominator.
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Keep coverage denominators honest: files that tests never import must still
  // appear in the report instead of being silently excluded.
  collectCoverageFrom: ['<rootDir>/src/**/*.{ts,tsx}'],
  // Enforce the project's documented 70% coverage guideline (AGENTS.md). Branch
  // coverage is the strictest metric and currently sits at ~70.4%, so 70 is the
  // real gate (previously nothing stopped it from sliding under). #42.
  coverageThreshold: {
    global: {
      branches: 70,
    },
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2020',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          jsx: 'react',
          types: ['jest', 'node'],
        },
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(chalk|supports-color|ansi-styles|has-flag|is-unicode-supported)/)',
  ],
};
