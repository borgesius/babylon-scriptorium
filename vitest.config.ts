import { resolve } from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts", "src/**/*.spec.ts", "generations/1/output/__tests__/**/*.test.ts"],
        exclude: ["node_modules", "dist"],
        pool: "vmThreads",
    },
    resolve: {
        alias: {
            "@": resolve(__dirname, "src"),
        },
    },
})
