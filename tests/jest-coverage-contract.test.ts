const jestConfig = require('../jest.config.js') as {
  roots?: string[];
  collectCoverageFrom?: string[];
};

describe('Jest coverage denominator contract', () => {
  it('keeps source files inside Jest roots and the coverage include set', () => {
    expect(jestConfig.roots).toEqual(expect.arrayContaining(['<rootDir>/tests', '<rootDir>/src']));
    expect(jestConfig.collectCoverageFrom).toContain('<rootDir>/src/**/*.{ts,tsx}');
  });
});
