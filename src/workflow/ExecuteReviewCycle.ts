import { log } from "../core/Logger.js"
import { formatStewardVoice } from "../core/stewardVoice.js"
import type { EventBus } from "../events/EventBus.js"
import type { AgentResult, Artifact, BabylonConfig } from "../types.js"
import type { RunAgentFn, WorkflowResult } from "./EscalationHandler.js"
import type { OversightTracker } from "./OversightTracker.js"

interface OversightContext {
    originalDescription: string
    depth: number
    currentSubtaskIndex: number
    subtaskDescriptions: string[]
}

export interface ExecuteReviewCycleOptions {
    executorMaxTurns?: number
    executorContextPrefix?: string
    reviewerMaxTurns?: number
    reviewerModel?: string
    subtaskId?: string
}

export class ExecuteReviewCycle {
    private pendingOversightNudge: string | null = null

    constructor(
        private readonly runAgent: RunAgentFn,
        private readonly eventBus: EventBus,
        private readonly config: BabylonConfig,
        private readonly maxRetries: number,
        private readonly allAgentResults: AgentResult[],
        private readonly abortSignal?: AbortSignal,
        private readonly oversightTracker?: OversightTracker | null,
        private readonly compositeOversightContext?: OversightContext | null
    ) {}

    public getPendingOversightNudge(): string | null {
        return this.pendingOversightNudge
    }

    public clearPendingOversightNudge(): void {
        this.pendingOversightNudge = null
    }

