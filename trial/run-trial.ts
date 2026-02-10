/**
 * Ad-hoc evaluation runner: runs a set of trial tasks and records results.
 * Not a built-in product feature — for temporary use only.
 *
 * Usage: from repo root, after `npm run build`:
 *   npx tsx trial/run-trial.ts
 * Generation dirs and results go under TRIALS_DIR (default ./trials-output in repo).
 */

import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const PROJECT_ROOT = process.cwd()
const TRIALS_ROOT = resolve(
    process.env.TRIALS_DIR ?? join(process.cwd(), "trials-output")
)
const TASKS_PATH = join(PROJECT_ROOT, "trial", "trial-tasks.json")
const CLI_PATH = join(PROJECT_ROOT, "dist", "main.js")
const RESULTS_PATH = join(TRIALS_ROOT, "trial-results.json")

async function loadEnvFromRepo(): Promise<void> {
    try {
        const content = await readFile(join(PROJECT_ROOT, ".env"), "utf-8")
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
        /* no .env in repo, that's fine */
    }
}

interface TrialTask {
    id: string
    tier: "simple" | "medium" | "complex"
    description: string
}

interface TrialRunRecord {
    id: string
    tier: string
    description: string
    status: string
    exitCode: number
    reason?: string
    duration?: number
    cost?: number
    parseError?: boolean
    rawStdoutTail?: string
    stderrTail?: string
}

interface TrialResults {
    summary: {
        total: number
        completed: number
        failed: number
        byTier: Record<string, { total: number; completed: number }>
    }
    runs: TrialRunRecord[]
}

async function loadTasks(): Promise<TrialTask[]> {
    const raw = await readFile(TASKS_PATH, "utf-8")
    const tasks = JSON.parse(raw) as TrialTask[]
    if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error("trial-tasks.json must be a non-empty array")
    }
    return tasks
}

interface ParsedResult {
    status?: string
    artifacts?: Array<{ content?: string }>
    duration?: number
    costSummary?: { totalCost?: { totalCost?: number } }
}

function extractFields(result: ParsedResult): {
    status?: string
    reason?: string
    duration?: number
    cost?: number
} {
    const status = result.status
    const reason =
        status !== "completed" &&
        result.artifacts &&
        result.artifacts.length > 0
            ? result.artifacts[result.artifacts.length - 1]?.content
            : undefined
    const duration = result.duration
    const cost =
        result.costSummary?.totalCost?.totalCost ??
        (result.costSummary as { totalCost?: number } | undefined)?.totalCost
    return { status, reason, duration, cost }
}

function parseRunResult(stdout: string): {
    status?: string
    reason?: string
    duration?: number
    cost?: number
} | null {
    const trimmed = stdout.trim()
    if (!trimmed) return null

    // 1. Try parsing the entire stdout as JSON (handles pretty-printed output)
    try {
        return extractFields(JSON.parse(trimmed) as ParsedResult)
    } catch {
        /* not a single JSON blob */
    }

    // 2. Try extracting the last top-level JSON object from stdout.
    //    The CLI may print debug/log lines before the final JSON result.
    //    Find the last '{' that starts a line and grab everything from there.
    const lastBraceIdx = trimmed.lastIndexOf("\n{")
    if (lastBraceIdx !== -1) {
        try {
            const candidate = trimmed.slice(lastBraceIdx + 1)
            return extractFields(JSON.parse(candidate) as ParsedResult)
        } catch {
            /* not valid JSON from that point */
        }
    }

    // 3. Fallback: try the single last line (compact JSON after other output)
    const lines = trimmed.split("\n")
    const lastLine = lines[lines.length - 1]
    if (lastLine) {
        try {
            return extractFields(JSON.parse(lastLine) as ParsedResult)
        } catch {
            /* ignore */
        }
    }

    return null
}

function runTask(task: TrialTask): Promise<TrialRunRecord> {
    return new Promise((resolve) => {
        const name = `trial-${task.tier}-${task.id}`
        const args = [
            CLI_PATH,
            "run",
            task.description,
            "--name",
            name,
            "--renderer",
            "none",
            "--cwd",
            TRIALS_ROOT,
        ]
        const child = spawn(process.execPath, args, {
            cwd: PROJECT_ROOT,
            stdio: ["inherit", "pipe", "pipe"],
            env: { ...process.env },
        })
        let stdout = ""
        let stderr = ""
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString()
        })
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString()
        })
        child.on("close", (exitCode: number | null) => {
            const code = exitCode ?? -1
            const parsed = parseRunResult(stdout)
            const status = parsed?.status ?? "unknown"
            const reason = parsed?.reason
            const duration = parsed?.duration
            const cost = parsed?.cost
            const parseError = !parsed && stdout.length > 0
            const rawStdoutTail =
                stdout.length > 200
                    ? stdout.slice(-500)
                    : stdout || undefined
            const stderrTail =
                stderr.length > 0
                    ? stderr.length > 800
                        ? stderr.slice(-800)
                        : stderr
                    : undefined
            const effectiveReason =
                reason ??
                (status === "unknown" && stderrTail
                    ? stderrTail.trim().split("\n").slice(-3).join(" ")
                    : undefined)
            resolve({
                id: task.id,
                tier: task.tier,
                description: task.description,
                status,
                exitCode: code,
                ...(effectiveReason !== undefined && { reason: effectiveReason }),
                ...(duration !== undefined && { duration }),
                ...(cost !== undefined && { cost }),
                ...(parseError && { parseError: true }),
                ...(rawStdoutTail && parseError && { rawStdoutTail }),
                ...(stderrTail !== undefined && { stderrTail }),
            })
        })
        child.on("error", (err) => {
            resolve({
                id: task.id,
                tier: task.tier,
                description: task.description,
                status: "error",
                exitCode: -1,
                reason: err.message,
                parseError: true,
            })
        })
    })
}

async function main(): Promise<void> {
    await loadEnvFromRepo()
    await mkdir(TRIALS_ROOT, { recursive: true })
    console.error(`Trials output: ${TRIALS_ROOT}`)
    console.error(`  - generation dirs: ${join(TRIALS_ROOT, "generations")}`)
    console.error(`  - results file:    ${RESULTS_PATH}\n`)
    const tasks = await loadTasks()
    const runs: TrialRunRecord[] = []
    const byTier: Record<string, { total: number; completed: number }> = {}

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]
        if (!byTier[task.tier]) {
            byTier[task.tier] = { total: 0, completed: 0 }
        }
        byTier[task.tier].total += 1
        console.error(
            `[${i + 1}/${tasks.length}] ${task.tier} ${task.id}: ${task.description.slice(0, 50)}...`
        )
        const record = await runTask(task)
        if (record.status === "completed") {
            byTier[task.tier].completed += 1
        }
        runs.push(record)
    }

    const completed = runs.filter((r) => r.status === "completed").length
    const summary: TrialResults["summary"] = {
        total: runs.length,
        completed,
        failed: runs.length - completed,
        byTier,
    }
    const results: TrialResults = { summary, runs }
    await writeFile(RESULTS_PATH, JSON.stringify(results, null, 2), "utf-8")
    console.error(
        `\nTrial complete: ${completed}/${runs.length} completed. Results written to ${RESULTS_PATH}`
    )
    console.error(`Trials root (generation dirs): ${TRIALS_ROOT}`)
    if (completed < runs.length) {
        console.error(
            "Open the results file and check runs[].reason or runs[].stderrTail to see why each run failed."
        )
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
