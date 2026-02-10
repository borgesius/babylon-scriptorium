import type { EventBus } from "../events/EventBus.js"
import type {
    AgentResult,
    AgentRole,
    Artifact,
    OracleAction,
    PlannerOutput,
    StewardAction,
    WorkflowStatus,
} from "../types.js"
import { parseOracleOutput, parseStewardOutput } from "./parsers.js"

export interface WorkflowResult {
    status: WorkflowStatus
    artifacts: Artifact[]
    agentResults: AgentResult[]
}

export type RunAgentFn = (
    role: AgentRole,
    userMessage: string,
    parentContext: string | undefined,
    fileScope: string[] | undefined,
    depth: number,
    agentOptions?: {
        maxTurns?: number
        model?: string
        subtaskIdForEmit?: string | null
    }
) => Promise<AgentResult>

export class EscalationHandler {
    constructor(
        private readonly runAgent: RunAgentFn,
        private readonly eventBus: EventBus
    ) {}

    public async runStewardAndParse(
        originalDescription: string,
        _plan: Extract<PlannerOutput, { type: "decomposition" }>,
        subtaskResults: WorkflowResult[],
        coordinatorResult: AgentResult,
        reviewNotes: string,
        depth: number,
        oracleNudge?: string
    ): Promise<StewardAction | null> {
        const summaries = subtaskResults
            .map((r, i) => {
                const last = r.artifacts[r.artifacts.length - 1]
                return `Subtask ${i + 1}: ${last?.content?.slice(0, 150) ?? ""}`
            })
            .join("\n")
        const baseContext = [
            `Original task for this level: ${originalDescription}`,
            `\nSubtasks (${subtaskResults.length}):`,
            summaries,
            `\nMerge/QA result: ${coordinatorResult.status}. Summary: ${coordinatorResult.artifact.content?.slice(0, 300) ?? ""}`,
            `\nReview notes: ${reviewNotes}`,
            "\nDecide the next action and call complete_task with content = JSON: { action, ... }.",
        ].join("\n")
        const context = oracleNudge
            ? `The Oracle says: ${oracleNudge}\n\n${baseContext}`
            : baseContext
        const stewardResult = await this.runAgent(
            "steward",
            context.trim(),
            undefined,
            undefined,
            depth
        )
        const content = stewardResult.artifact.content ?? ""
        const parsed = parseStewardOutput(content)
        if (parsed) return parsed
        return { action: "escalate" }
    }

    public async runOracle(
        originalDescription: string,
        _plan: Extract<PlannerOutput, { type: "decomposition" }>,
        subtaskResults: WorkflowResult[],
        coordinatorResult: AgentResult,
        reviewNotes: string
    ): Promise<OracleAction | null> {
        const summaries = subtaskResults
            .map((r, i) => {
                const last = r.artifacts[r.artifacts.length - 1]
                return `Child ${i + 1}: ${last?.content?.slice(0, 80) ?? "done"}`
            })
            .join("; ")
        const snapshot = [
            `Root task: ${originalDescription}`,
            `Root steward situation: Merge/QA ${coordinatorResult.status}.`,
            `Review notes: ${reviewNotes.slice(0, 500)}`,
            `Direct children (${subtaskResults.length}): ${summaries}`,
            "The root steward is stuck. What do you do? Respond with JSON only.",
        ].join("\n")
        this.eventBus.emit({
            type: "oracle:invoked",
            snapshotSummary: snapshot.slice(0, 200),
        })
        const oracleResult = await this.runAgent(
            "oracle",
            snapshot,
            undefined,
            undefined,
            0
        )
        const content = oracleResult.artifact.content ?? ""
        const parsed = parseOracleOutput(content)
        if (parsed) {
            this.eventBus.emit({
                type: "oracle:decision",
                action: parsed.action,
            })
        }
        return parsed
    }
}