    public async run(
        specContext: string,
        originalDescription: string,
        fileScope: string[] | undefined,
        depth: number,
        options?: ExecuteReviewCycleOptions
    ): Promise<WorkflowResult> {
        const artifacts: Artifact[] = []
        const baseExecutorContext =
            (options?.executorContextPrefix ?? "") + specContext
        let executorContext = baseExecutorContext

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (this.abortSignal?.aborted) {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const executorResult = await this.runAgent(
                "executor",
                executorContext,
                undefined,
                fileScope,
                depth,
                {
                    maxTurns: options?.executorMaxTurns,
                    subtaskIdForEmit: options?.subtaskId,
                }
            )
            artifacts.push(executorResult.artifact)

            if (executorResult.status === "failed") {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const handoff =
                (executorResult.artifact.metadata?.handoff_notes as string) ??
                ""
            const reviewContext = [
                `Original task: ${originalDescription}`,
                `\nSpec/Context:\n${specContext}`,
                `\nExecutor summary: ${executorResult.artifact.content.slice(0, 500)}`,
                handoff ? `\nExecutor notes: ${handoff}` : "",
            ]
                .filter(Boolean)
                .join("\n")

            const effectiveReviewerModel =
                options?.reviewerModel ??
                this.config.reviewerModel ??
                (this.config.economyMode ? "gpt-4o-mini" : undefined)
            const reviewerResult = await this.runAgent(
                "reviewer",
                reviewContext,
                undefined,
                fileScope,
                depth,
                {
                    maxTurns: options?.reviewerMaxTurns,
                    model: effectiveReviewerModel,
                    subtaskIdForEmit: options?.subtaskId,
                }
            )
            artifacts.push(reviewerResult.artifact)

            if (reviewerResult.status === "completed") {
                return {
                    status: "completed",
                    artifacts,
                    agentResults: this.allAgentResults,
                }
            }

            const reviewNotes =
                (reviewerResult.artifact.metadata?.review_notes as string) ?? ""
            if (attempt < this.maxRetries) {
                log.workflow(
                    "The mirror reflects — revision needed (attempt %d/%d)",
                    attempt + 1,
                    this.maxRetries
                )
                const stepId = `executor-retry-${attempt + 1}`
                this.eventBus.emit({
                    type: "step:retry",
                    stepId,
                    attempt: attempt + 1,
                    maxRetries: this.maxRetries,
                    reason: reviewNotes.slice(0, 100) || "Review failed",
                })

                await this.maybeOversightCheckIn(depth)
                const revisionParts = [
                    specContext,
                    `\n\n--- REVISION REQUIRED ---`,
                    `The Mirror (reviewer) found issues with your previous implementation:`,
                    reviewNotes,
                    `\nFix ONLY the issues described above. Do not change anything else.`,
                ]
                if (this.pendingOversightNudge) {
                    revisionParts.push(
                        `\n\n${formatStewardVoice(this.pendingOversightNudge)}`
                    )
                    this.pendingOversightNudge = null
                }
                executorContext = revisionParts.join("\n")
            }
        }

        return {
            status: "failed",
            artifacts,
            agentResults: this.allAgentResults,
        }
    }

    public async maybeOversightCheckIn(executorDepth?: number): Promise<void> {
        if (!this.oversightTracker) return
        const signals = this.oversightTracker.getSignals()
        const lastOutcome = this.oversightTracker.getLastNudgeOutcome()
        if (Object.keys(signals).length === 0 && !lastOutcome) return

        const ctx = this.compositeOversightContext
        if (ctx) {
            const probability =
                Object.keys(signals).length > 0
                    ? 1
                    : (this.config.oversightProbability ?? 0.25)
            if (Math.random() >= probability) return
            const nextDesc =
                ctx.subtaskDescriptions[ctx.currentSubtaskIndex] ??
                "next subtask"
            const parts = [
                `Oversight check-in for composite at depth ${ctx.depth}.`,
                `Original: ${ctx.originalDescription}`,
                `About to run subtask ${ctx.currentSubtaskIndex + 1}/${ctx.subtaskDescriptions.length}: ${nextDesc}`,
            ]
            if (Object.keys(signals).length > 0) {
                parts.push(`Signals: ${JSON.stringify(signals)}`)
            }
            if (lastOutcome) {
                parts.push(
                    `Last nudge outcome: "${lastOutcome.nudge.slice(0, 80)}..." → ${lastOutcome.outcome}`
                )
            }
            parts.push(
                'Optionally provide a short nudge for the next step. Respond with JSON only: { "nudge": "..." } or {}.'
            )
            const oversightContext = parts.join("\n")
            const stewardResult = await this.runAgent(
                "steward",
                oversightContext,
                undefined,
                undefined,
                ctx.depth
            )
            const content = stewardResult.artifact.content ?? ""
            let nudge: string | null = null
            try {
                const parsed = JSON.parse(content) as { nudge?: string }
                if (typeof parsed.nudge === "string" && parsed.nudge.trim()) {
                    nudge = parsed.nudge.trim()
                }
            } catch {
                /* ignore parse errors */
            }
            this.pendingOversightNudge = nudge
            this.eventBus.emit({
                type: "oversight:check_in",
                depth: ctx.depth,
                subtaskIndex: ctx.currentSubtaskIndex,
                hasNudge: !!nudge,
            })
            return
        }

        const depth = executorDepth ?? 0
        const parts = [
            "Oversight check-in for current task. The Dreamer (executor) is about to retry.",
            `Signals from last run: ${JSON.stringify(signals)}`,
            'Provide a short nudge to get the Dreamer back on task. Respond with JSON only: { "nudge": "..." } or {}.',
        ]
        const oversightContext = parts.join("\n")
        const stewardResult = await this.runAgent(
            "steward",
            oversightContext,
            undefined,
            undefined,
            depth
        )
        const content = stewardResult.artifact.content ?? ""
        let nudge: string | null = null
        try {
            const parsed = JSON.parse(content) as { nudge?: string }
            if (typeof parsed.nudge === "string" && parsed.nudge.trim()) {
                nudge = parsed.nudge.trim()
            }
        } catch {
            /* ignore parse errors */
        }
        this.pendingOversightNudge = nudge
        this.eventBus.emit({
            type: "oversight:check_in",
            depth,
            subtaskIndex: undefined,
            hasNudge: !!nudge,
        })
    }
}
