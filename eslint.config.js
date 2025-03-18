import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import prettierRecommendedConfig from "eslint-plugin-prettier/recommended";
import simpleImportSortPlugin from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

const baseConfig = tseslint.config(
  eslint.configs.recommended,
  prettierRecommendedConfig,
  importPlugin.flatConfigs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
  },
  {
    plugins: {
      "simple-import-sort": simpleImportSortPlugin,
    },
    languageOptions: {
      ecmaVersion: 2020,
    },
    rules: {
      "import/no-extraneous-dependencies": ["error", { devDependencies: true }],
      "import/prefer-default-export": "off",
      "lines-between-class-members": [
        "error",
        "always",
        { exceptAfterSingleLine: true },
      ],
      "no-bitwise": "off",
      "no-cond-assign": ["warn", "except-parens"],
      "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-else-return": "off",
      "no-empty-function": [
        "error",
        { allow: ["arrowFunctions", "constructors"] },
      ],
      "no-lonely-if": "off",
      "no-nested-ternary": "off",
      "no-param-reassign": ["error", { props: false }],
      "no-unused-vars": "off",
      "no-use-before-define": ["error", { functions: false }],
      "prefer-destructuring": ["error", { object: false, array: false }],
      "prettier/prettier": "warn",
      "simple-import-sort/imports": "warn",
      "simple-import-sort/exports": "warn",
    },
  },
  {
    files: ["eslint.config.js"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "import/extensions": ["error", "ignorePackages"],
      "import/no-unresolved": "off",
    },
  },
);

const typescriptConfig = tseslint.config(
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      sourceType: "module",
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: "./tsconfig.json",
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        { allowExpressions: true, allowIIFEs: true },
      ],
      "@typescript-eslint/no-empty-function": [
        "error",
        { allow: ["arrowFunctions", "constructors"] },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreIIFE: true },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            arguments: false,
            variables: false,
            properties: false,
          },
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-shadow": [
        "warn",
        { ignoreOnInitialization: true },
      ],
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
);

export default tseslint.config(
  baseConfig,
  typescriptConfig.map((config) => ({ ...config, files: ["src/**/*.ts"] })),
);
