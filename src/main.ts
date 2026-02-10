#!/usr/bin/env node

import { mkdir, readdir } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { Command } from "commander"

const readdirAsync = promisify(readdir)
const mkdirAsync = promisify(mkdir)

import { ConfigError } from "./core/errors.js"
import { formatCost } from "./core/Pricing.js"
import { BabylonScriptorium } from "./index.js"
import type { BabylonConfig } from "./types.js"

const GENERATIONS_DIR = "generations"
const GENERATION_PATTERN = /^(\d+)-(.+)$/

function sanitizeGenerationName(name: string): string {
    return name.replace(/[/\\]/g, "-").trim() || "run"
}

async function prepareGenerationDir(
    projectRoot: string,
    name: string
): Promise<{ outputDir: string; runLogPath: string }> {
    const generationsPath = join(projectRoot, GENERATIONS_DIR)
    let nextNum = 1
    try {
        const entries = await readdirAsync(generationsPath, {
            withFileTypes: true,
        })
        for (const e of entries) {
            if (!e.isDirectory()) continue
            const m = e.name.match(GENERATION_PATTERN)
            if (m) {
                const n = parseInt(m[1], 10)
                if (n >= nextNum) nextNum = n + 1
            }
        }
    } catch {
        /* generations/ may not exist yet */
    }
    const safeName = sanitizeGenerationName(name)
    const padded = String(nextNum).padStart(2, "0")
    const genDir = join(generationsPath, `${padded}-${safeName}`)
    const outputDir = join(genDir, "output")
    await mkdirAsync(outputDir, { recursive: true })
    return {
        outputDir,
        runLogPath: join(genDir, "run.txt"),
    }
}

async function loadEnvFile(cwd: string): Promise<void> {
    try {
        const content = await readFile(join(cwd, ".env"), "utf-8")
        for (const line of content.split("\n")) {
            const trimmed = line.replace(/^export\s+/, "").trim()
            if (!trimmed || trimmed.startsWith("#")) continue
            const eqIndex = trimmed.indexOf("=")
            if (eqIndex === -1) continue
            const key = trimmed.slice(0, eqIndex)
            const value = trimmed.slice(eqIndex + 1)
            process.env[key] = value
        }
    } catch {
        /* no .env file, that's fine */
    }
}

const program = new Command()

program
    .name("babylon")
    .description("babylon-scriptorium  a garden of forking agents")
    .version("1.0.0")

