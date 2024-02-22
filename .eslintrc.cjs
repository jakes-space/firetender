require("@rushstack/eslint-patch/modern-module-resolution");

module.exports = {
  root: true,
  env: {
    es2020: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2020,
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint", "prettier", "simple-import-sort"],
  rules: {
    "import/extensions": ["error", "never"],
    "import/prefer-default-export": "off",
    "lines-between-class-members": [
      "error",
      "always",
      { exceptAfterSingleLine: true },
    ],
    "no-bitwise": "off",
    "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
    "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
    "no-else-return": "off",
    "no-empty-function": [
      "error",
      { allow: ["arrowFunctions", "constructors"] },
    ],
    "no-lonely-if": "off",
    "no-param-reassign": ["error", { props: false }],
    "no-unused-vars": "off",
    "no-use-before-define": ["error", { functions: false }],
    "prefer-destructuring": ["error", { object: false, array: false }],
    "prettier/prettier": "warn",
    "simple-import-sort/imports": "error",
    "simple-import-sort/exports": "error",
    "@typescript-eslint/explicit-function-return-type": [
      "warn",
      { allowExpressions: true, allowIIFEs: true },
    ],
    "@typescript-eslint/no-empty-function": [
      "error",
      { allow: ["arrowFunctions", "constructors"] },
    ],
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-floating-promises": ["error", { ignoreIIFE: true }],
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { destructuredArrayIgnorePattern: "^_" },
    ],
  },
  overrides: [
    {
      files: ["**/__tests__/*.ts"],
      env: {
        jest: true,
      },
    },
    {
      files: ["*.js"],
      parserOptions: {
        project: null,
      },
      rules: {
        "@typescript-eslint/no-floating-promises": "off",
      },
    },
  ],
  settings: {
    "import/resolver": {
      node: {
        extensions: [".js", ".jsx", ".ts", ".tsx"],
      },
      typescript: {},
    },
  },
  ignorePatterns: [
    ".eslintrc.cjs",
    "jest.config.ts",
  ]
};
