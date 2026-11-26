import js from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { plugins: ["@babel/plugin-syntax-typescript"] },
      },
      globals: globals.node,
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  eslintConfigPrettier,
];
