module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@nktkas/hyperliquid/utils$': '<rootDir>/test/mocks/hyperliquid-utils.ts',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
};
