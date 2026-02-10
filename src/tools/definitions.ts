import { readdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { execa } from "execa"

import { ToolExecutionError } from "../core/errors.js"
import { log } from "../core/Logger.js"
import type {
    AgentRole,
    ToolContext,
    ToolDefinition,
    ToolExecutionResult,
} from "../types.js"

const BLOCKED_COMMANDS = [
    /\brm\s+-rf\s+[/~]/,
    /\bgit\s+push\s+--force/,
    /\bgit\s+push\s+-f\b/,
    /\bnpm\s+publish\b/,
    /\bnpx\s+.*publish/,
    /\bsudo\s+rm\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\b:(){ :|:& };:/,
]

function isCommandBlocked(command: string): string | null {
    for (const pattern of BLOCKED_COMMANDS) {
        if (pattern.test(command)) {
            return `Command blocked by safety policy: matches ${pattern.source}`
        }
    }
    return null
}

const NON_TERMINATING_PATTERNS = [
    /\bnpm\s+run\s+dev\b/,
    /\bnpm\s+start\b/,
    /\byarn\s+dev\b/,
    /\byarn\s+start\b/,
    /\bnext\s+dev\b/,
    /\bvite\b/,
    /\bnpm\s+run\s+watch\b/,
    /\byarn\s+watch\b/,
    /\btsx\s+watch\b/,
    /\bts-node-dev\b/,
    /\bnodemon\b/,
    /\bhttp-server\b/,
    /\bnpx\s+http-server\b/,
]

function isCommandNonTerminating(command: string): string | null {
    for (const pattern of NON_TERMINATING_PATTERNS) {
        if (pattern.test(command)) {
            return "This command typically does not exit. Use a one-off command instead (e.g. npm run build, npm test)."
        }
    }
    return null
}

const MAX_TOOL_OUTPUT = 30_000
const SEARCH_MAX_OUTPUT = 20_000
const SEARCH_MAX_MATCHES = 150
const SEARCH_MAX_FILES = 300
const RESTRICTED_DIR = ".babylon"
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    RESTRICTED_DIR,
])

function isPathUnderRestricted(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
    return (
        normalized === RESTRICTED_DIR ||
        normalized.startsWith(`${RESTRICTED_DIR}/`)
    )
}

function truncateOutput(output: string): string {
    if (output.length <= MAX_TOOL_OUTPUT) return output
    const half = Math.floor(MAX_TOOL_OUTPUT / 2)
    const omitted = output.length - MAX_TOOL_OUTPUT
    return `${output.slice(0, half)}\n\n[… truncated ${omitted} characters …]\n\n${output.slice(-half)}`
}

