import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        performance: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["web/public/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        google: "readonly",
      },
    },
  },
);