program
    .command("run")
    .description("Run a task through the Babylon Scriptorium agent cycle")
    .argument("<description>", "Task description")
    .option(
        "--provider <provider>",
        "Default LLM provider (openai or anthropic)"
    )
    .option("--model <model>", "Default model name")
    .option(
        "--renderer <type>",
        "Output renderer (terminal, log, none)",
        "terminal"
    )
    .option("--budget <dollars>", "Maximum spend in dollars", parseFloat)
    .option(
        "--max-depth <depth>",
        "Maximum recursion depth for task decomposition",
        parseInt
    )
    .option("--no-cli", "Disable invoke_cursor_cli tool")
    .option("--cwd <path>", "Working directory (defaults to current directory)")
    .option("--verbose", "Show blow-by-blow process (turns and tools) per step")
    .option(
        "--reviewer-model <model>",
        "Model for the Reviewer (e.g. gpt-4o-mini for cheaper runs)"
    )
    .option(
        "--economy",
        "Use economy defaults: gpt-4o-mini for Reviewer (faster/cheaper, less independent review)"
    )
    .option(
        "--complexity-threshold <0-1>",
        "Complexity below which to skip Planner (default 0.35, e.g. 0.4 for more simple-path tasks)",
        parseFloat
    )
    .option(
        "--max-context-turns <n>",
        "Trim conversation to last N turns before each LLM call (reduces tokens in long runs)",
        parseInt
    )
    .option(
        "--name <name>",
        "Create generations/(number)-(name)/output as working dir and save run log to run.txt"
    )
    .action(
        async (
            description: string,
            options: {
                provider?: string
                model?: string
                renderer?: string
                budget?: number
                maxDepth?: number
                cli?: boolean
                cwd?: string
                verbose?: boolean
                reviewerModel?: string
                economy?: boolean
                complexityThreshold?: number
                maxContextTurns?: number
                name?: string
            }
        ) => {
            const projectRoot = options.cwd
                ? resolve(options.cwd)
                : process.cwd()

            let workingDirectory = projectRoot
            let runLogPath: string | undefined

            if (options.name) {
                const { outputDir, runLogPath: path } =
                    await prepareGenerationDir(projectRoot, options.name)
                workingDirectory = outputDir
                runLogPath = path
            }

            await loadEnvFile(projectRoot)
            const rcConfig = await loadRcConfig(projectRoot)

            const config: BabylonConfig = {
                openaiApiKey:
                    process.env.OPENAI_API_KEY ?? rcConfig.openaiApiKey,
                anthropicApiKey:
                    process.env.ANTHROPIC_API_KEY ?? rcConfig.anthropicApiKey,
                workingDirectory,
                defaultProvider:
                    (options.provider as BabylonConfig["defaultProvider"]) ??
                    rcConfig.defaultProvider,
                defaultModel: options.model ?? rcConfig.defaultModel,
                renderer:
                    (options.renderer as BabylonConfig["renderer"]) ??
                    rcConfig.renderer ??
                    "terminal",
                maxDepth: options.maxDepth ?? rcConfig.maxDepth,
                maxRetries: rcConfig.maxRetries,
                maxCompositeCycles: rcConfig.maxCompositeCycles,
                budgetDollars: options.budget ?? rcConfig.budgetDollars,
                useCli: options.cli ?? rcConfig.useCli ?? true,
                verbose:
                    options.verbose ??
                    (runLogPath ? true : (rcConfig.verbose ?? false)),
                runLogPath: runLogPath ?? rcConfig.runLogPath,
                reviewerModel: options.reviewerModel ?? rcConfig.reviewerModel,
                economyMode: options.economy ?? rcConfig.economyMode ?? false,
                complexityDirectThreshold:
                    options.complexityThreshold ??
                    rcConfig.complexityDirectThreshold,
                maxContextTurns:
                    options.maxContextTurns ?? rcConfig.maxContextTurns,
            }
            if (config.economyMode && !config.reviewerModel) {
                config.reviewerModel = "gpt-4o-mini"
            }

            if (!config.openaiApiKey && !config.anthropicApiKey) {
                throw new ConfigError(
                    "No API keys found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variables, add them to .env, or configure .babylonrc.json"
                )
            }

            const keyHint = (k: string | undefined): string =>
                k ? `sk-...${k.slice(-4)}` : ""
            console.error(
                "[babylon] provider: %s | model: %s | openai: %s | anthropic: %s",
                config.defaultProvider ?? "per-role default",
                config.defaultModel ?? "per-role default",
                keyHint(config.openaiApiKey),
                keyHint(config.anthropicApiKey)
            )

            const scriptorium = new BabylonScriptorium(config)

            process.on("SIGINT", () => {
                scriptorium.abort()
            })

            const effectiveDescription =
                runLogPath != null
                    ? `Working directory for this run: ${workingDirectory}\nAll file paths and shell commands are relative to this directory. This is your project root.\n\nTask: ${description}`
                    : description

            try {
                const result = await scriptorium.run(effectiveDescription)

                if (config.renderer === "none") {
                    console.log(JSON.stringify(result, null, 2))
                } else if (config.renderer === "log") {
                    console.log(`\nStatus: ${result.status}`)
                    console.log(
                        `Duration: ${(result.duration / 1000).toFixed(1)}s`
                    )
                    console.log(
                        `Cost: ${formatCost(result.costSummary.totalCost.totalCost)}`
                    )
                }

                if (
                    result.status !== "completed" &&
                    result.artifacts.length > 0
                ) {
                    const last = result.artifacts[result.artifacts.length - 1]
                    if (last?.content) {
                        console.error(`\nReason: ${last.content}`)
                    }
                }

                process.exit(result.status === "completed" ? 0 : 1)
            } catch (error) {
                console.error(
                    "Fatal error:",
                    error instanceof Error ? error.message : String(error)
                )
                process.exit(1)
            }
        }
    )

async function loadRcConfig(cwd: string): Promise<Partial<BabylonConfig>> {
    try {
        const rcPath = join(cwd, ".babylonrc.json")
        const content = await readFile(rcPath, "utf-8")
        try {
            return JSON.parse(content) as Partial<BabylonConfig>
        } catch (parseError) {
            throw new ConfigError(
                `Invalid JSON in ${rcPath}: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
        }
    } catch (err) {
        if (err instanceof ConfigError) throw err
        return {}
    }
}

program.parseAsync().catch((error: unknown) => {
    console.error(
        "Fatal error:",
        error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
})
