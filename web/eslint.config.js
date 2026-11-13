import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // src/tailfade and src/explain are byte-for-byte copies of intern/tailfade/src and intern/runner/src; they are checked there
  { ignores: ["dist", "node_modules", "src/tailfade", "src/explain"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
