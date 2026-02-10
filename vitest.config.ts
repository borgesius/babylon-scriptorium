import { resolve } from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
        exclude: ["node_modules", "dist"],
        pool: "vmThreads",
    },
    resolve: {
        alias: {
            "@": resolve(__dirname, "src"),
        },
    },
})
