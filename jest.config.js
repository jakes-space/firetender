/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: ".",
  testRegex: "(\\.|/)(test|spec)\\.[jt]sx?$",
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  collectCoverageFrom: ["./src/**"],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/",
    "/src/index.ts",
  ],
};