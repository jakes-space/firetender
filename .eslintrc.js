require("@rushstack/eslint-patch/modern-module-resolution");

module.exports = {
  root: true,
  env: {
    es2020: true,
    browser: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2020,
    project: "./tsconfig.json",
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:import/recommended",
    "prettier",
  ],
  plugins: [
    "@typescript-eslint",
    "prettier",
    "simple-import-sort",
  ],
  rules: {
    "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
    "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
    "@typescript-eslint/no-explicit-any": "off",
    "import/extensions": ["error", "never"],
    "no-use-before-define": ["error", { functions: false }],
    "lines-between-class-members": [
      "error",
      "always",
      { exceptAfterSingleLine: true },
    ],
    "no-empty-function": [
      "error",
      { allow: ["arrowFunctions", "constructors"] }
    ],
    "@typescript-eslint/no-empty-function": [
      "error",
      { allow: ["arrowFunctions", "constructors"] },
    ],
    "prefer-destructuring": ["error", { object: false, array: false }],
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { destructuredArrayIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-floating-promises": "error",
    "prettier/prettier": "warn",
    "simple-import-sort/imports": "error",
    "simple-import-sort/exports": "error",
  },
  overrides: [
    {
      files: [
        "**/__tests__/*.{j,t}s?(x)",
      ],
      env: {
        jest: true,
      },
    },
  ],
  ignorePatterns: [".eslintrc.js", "rollup.config.js"],
  settings: {
    "import/resolver": {
      "node": {
        "extensions": [".js", ".jsx", ".ts", ".tsx"]
      },
      typescript: {},
    },
  },
};
