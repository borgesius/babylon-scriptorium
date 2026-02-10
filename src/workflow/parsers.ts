import { log } from "../core/Logger.js"
import type {
    AgentResult,
    AnalyzerOutput,
    OracleAction,
    PlannerOutput,
    StewardAction,
} from "../types.js"

const DEFAULT_COMPLEXITY = 0.5

export function parseAnalyzerOutput(result: AgentResult): AnalyzerOutput {
    const content = result.artifact.content
    try {
        const parsed = JSON.parse(content) as {
            complexity?: number | string
            summary?: string
            affectedFiles?: string[]
            recommendedApproach?: string
        }
        let complexity: number
        const raw = parsed.complexity
        if (typeof raw === "number" && raw >= 0 && raw <= 1) {
            complexity = raw
        } else if (typeof raw === "string") {
            complexity =
                raw === "simple"
                    ? 0.25
                    : raw === "medium"
                      ? 0.5
                      : raw === "complex"
                        ? 0.85
                        : DEFAULT_COMPLEXITY
        } else {
            complexity = DEFAULT_COMPLEXITY
        }
        return {
            complexity,
            summary: parsed.summary ?? content,
            affectedFiles: parsed.affectedFiles ?? [],
            recommendedApproach: parsed.recommendedApproach ?? "",
        }
    } catch {
        log.workflow(
            "Analyzer JSON parse failed; using complexity %s",
            DEFAULT_COMPLEXITY
        )
        return {
            complexity: DEFAULT_COMPLEXITY,
            summary: content.slice(0, 500),
            affectedFiles: [],
            recommendedApproach: "",
        }
    }
}

export function parsePlannerOutput(result: AgentResult): PlannerOutput {
    try {
        const parsed = JSON.parse(result.artifact.content) as PlannerOutput
        if (parsed.type === "decomposition" || parsed.type === "spec") {
            return parsed
        }
    } catch {
        /* fall through to default */
    }

    return {
        type: "spec",
        spec: result.artifact.content,
        acceptanceCriteria: [],
        expectedFiles: [],
        fileScope: [],
    }
}

export function parseStewardOutput(content: string): StewardAction | null {
    try {
        const raw = content.trim()
        const json = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
        const parsed = JSON.parse(json) as Record<string, unknown>
        const action = parsed.action as string
        const valid: StewardAction["action"][] = [
            "retry_merge",
            "retry_children",
            "add_fix_task",
            "re_decompose",
            "escalate",
        ]
        if (!valid.includes(action as StewardAction["action"])) return null
        return {
            action: action as StewardAction["action"],
            taskIndices: parsed.taskIndices as number[] | undefined,
            retryFocus: parsed.retryFocus as string | undefined,
            fixDescription: parsed.fixDescription as string | undefined,
        }
    } catch {
        return null
    }
}

export function parseOracleOutput(content: string): OracleAction | null {
    try {
        const raw = content.trim()
        const json = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
        const parsed = JSON.parse(json) as Record<string, unknown>
        const action = parsed.action as string
        const valid: OracleAction["action"][] = [
            "nudge_root_steward",
            "retry_once",
            "escalate_to_user",
        ]
        if (!valid.includes(action as OracleAction["action"])) return null
        return {
            action: action as OracleAction["action"],
            nudgeMessage: parsed.nudgeMessage as string | undefined,
            retryFocus: parsed.retryFocus as string | undefined,
        }
    } catch {
        return null
    }
}
