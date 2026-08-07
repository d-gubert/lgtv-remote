import rocketChatConfig from "@rocket.chat/eslint-config";
import { defineConfig } from "eslint/config";

// This project targets Node's built-in test runner (`node:test`) rather than
// Jest/testing-library, so drop those framework-specific configs from the
// shared Rocket.Chat preset. Everything else (the JS/TS best-practice,
// stylistic, import and typescript-eslint rules) is what makes up the standard.
const isTestFrameworkConfig = (config) => {
	const plugins = Object.keys(config?.plugins ?? {});
	return plugins.includes("jest") || plugins.includes("testing-library");
};

export default defineConfig(
	{
		name: "lgtv-remote/ignored",
		ignores: ["dist", "node_modules", "coverage"],
	},
	...rocketChatConfig.filter((config) => !isTestFrameworkConfig(config)),
	{
		// This codebase is built on Effect. A few rules from the shared preset are
		// designed for a React/Jest codebase and clash with core Effect idioms;
		// relax exactly those, and nothing more.
		name: "lgtv-remote/effect-overrides",
		rules: {
			// Effect's combinators are capitalized functions called without `new`
			// (`Schema.Struct(...)`, `Data.TaggedError(...)`, `Context.GenericTag(...)`).
			"new-cap": "off",

			// Schema definitions use the value + companion-type pattern, declaring a
			// value and a type that intentionally share one name
			// (`const Volume = struct(...)` / `type Volume = Infer<typeof Volume>`).
			"@typescript-eslint/no-redeclare": "off",

			// Keep the preset's naming conventions, but drop the `I`-prefix
			// requirement for interfaces: several are part of the published SDK's
			// public API, so prefixing them would be a breaking change.
			"@typescript-eslint/naming-convention": [
				"error",
				{
					selector: "variableLike",
					format: ["camelCase"],
					leadingUnderscore: "allow",
				},
				{
					selector: ["variable"],
					format: ["camelCase", "UPPER_CASE", "PascalCase"],
					leadingUnderscore: "allowSingleOrDouble",
				},
				{
					selector: "function",
					format: ["camelCase", "PascalCase"],
					leadingUnderscore: "allowSingleOrDouble",
				},
				{
					selector: "parameter",
					format: ["camelCase"],
					modifiers: ["unused"],
					leadingUnderscore: "require",
				},
				{ selector: "interface", format: ["PascalCase"] },
			],
		},
	},
	{
		// `node:test`'s `describe`/`it`/`before`/… return promises the runner owns
		// and callers are not meant to await, so tell `no-floating-promises` those
		// specific calls are safe rather than turning the rule off for tests.
		name: "lgtv-remote/node-test",
		// Only the type-checked test helpers (`*.test.ts` files have type-aware
		// rules disabled by the preset, so this rule does not run on them).
		files: ["test/**/*.ts"],
		ignores: ["test/**/*.test.ts"],
		rules: {
			"@typescript-eslint/no-floating-promises": [
				"error",
				{
					allowForKnownSafeCalls: [
						{ from: "package", name: "describe", package: "node:test" },
						{ from: "package", name: "it", package: "node:test" },
						{ from: "package", name: "test", package: "node:test" },
						{ from: "package", name: "before", package: "node:test" },
						{ from: "package", name: "after", package: "node:test" },
						{ from: "package", name: "beforeEach", package: "node:test" },
						{ from: "package", name: "afterEach", package: "node:test" },
					],
				},
			],
		},
	},
);
