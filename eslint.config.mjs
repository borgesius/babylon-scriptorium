import eslint from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"
import eslintPluginSimpleImportSort from "eslint-plugin-simple-import-sort"
import eslintPluginUnusedImports from "eslint-plugin-unused-imports"
import typescriptEslint from "typescript-eslint"

export default typescriptEslint.config(
    {
        ignores: [
            "node_modules",
            "dist",
            "coverage",
            "generations",
            "*.config.js",
            "*.config.mjs",
            "*.config.ts",
        ],
    },
    eslint.configs.recommended,
    eslintConfigPrettier,
    ...typescriptEslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        rules: {
            "@typescript-eslint/consistent-type-imports": "error",
            "@typescript-eslint/consistent-type-exports": "error",
            "@typescript-eslint/explicit-function-return-type": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/explicit-member-accessibility": [
                "error",
                {
                    accessibility: "explicit",
                    overrides: {
                        constructors: "no-public",
                    },
                },
            ],
        },
    },
    eslintPluginPrettierRecommended,
    {
        plugins: {
            "simple-import-sort": eslintPluginSimpleImportSort,
        },
        rules: {
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",
        },
    },
    {
        plugins: {
            "unused-imports": eslintPluginUnusedImports,
        },
        rules: {
            "unused-imports/no-unused-imports": "error",
        },
    }
)
