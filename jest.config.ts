import type { JestConfigWithTsJest } from 'ts-jest'

const config: JestConfigWithTsJest = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "\\.spec\\.ts$",
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  collectCoverageFrom: ["./src/**"],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/",
    "/src/firestore-deps-admin.ts",
    "/src/firestore-deps-web.ts",
    "/src/index.ts",
    "/src/ts-helpers.ts",
  ],
  globalSetup: "./src/__tests__/firestore-emulator.ts",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testTimeout: 20000,
};

export default config;
