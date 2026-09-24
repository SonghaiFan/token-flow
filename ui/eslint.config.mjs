import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/* Design-system guardrails for class strings. Colors, radii, and type sizes come
   from styles/tokens.css (see .agents/docs/standards/product-design-system.md). */
const PALETTE = "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
const CLASS_RULES = [
  [`(?:^|[\\s:])(?:bg|text|border|ring|outline|fill|stroke|divide|decoration|from|to|via|shadow)-${PALETTE}-\\d`, "Use a design-token color (ink, muted, line, success, warning, danger, …), not a Tailwind palette class."],
  ["(?:^|\\s)dark:", "Theme through tokens in styles/tokens.css; a dark: variant means a token is missing."],
  ["(?:^|[\\s:])rounded(?:-[a-z]+)?-\\[\\d", "Use a radius token: rounded-panel, rounded-control, rounded-inset, rounded-tag, or rounded-mark."],
  ["(?:^|[\\s:])text-\\[\\d+px\\]", "Use text-sm (body) or text-xs (metadata), or a tf-* type role."],
];
const classRestrictions = CLASS_RULES.flatMap(([pattern, message]) => [
  { selector: `Literal[value=/${pattern}/]`, message },
  { selector: `TemplateElement[value.raw=/${pattern}/]`, message },
]);

export default defineConfig([
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["components/**/*.tsx", "lib/**/*.tsx"],
    rules: { "no-restricted-syntax": ["error", ...classRestrictions] },
  },
  globalIgnores(["dist/**"]),
]);