export const runTerminalCommandTool: ToolDefinition = {
    name: "run_terminal_command",
    description:
        "Run a shell command in the working directory. Returns stdout and stderr. Use only non-interactive commands: no prompts, no stdin. Prefer flags like -y, --yes, or pipe yes into commands that would otherwise ask for input (e.g. npm init -y). Use one-off commands (e.g. npm run build, npm test); avoid long-running servers (e.g. npm run dev) which will timeout or be cancelled.",
    parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description:
                    "Non-interactive command (e.g. 'npm test', 'npm init -y'). Must not wait for user input.",
            },
            cwd: {
                type: "string",
                description:
                    "Optional subdirectory relative to working directory",
            },
        },
        required: ["command"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const command = args.command as string
        const blocked = isCommandBlocked(command)
        if (blocked) {
            return { content: blocked, isError: true }
        }
        const nonTerminating = isCommandNonTerminating(command)
        if (nonTerminating) {
            return { content: nonTerminating, isError: true }
        }
        const cwd = args.cwd
            ? resolve(context.workingDirectory, args.cwd as string)
            : context.workingDirectory
        try {
            const result = await execa(command, {
                shell: true,
                cwd,
                timeout: 120_000,
                reject: false,
                cancelSignal: context.abortSignal,
                stdio: ["ignore", "pipe", "pipe"],
            })
            const rawOut = [
                result.stdout ? `stdout:\n${result.stdout}` : "",
                result.stderr ? `stderr:\n${result.stderr}` : "",
                `exit code: ${result.exitCode}`,
            ]
                .filter(Boolean)
                .join("\n\n")
            const looksLikePrompt = new RegExp(
                "\\(y/n\\)|\\(Y/n\\)|Continue\\?|proceed\\?|\\[y/N\\]|>\\s*$",
                "im"
            ).test(rawOut)
            const hint = looksLikePrompt
                ? "\n\n[Command was run with no stdin; it may have been waiting for input. Retry with piped input (e.g. yes | cmd or echo y | cmd) or use -y/--yes if available.]"
                : ""
            return {
                content: truncateOutput(rawOut + hint),
                isError: result.exitCode !== 0,
            }
        } catch (error) {
            if (context.abortSignal?.aborted) {
                return {
                    content: "Command cancelled (aborted by user).",
                    isError: true,
                }
            }
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "run_terminal_command",
                `Command failed: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

export const readFileTool: ToolDefinition = {
    name: "read_file",
    description:
        "Read the contents of a file. Optionally use startLine/endLine to read only a range (reduces tokens for large files). Output is truncated at 30k characters.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "File path relative to the working directory",
            },
            startLine: {
                type: "number",
                description:
                    "Optional 1-based start line (inclusive). If set, only this range is returned.",
            },
            endLine: {
                type: "number",
                description:
                    "Optional 1-based end line (inclusive). Use with startLine.",
            },
        },
        required: ["path"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const basePath = resolve(context.workingDirectory)
        const filePath = resolve(basePath, args.path as string)
        const rel = relative(basePath, filePath)
        if (rel.startsWith("..")) {
            return {
                content: "Path must stay under the working directory.",
                isError: true,
            }
        }
        if (isPathUnderRestricted(rel)) {
            return {
                content: "Access to this path is not allowed.",
                isError: true,
            }
        }
        try {
            const content = await readFile(filePath, "utf-8")
            const startLine = args.startLine as number | undefined
            const endLine = args.endLine as number | undefined
            if (
                startLine != null &&
                endLine != null &&
                startLine >= 1 &&
                endLine >= startLine
            ) {
                const lines = content.split(/\r?\n/)
                const slice = lines.slice(
                    startLine - 1,
                    Math.min(endLine, lines.length)
                )
                const sliceContent = `[Lines ${startLine}-${endLine}]\n${slice.join("\n")}`
                return {
                    content: truncateOutput(sliceContent),
                    isError: false,
                }
            }
            return { content: truncateOutput(content), isError: false }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "read_file",
                `Failed to read file: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

const READ_FILES_MAX = 10
const READ_FILES_PER_FILE = 8_000
const READ_FILES_TOTAL = 25_000

export const readFilesTool: ToolDefinition = {
    name: "read_files",
    description:
        "Read multiple files in one call. Returns --- path ---\\ncontent for each. Use instead of multiple read_file calls when you need several small files. Truncated per file and globally.",
    parameters: {
        type: "object",
        properties: {
            paths: {
                type: "array",
                items: { type: "string" },
                description:
                    "File paths relative to the working directory (max 10).",
            },
        },
        required: ["paths"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const raw = args.paths
        const paths = Array.isArray(raw)
            ? raw
                  .filter((x): x is string => typeof x === "string")
                  .slice(0, READ_FILES_MAX)
            : []
        if (paths.length === 0) {
            return {
                content: "paths must be a non-empty array of paths.",
                isError: true,
            }
        }
        const basePath = resolve(context.workingDirectory)
        const parts: string[] = []
        let totalLen = 0
        for (const p of paths) {
            if (totalLen >= READ_FILES_TOTAL) break
            const filePath = resolve(basePath, p)
            const rel = relative(basePath, filePath)
            if (rel.startsWith("..")) {
                parts.push(`--- ${p} ---\n(path outside working directory)`)
                continue
            }
            if (isPathUnderRestricted(rel)) {
                parts.push(`--- ${p} ---\n(path not accessible)`)
                continue
            }
            try {
                const content = await readFile(filePath, "utf-8")
                const truncated =
                    content.length <= READ_FILES_PER_FILE
                        ? content
                        : content.slice(0, READ_FILES_PER_FILE) +
                          `\n\n[… truncated ${content.length - READ_FILES_PER_FILE} characters …]`
                parts.push(`--- ${p} ---\n${truncated}`)
                totalLen += truncated.length + p.length + 10
            } catch (err) {
                parts.push(
                    `--- ${p} ---\nError: ${err instanceof Error ? err.message : String(err)}`
                )
            }
        }
        const output = parts.join("\n\n")
        return {
            content:
                totalLen >= READ_FILES_TOTAL ? truncateOutput(output) : output,
            isError: false,
        }
    },
}

export const writeFileTool: ToolDefinition = {
    name: "write_file",
    description:
        "Write content to a file. Creates the file if it doesn't exist.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "File path relative to the working directory",
            },
            content: {
                type: "string",
                description: "The content to write",
            },
        },
        required: ["path", "content"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const basePath = resolve(context.workingDirectory)
        const filePath = resolve(basePath, args.path as string)
        const relativePath = args.path as string
        const rel = relative(basePath, filePath)
        if (rel.startsWith("..")) {
            return {
                content: "Path must stay under the working directory.",
                isError: true,
            }
        }
        if (isPathUnderRestricted(rel)) {
            return {
                content: "Access to this path is not allowed.",
                isError: true,
            }
        }

        if (context.fileScope && context.fileScope.length > 0) {
            const inScope = context.fileScope.some(
                (scope) =>
                    relativePath.startsWith(scope) || relativePath === scope
            )
            if (!inScope) {
                log.tool(
                    "SCOPE WARNING: write to %s is outside assigned scope %o",
                    relativePath,
                    context.fileScope
                )
            }
        }

        try {
            await writeFile(filePath, args.content as string, "utf-8")
            return {
                content: `Successfully wrote to ${relativePath}`,
                isError: false,
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "write_file",
                `Failed to write file: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

const LIST_TREE_MAX_ENTRIES = 400
const LIST_TREE_MAX_OUTPUT = 12_000

async function listDirectoryRecursive(
    dir: string,
    basePath: string,
    currentDepth: number,
    maxDepth: number,
    prefix: string,
    lines: string[],
    totalLen: { value: number }
): Promise<void> {
    if (
        lines.length >= LIST_TREE_MAX_ENTRIES ||
        totalLen.value >= LIST_TREE_MAX_OUTPUT
    )
        return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
        entries = await readdir(dir, { withFileTypes: true })
    } catch {
        return
    }
    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
    })
    for (const e of entries) {
        if (
            lines.length >= LIST_TREE_MAX_ENTRIES ||
            totalLen.value >= LIST_TREE_MAX_OUTPUT
        )
            break
        if (SKIP_DIRS.has(e.name)) continue
        const line = `${prefix}${e.isDirectory() ? "d" : "f"} ${e.name}`
        lines.push(line)
        totalLen.value += line.length + 1
        if (
            e.isDirectory() &&
            currentDepth < maxDepth &&
            !SKIP_DIRS.has(e.name)
        ) {
            const full = resolve(dir, e.name)
            const rel = relative(basePath, full)
            if (rel.startsWith("..")) continue
            await listDirectoryRecursive(
                full,
                basePath,
                currentDepth + 1,
                maxDepth,
                prefix + "  ",
                lines,
                totalLen
            )
        }
    }
}

export const listDirectoryTool: ToolDefinition = {
    name: "list_directory",
    description:
        "List files and directories in a given path. Use maxDepth to get a directory tree in one call instead of listing each level separately (e.g. maxDepth 2 = current dir + one level down). Path must be '.' or a subpath of the working directory; parent paths ('..') are not allowed.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description:
                    "Directory path relative to the working directory. Use '.' for current dir or a subpath (e.g. 'src'). Do not use '..' or parent paths.",
            },
            maxDepth: {
                type: "number",
                description:
                    "If > 1, list recursively up to this many levels (1 = current only, 2 = one level down, etc.). Default 1.",
            },
        },
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const basePath = resolve(context.workingDirectory)
        const dirPath = resolve(basePath, (args.path as string) ?? ".")
        const rel = relative(basePath, dirPath)
        if (rel.startsWith("..")) {
            return {
                content:
                    "Path must stay under the working directory. Use '.' or a subpath (e.g. 'src'); do not use '..' or parent paths.",
                isError: true,
            }
        }
        if (isPathUnderRestricted(rel)) {
            return {
                content: "Access to this path is not allowed.",
                isError: true,
            }
        }
        const maxDepth = Math.min(
            Math.max(1, (args.maxDepth as number) || 1),
            5
        )
        try {
            if (maxDepth <= 1) {
                const entries = await readdir(dirPath, {
                    withFileTypes: true,
                })
                const listing = entries
                    .filter((e) => !SKIP_DIRS.has(e.name))
                    .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
                    .join("\n")
                return {
                    content: listing || "(empty directory)",
                    isError: false,
                }
            }
            const lines: string[] = []
            const totalLen = { value: 0 }
            await listDirectoryRecursive(
                dirPath,
                dirPath,
                0,
                maxDepth,
                "",
                lines,
                totalLen
            )
            const content = lines.join("\n")
            return {
                content:
                    totalLen.value >= LIST_TREE_MAX_OUTPUT
                        ? truncateOutput(content)
                        : content || "(empty directory)",
                isError: false,
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "list_directory",
                `Failed to list directory: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

async function collectFiles(
    dir: string,
    basePath: string,
    glob: string | undefined,
    maxFiles: number,
    results: string[]
): Promise<void> {
    if (results.length >= maxFiles) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
        entries = await readdir(dir, { withFileTypes: true })
    } catch {
        return
    }
    for (const e of entries) {
        if (results.length >= maxFiles) break
        const full = resolve(dir, e.name)
        const rel = relative(basePath, full)
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue
            if (rel.startsWith("..")) continue
            await collectFiles(full, basePath, glob, maxFiles, results)
        } else {
            if (glob) {
                const re = new RegExp(
                    glob.replace(/\*/g, ".*").replace(/\?/g, ".")
                )
                if (!re.test(e.name)) continue
            }
            results.push(rel)
        }
    }
}

export const searchInFilesTool: ToolDefinition = {
    name: "search_in_files",
    description:
        "Search file contents for a pattern under a directory. Returns path:lineNumber:lineContent per match. Use this to find references or definitions instead of many read_file calls. Skips node_modules, .git, .next, dist, build, .babylon.",
    parameters: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description:
                    "Search pattern (regex). Escape special chars (e.g. . * [ ]) if you want a literal match.",
            },
            path: {
                type: "string",
                description:
                    "Directory to search under, relative to working directory. Default '.'.",
            },
            glob: {
                type: "string",
                description:
                    "Optional file name pattern (e.g. '*.ts', '*.json') to limit which files are searched.",
            },
            maxResults: {
                type: "number",
                description:
                    "Maximum number of matching lines to return. Default 150.",
            },
        },
        required: ["pattern"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const basePath = resolve(context.workingDirectory)
        const searchPath = resolve(
            basePath,
            (args.path as string)?.trim() || "."
        )
        const relPath = relative(basePath, searchPath)
        if (relPath.startsWith("..")) {
            return {
                content: "Path must stay under the working directory.",
                isError: true,
            }
        }
        if (isPathUnderRestricted(relPath)) {
            return {
                content: "Access to this path is not allowed.",
                isError: true,
            }
        }
        const patternStr = (args.pattern as string)?.trim()
        if (!patternStr) {
            return { content: "Pattern is required.", isError: true }
        }
        let regex: RegExp
        try {
            regex = new RegExp(patternStr, "g")
        } catch {
            regex = new RegExp(
                patternStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                "g"
            )
        }
        const globArg = args.glob as string | undefined
        const maxResults = Math.min(
            Math.max(1, (args.maxResults as number) || SEARCH_MAX_MATCHES),
            500
        )
        const files: string[] = []
        await collectFiles(
            searchPath,
            searchPath,
            globArg,
            SEARCH_MAX_FILES,
            files
        )
        const lines: string[] = []
        let totalLen = 0
        for (const rel of files) {
            if (lines.length >= maxResults || totalLen >= SEARCH_MAX_OUTPUT)
                break
            const fullPath = resolve(searchPath, rel)
            try {
                const content = await readFile(fullPath, "utf-8")
                const fileLines = content.split(/\r?\n/)
                for (let i = 0; i < fileLines.length; i++) {
                    if (
                        lines.length >= maxResults ||
                        totalLen >= SEARCH_MAX_OUTPUT
                    )
                        break
                    if (regex.test(fileLines[i])) {
                        const line = `${rel}:${i + 1}:${fileLines[i]}`
                        lines.push(line)
                        totalLen += line.length + 1
                    }
                }
                regex.lastIndex = 0
            } catch {
                continue
            }
        }
        const output = lines.join("\n")
        const result =
            totalLen >= SEARCH_MAX_OUTPUT ? truncateOutput(output) : output
        return {
            content: result || "(no matches)",
            isError: false,
        }
    },
}

export const gitOperationsTool: ToolDefinition = {
    name: "git_operations",
    description:
        "Run git operations: status, branch, checkout, add, commit, diff, log, merge.",
    parameters: {
        type: "object",
        properties: {
            operation: {
                type: "string",
                description: "The git operation to perform",
                enum: [
                    "status",
                    "branch",
                    "checkout",
                    "add",
                    "commit",
                    "diff",
                    "log",
                    "merge",
                ],
            },
            args: {
                type: "string",
                description:
                    "Additional arguments for the git command (e.g. branch name, commit message)",
            },
        },
        required: ["operation"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const operation = args.operation as string
        const gitArgs = (args.args as string) ?? ""
        const command = `git ${operation} ${gitArgs}`.trim()
        try {
            const result = await execa(command, {
                shell: true,
                cwd: context.workingDirectory,
                reject: false,
                cancelSignal: context.abortSignal,
            })
            const output = [
                result.stdout,
                result.stderr ? `stderr: ${result.stderr}` : "",
            ]
                .filter(Boolean)
                .join("\n")
            return {
                content: truncateOutput(output || "(no output)"),
                isError: result.exitCode !== 0,
            }
        } catch (error) {
            if (context.abortSignal?.aborted) {
                return {
                    content: "Command cancelled (aborted by user).",
                    isError: true,
                }
            }
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "git_operations",
                `Git operation failed: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

const DIFF_TRUNCATE = 12_000
const TEST_OUTPUT_TRUNCATE = 3_000
const TEST_TIMEOUT_MS = 45_000

export const reviewWorkspaceTool: ToolDefinition = {
    name: "review_workspace",
    description:
        "Get a full review snapshot in one call: git status, git diff --stat, git diff (truncated), and test run result. Prefer this over multiple git_operations + run_terminal_command when you need status, diff, and test result in one shot.",
    parameters: {
        type: "object",
        properties: {
            testCommand: {
                type: "string",
                description:
                    "Test command to run (default: npm test). Use empty string to skip tests.",
            },
        },
        required: [],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const cwd = context.workingDirectory
        const sections: string[] = []

        try {
            const execaOpts = {
                cwd,
                reject: false as const,
                cancelSignal: context.abortSignal,
            }
            const statusResult = await execa("git", ["status", "--short"], {
                ...execaOpts,
            })
            sections.push(
                "## Git status\n" + (statusResult.stdout || "(clean)")
            )

            const statResult = await execa("git", ["diff", "--stat"], {
                ...execaOpts,
            })
            sections.push(
                "## Git diff --stat\n" + (statResult.stdout || "(no diff)")
            )

            const diffResult = await execa("git", ["diff"], {
                ...execaOpts,
            })
            const diffOut = diffResult.stdout || "(no diff)"
            sections.push(
                "## Git diff\n" +
                    (diffOut.length <= DIFF_TRUNCATE
                        ? diffOut
                        : diffOut.slice(0, DIFF_TRUNCATE) +
                          `\n\n[… truncated ${diffOut.length - DIFF_TRUNCATE} chars]`)
            )

            const testCmd = (args.testCommand as string)?.trim() || "npm test"
            if (testCmd) {
                try {
                    const testResult = await execa(testCmd, {
                        shell: true,
                        cwd,
                        timeout: TEST_TIMEOUT_MS,
                        reject: false,
                        cancelSignal: context.abortSignal,
                    })
                    const testOut = [testResult.stdout, testResult.stderr]
                        .filter(Boolean)
                        .join("\n")
                    const truncated =
                        testOut.length <= TEST_OUTPUT_TRUNCATE
                            ? testOut
                            : testOut.slice(-TEST_OUTPUT_TRUNCATE)
                    sections.push(
                        `## Test result (exit ${testResult.exitCode})\n` +
                            (truncated || "(no output)")
                    )
                } catch (err) {
                    sections.push(
                        "## Test result\nError: " +
                            (err instanceof Error ? err.message : String(err))
                    )
                }
            }

            return {
                content: sections.join("\n\n"),
                isError: false,
            }
        } catch (error) {
            if (context.abortSignal?.aborted) {
                return {
                    content: "Command cancelled (aborted by user).",
                    isError: true,
                }
            }
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "review_workspace",
                `review_workspace failed: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

export const invokeCursorCliTool: ToolDefinition = {
    name: "invoke_cursor_cli",
    description:
        "Invoke the Cursor or Claude Code CLI to perform coding tasks. Passes a prompt and returns the output.",
    parameters: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: "The task prompt to send to the coding assistant",
            },
            cli: {
                type: "string",
                description:
                    'Which CLI to use: "cursor" or "claude". Defaults to "claude".',
                enum: ["cursor", "claude"],
            },
        },
        required: ["prompt"],
    },
    execute: async (
        args: Record<string, unknown>,
        context: ToolContext
    ): Promise<ToolExecutionResult> => {
        const prompt = args.prompt as string
        const cli = (args.cli as string) ?? "claude"
        try {
            const cliCommand =
                cli === "cursor"
                    ? `cursor --message ${JSON.stringify(prompt)}`
                    : `claude -p ${JSON.stringify(prompt)} --output-format text`

            const result = await execa(cliCommand, {
                shell: true,
                cwd: context.workingDirectory,
                timeout: 300_000,
                reject: false,
                cancelSignal: context.abortSignal,
            })
            const output = [
                result.stdout,
                result.stderr ? `stderr: ${result.stderr}` : "",
            ]
                .filter(Boolean)
                .join("\n")
            return {
                content: truncateOutput(output || "(no output)"),
                isError: result.exitCode !== 0,
            }
        } catch (error) {
            if (context.abortSignal?.aborted) {
                return {
                    content: "Command cancelled (aborted by user).",
                    isError: true,
                }
            }
            const msg = error instanceof Error ? error.message : String(error)
            throw new ToolExecutionError(
                "invoke_cursor_cli",
                `CLI invocation failed: ${msg}`,
                error instanceof Error ? error : undefined
            )
        }
    },
}

export const completeTaskTool: ToolDefinition = {
    name: "complete_task",
    description:
        "Signal that you have completed your task. Provide your final output as a structured result.",
    parameters: {
        type: "object",
        properties: {
            status: {
                type: "string",
                description: "The outcome of your work",
                enum: ["completed", "failed", "needs_review"],
            },
            summary: {
                type: "string",
                description:
                    "A brief summary of what was accomplished or why it failed",
            },
            content: {
                type: "string",
                description:
                    "The detailed output (analysis, spec, code changes description, review, etc.)",
            },
            handoff_notes: {
                type: "string",
                description:
                    "Notes for the NEXT agent in the workflow. Context, focus areas, or instructions for whoever picks up after you.",
            },
            review_notes: {
                type: "string",
                description:
                    "When status is needs_review or failed: specific feedback about what needs to change, directed at the agent who will retry this work.",
            },
            metadata: {
                type: "object",
                description:
                    "Optional structured metadata (e.g. { complexity: 0.5, files_changed: 3 })",
                properties: {},
            },
        },
        required: ["status", "summary", "content"],
    },
    execute: (
        args: Record<string, unknown>,
        _context: ToolContext
    ): Promise<ToolExecutionResult> => {
        return Promise.resolve({
            content: JSON.stringify({
                status: args.status,
                summary: args.summary,
                content: args.content,
                handoff_notes: args.handoff_notes ?? "",
                review_notes: args.review_notes ?? "",
                metadata: args.metadata ?? {},
            }),
            isError: false,
        })
    },
}

export const ALL_TOOLS = {
    run_terminal_command: runTerminalCommandTool,
    read_file: readFileTool,
    read_files: readFilesTool,
    write_file: writeFileTool,
    list_directory: listDirectoryTool,
    search_in_files: searchInFilesTool,
    git_operations: gitOperationsTool,
    review_workspace: reviewWorkspaceTool,
    invoke_cursor_cli: invokeCursorCliTool,
    complete_task: completeTaskTool,
} as const

export function getToolsForRole(
    role: AgentRole,
    options?: { useCli?: boolean }
): ToolDefinition[] {
    const useCli = options?.useCli ?? true

    const toolMap: Record<AgentRole, string[]> = {
        analyzer: [
            "search_in_files",
            "read_file",
            "read_files",
            "list_directory",
            "run_terminal_command",
            "complete_task",
        ],
        planner: [
            "search_in_files",
            "read_file",
            "read_files",
            "list_directory",
            "run_terminal_command",
            "complete_task",
        ],
        executor: [
            "run_terminal_command",
            "read_file",
            "read_files",
            "write_file",
            "list_directory",
            "git_operations",
            ...(useCli ? ["invoke_cursor_cli"] : []),
            "complete_task",
        ],
        reviewer: [
            "review_workspace",
            "search_in_files",
            "read_file",
            "read_files",
            "list_directory",
            "run_terminal_command",
            "git_operations",
            "complete_task",
        ],
        coordinator: [
            "read_file",
            "read_files",
            "write_file",
            "list_directory",
            "run_terminal_command",
            "git_operations",
            "complete_task",
        ],
        steward: ["complete_task"],
        oracle: ["complete_task"],
    }
    const toolNames = toolMap[role]
    return toolNames.map((name) => ALL_TOOLS[name as keyof typeof ALL_TOOLS])
}
