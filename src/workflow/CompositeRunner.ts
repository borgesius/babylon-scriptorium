import { randomUUID } from "node:crypto"

import { log } from "../core/Logger.js"
import { formatStewardVoice } from "../core/stewardVoice.js"
import type { EventBus } from "../events/EventBus.js"
import type {
    AgentResult,
    Artifact,
    BabylonConfig,
    PlannerOutput,
    SubtaskDef,
} from "../types.js"
import type { RunAgentFn, WorkflowResult } from "./EscalationHandler.js"
import { EscalationHandler } from "./EscalationHandler.js"
import type { OrgChart } from "./OrgChart.js"
import type { OversightTracker } from "./OversightTracker.js"
import { parsePlannerOutput } from "./parsers.js"

export interface CompositeRunnerDeps {
    runAgent: RunAgentFn
    runTask: (options: {
        description: string
        depth?: number
        fileScope?: string[]
        skipAnalysis?: boolean
        parentContext?: string
        subtaskId?: string
    }) => Promise<WorkflowResult>
    eventBus: EventBus
    config: BabylonConfig
    allAgentResults: AgentResult[]
    rootTaskId: string | null
    orgChart: OrgChart
    oversightTracker: OversightTracker | null
    maxCompositeCycles: number
    abortSignal?: AbortSignal
}

export class CompositeRunner {
    private readonly escalation: EscalationHandler
    private compositeOversightContext: {
        originalDescription: string
        depth: number
        currentSubtaskIndex: number
        subtaskDescriptions: string[]
    } | null = null
    private oversightCycleCount = 0
    private lastAppliedNudge: string | null = null
    private pendingOversightNudge: string | null = null

    constructor(private readonly deps: CompositeRunnerDeps) {
        this.escalation = new EscalationHandler(deps.runAgent, deps.eventBus)
    }

    public filterDuplicateSetupSubtask(
        plan: Extract<PlannerOutput, { type: "decomposition" }>
    ): SubtaskDef[] {
        if (!plan.setupTask) return plan.subtasks
        const setupDesc = plan.setupTask.description.trim().toLowerCase()
        return plan.subtasks.filter((s) => {
            const d = s.description.trim().toLowerCase()
            if (d === setupDesc) return false
            const words = setupDesc.split(/\s+/).filter((w) => w.length > 2)
            const sameMeaning =
                words.length >= 2 && words.every((w) => d.includes(w))
            return !sameMeaning
        })
    }

    public haveOverlappingFileScopes(subtasks: SubtaskDef[]): boolean {
        const normalize = (p: string): string => p.replace(/\/$/, "") || "."
        for (let i = 0; i < subtasks.length; i++) {
            const a = (subtasks[i].fileScope ?? []).map(normalize)
            for (let j = i + 1; j < subtasks.length; j++) {
                const b = (subtasks[j].fileScope ?? []).map(normalize)
                if (a.length === 0 || b.length === 0) return true
                for (const pa of a) {
                    for (const pb of b) {
                        if (
                            pa === pb ||
                            pa.startsWith(pb + "/") ||
                            pb.startsWith(pa + "/")
                        )
                            return true
                    }
                }
            }
        }
        return false
    }

    public async run(
        plan: Extract<PlannerOutput, { type: "decomposition" }>,
        originalDescription: string,
        depth: number,
        existingArtifacts: Artifact[]
    ): Promise<WorkflowResult> {
        const artifacts = [...existingArtifacts]
        const taskId = this.deps.rootTaskId ?? randomUUID()

        if (depth === 0) {
            const rootNode = this.deps.orgChart.getNode(taskId)
            if (rootNode) {
                rootNode.type = "composite"
                rootNode.hasSteward = true
            }
        }

        const subtasks = this.filterDuplicateSetupSubtask(plan)
        const parallel =
            plan.parallel && !this.haveOverlappingFileScopes(subtasks)
        if (subtasks.length < plan.subtasks.length) {
            log.workflow(
                "Filtered %d duplicate setup subtask(s)",
                plan.subtasks.length - subtasks.length
            )
        }
        if (plan.parallel && !parallel) {
            log.workflow(
                "Overlapping file scopes detected; running subtasks sequentially"
            )
        }
        const totalWithSetup = (plan.setupTask ? 1 : 0) + subtasks.length
        this.compositeOversightContext = {
            originalDescription,
            depth,
            currentSubtaskIndex: 0,
            subtaskDescriptions: subtasks.map((s) => s.description),
        }
        this.oversightCycleCount = 0

        try {
            if (plan.setupTask) {
                log.workflow("Running setup subtask before parallel work")
                const setupSubtaskId = randomUUID()
                this.deps.orgChart.addChild(
                    setupSubtaskId,
                    taskId,
                    plan.setupTask.description,
                    depth + 1,
                    false
                )
                this.deps.eventBus.emit({
                    type: "subtask:start",
                    taskId,
                    subtaskId: setupSubtaskId,
                    description: plan.setupTask.description,
                    index: 0,
                    total: totalWithSetup,
                })
                const setupResult = await this.deps.runTask({
                    description: plan.setupTask.description,
                    depth: depth + 1,
                    fileScope: plan.setupTask.fileScope,
                    skipAnalysis: plan.setupTask.skipAnalysis,
                    parentContext: `Setup task for: ${originalDescription}`,
                    subtaskId: setupSubtaskId,
                })
                this.deps.eventBus.emit({
                    type: "subtask:complete",
                    subtaskId: setupSubtaskId,
                    status: setupResult.status,
                })
                artifacts.push(...setupResult.artifacts)
                if (setupResult.status === "failed") {
                    return {
                        status: "failed",
                        artifacts,
                        agentResults: this.deps.allAgentResults,
                    }
                }
            }

            const subtaskResults = await this.runSubtasks(
                subtasks,
                parallel,
                plan,
                taskId,
                originalDescription,
                depth,
                totalWithSetup
            )
            for (const sr of subtaskResults) {
                artifacts.push(...sr.artifacts)
            }
            const anyFailed = subtaskResults.some((r) => r.status === "failed")
            if (anyFailed) {
                return {
                    status: "failed",
                    artifacts,
                    agentResults: this.deps.allAgentResults,
                }
            }

            log.workflow("Paths converge at the aleph")

            const { coordinatorResult, subtaskSummaries, lastReviewNotes } =
                await this.runCompositeQACycle(
                    subtasks,
                    subtaskResults,
                    plan,
                    originalDescription,
                    depth,
                    taskId,
                    artifacts
                )

            if (coordinatorResult.status === "completed") {
                return {
                    status: "completed",
                    artifacts,
                    agentResults: this.deps.allAgentResults,
                }
            }

            if (
                depth === 0 &&
                (coordinatorResult.status === "needs_review" ||
                    coordinatorResult.status === "failed")
            ) {
                const finalResult = await this.runFinalOracleEscalation(
                    originalDescription,
                    plan,
                    subtaskResults,
                    coordinatorResult,
                    lastReviewNotes,
                    subtaskSummaries,
                    depth,
                    artifacts
                )
                if (finalResult) return finalResult
            }

            return {
                status:
                    coordinatorResult.status === "needs_review"
                        ? "needs_review"
                        : "failed",
                artifacts,
                agentResults: this.deps.allAgentResults,
            }
        } finally {
            this.compositeOversightContext = null
        }
    }

    private async runSubtasks(
        subtasks: SubtaskDef[],
        parallel: boolean,
        plan: Extract<PlannerOutput, { type: "decomposition" }>,
        taskId: string,
        originalDescription: string,
        depth: number,
        totalWithSetup: number
    ): Promise<WorkflowResult[]> {
        if (parallel) {
            log.workflow(
                "The path forks — %d branches (parallel)",
                subtasks.length
            )
            const subtaskIds = subtasks.map(() => randomUUID())
            subtasks.forEach((subtask, i) => {
                this.deps.orgChart.addChild(
                    subtaskIds[i],
                    taskId,
                    subtask.description,
                    depth + 1,
                    false
                )
                this.deps.eventBus.emit({
                    type: "subtask:start",
                    taskId,
                    subtaskId: subtaskIds[i],
                    description: subtask.description,
                    index: i + (plan.setupTask ? 1 : 0),
                    total: totalWithSetup,
                })
            })
            const results = await Promise.all(
                subtasks.map((subtask, i) =>
                    this.deps.runTask({
                        description: subtask.description,
                        depth: depth + 1,
                        fileScope: subtask.fileScope,
                        skipAnalysis: subtask.skipAnalysis,
                        parentContext: `Subtask of: ${originalDescription}`,
                        subtaskId: subtaskIds[i],
                    })
                )
            )
            subtaskIds.forEach((subtaskId, i) => {
                this.deps.eventBus.emit({
                    type: "subtask:complete",
                    subtaskId,
                    status: results[i].status,
                })
            })
            return results
        }

        log.workflow(
            "The path forks — %d branches (sequential)",
            subtasks.length
        )
        const results: WorkflowResult[] = []
        for (let i = 0; i < subtasks.length; i++) {
            const subtask = subtasks[i]
            const subtaskId = randomUUID()
            if (this.compositeOversightContext) {
                this.compositeOversightContext.currentSubtaskIndex = i
            }
            await this.maybeOversightCheckIn()
            let parentContext = `Subtask of: ${originalDescription}`
            if (this.pendingOversightNudge) {
                parentContext += `\n\n${formatStewardVoice(this.pendingOversightNudge)}`
                this.lastAppliedNudge = this.pendingOversightNudge
                this.pendingOversightNudge = null
            }
            this.deps.orgChart.addChild(
                subtaskId,
                taskId,
                subtask.description,
                depth + 1,
                false
            )
            this.deps.eventBus.emit({
                type: "subtask:start",
                taskId,
                subtaskId,
                description: subtask.description,
                index: i + (plan.setupTask ? 1 : 0),
                total: totalWithSetup,
            })
            const result = await this.deps.runTask({
                description: subtask.description,
                depth: depth + 1,
                fileScope: subtask.fileScope,
                skipAnalysis: subtask.skipAnalysis,
                parentContext,
                subtaskId,
            })
            if (this.lastAppliedNudge && this.deps.oversightTracker) {
                this.deps.oversightTracker.recordNudgeOutcome(
                    this.lastAppliedNudge,
                    result.status
                )
                this.lastAppliedNudge = null
            }
            this.deps.eventBus.emit({
                type: "subtask:complete",
                subtaskId,
                status: result.status,
            })
            results.push(result)
            if (result.status === "failed") break
        }
        return results
    }

    private async runCompositeQACycle(
        subtasks: SubtaskDef[],
        subtaskResults: WorkflowResult[],
        plan: Extract<PlannerOutput, { type: "decomposition" }>,
        originalDescription: string,
        depth: number,
        taskId: string,
        artifacts: Artifact[]
    ): Promise<{
        coordinatorResult: AgentResult
        subtaskSummaries: string
        lastReviewNotes: string
    }> {
        let currentSubtasks = subtasks
        let currentResults = subtaskResults

        const buildSubtaskSummaries = (results: WorkflowResult[]): string =>
            results
                .map((r, i) => {
                    const lastArtifact = r.artifacts[r.artifacts.length - 1]
                    return `Subtask ${i + 1}: ${lastArtifact?.content?.slice(0, 200) ?? "completed"}`
                })
                .join("\n\n")

        const buildCoordinatorContext = (
            summaries: string,
            reviewNotes?: string
        ): string => {
            const base = [
                `Original task: ${originalDescription}`,
                `\nCompleted subtasks:\n${summaries}`,
                "\nMerge the results and verify coherence. Run the full test suite.",
            ].join("\n")
            if (reviewNotes) {
                return `${base}\n\nPrevious verification found issues. Fix them:\n${reviewNotes}`
            }
            return base
        }

        let subtaskSummaries = buildSubtaskSummaries(currentResults)
        let coordinatorContext = buildCoordinatorContext(subtaskSummaries)
        let coordinatorResult = await this.deps.runAgent(
            "coordinator",
            coordinatorContext,
            undefined,
            undefined,
            depth
        )
        artifacts.push(coordinatorResult.artifact)

        let cycle = 0
        const qaDidNotPass =
            coordinatorResult.status === "needs_review" ||
            coordinatorResult.status === "failed"
        let lastReviewNotes =
            (coordinatorResult.artifact.metadata?.review_notes as string) ?? ""

        while (qaDidNotPass && cycle < this.deps.maxCompositeCycles) {
            cycle++
            log.workflow(
                "Composite QA did not pass — management cycle %d/%d",
                cycle,
                this.deps.maxCompositeCycles
            )
            this.deps.eventBus.emit({
                type: "composite_cycle:start",
                cycle,
                maxCycles: this.deps.maxCompositeCycles,
            })

            let stewardAction = await this.escalation.runStewardAndParse(
                originalDescription,
                plan,
                currentResults,
                coordinatorResult,
                lastReviewNotes,
                depth
            )

            if (!stewardAction || stewardAction.action === "escalate") {
                if (depth === 0) {
                    const oracleAction = await this.escalation.runOracle(
                        originalDescription,
                        plan,
                        currentResults,
                        coordinatorResult,
                        lastReviewNotes
                    )
                    if (
                        oracleAction?.action === "nudge_root_steward" &&
                        oracleAction.nudgeMessage
                    ) {
                        stewardAction =
                            await this.escalation.runStewardAndParse(
                                originalDescription,
                                plan,
                                currentResults,
                                coordinatorResult,
                                lastReviewNotes,
                                depth,
                                oracleAction.nudgeMessage
                            )
                    } else if (oracleAction?.action === "retry_once") {
                        stewardAction = { action: "retry_merge" }
                    }
                }
                if (!stewardAction || stewardAction.action === "escalate") {
                    return {
                        coordinatorResult: {
                            ...coordinatorResult,
                            status: "needs_review",
                        },
                        subtaskSummaries,
                        lastReviewNotes,
                    }
                }
            }

            if (stewardAction.action === "retry_merge") {
                coordinatorContext = buildCoordinatorContext(
                    subtaskSummaries,
                    lastReviewNotes
                )
                coordinatorResult = await this.deps.runAgent(
                    "coordinator",
                    coordinatorContext,
                    undefined,
                    undefined,
                    depth
                )
                artifacts.push(coordinatorResult.artifact)
                lastReviewNotes =
                    (coordinatorResult.artifact.metadata
                        ?.review_notes as string) ?? ""
                if (coordinatorResult.status === "completed") {
                    return {
                        coordinatorResult,
                        subtaskSummaries,
                        lastReviewNotes,
                    }
                }
                continue
            }

            if (stewardAction.action === "retry_children") {
                const indices = stewardAction.taskIndices ?? []
                const focus = stewardAction.retryFocus ?? ""
                const totalWithSetup =
                    (plan.setupTask ? 1 : 0) + currentSubtasks.length
                for (const i of indices) {
                    if (i < 0 || i >= currentSubtasks.length) continue
                    const subtask = currentSubtasks[i]
                    const subtaskId = randomUUID()
                    this.deps.eventBus.emit({
                        type: "subtask:start",
                        taskId,
                        subtaskId,
                        description: subtask.description,
                        index: i + (plan.setupTask ? 1 : 0),
                        total: totalWithSetup,
                    })
                    const baseContext = `Subtask of: ${originalDescription}`
                    const parentContext = focus
                        ? `${baseContext}\n\n${formatStewardVoice(focus)}`
                        : baseContext
                    const result = await this.deps.runTask({
                        description: subtask.description,
                        depth: depth + 1,
                        fileScope: subtask.fileScope,
                        skipAnalysis: subtask.skipAnalysis,
                        parentContext,
                        subtaskId,
                    })
                    this.deps.eventBus.emit({
                        type: "subtask:complete",
                        subtaskId,
                        status: result.status,
                    })
                    currentResults[i] = result
                    artifacts.push(...result.artifacts)
                }
                subtaskSummaries = buildSubtaskSummaries(currentResults)
                coordinatorContext = buildCoordinatorContext(subtaskSummaries)
                coordinatorResult = await this.deps.runAgent(
                    "coordinator",
                    coordinatorContext,
                    undefined,
                    undefined,
                    depth
                )
                artifacts.push(coordinatorResult.artifact)
                lastReviewNotes =
                    (coordinatorResult.artifact.metadata
                        ?.review_notes as string) ?? ""
                if (coordinatorResult.status === "completed") {
                    return {
                        coordinatorResult,
                        subtaskSummaries,
                        lastReviewNotes,
                    }
                }
                continue
            }

            if (stewardAction.action === "add_fix_task") {
                const fixDescription =
                    stewardAction.fixDescription ?? lastReviewNotes
                const fixSubtaskId = randomUUID()
                const totalWithSetup =
                    (plan.setupTask ? 1 : 0) + currentSubtasks.length
                this.deps.eventBus.emit({
                    type: "subtask:start",
                    taskId,
                    subtaskId: fixSubtaskId,
                    description: fixDescription,
                    index: totalWithSetup,
                    total: totalWithSetup + 1,
                })
                const fixResult = await this.deps.runTask({
                    description: fixDescription,
                    depth: depth + 1,
                    skipAnalysis: true,
                    parentContext: `Fix task for: ${originalDescription}\n\n${formatStewardVoice(fixDescription)}`,
                    subtaskId: fixSubtaskId,
                })
                this.deps.eventBus.emit({
                    type: "subtask:complete",
                    subtaskId: fixSubtaskId,
                    status: fixResult.status,
                })
                currentResults = [...currentResults, fixResult]
                artifacts.push(...fixResult.artifacts)
                subtaskSummaries = buildSubtaskSummaries(currentResults)
                coordinatorContext = buildCoordinatorContext(subtaskSummaries)
                coordinatorResult = await this.deps.runAgent(
                    "coordinator",
                    coordinatorContext,
                    undefined,
                    undefined,
                    depth
                )
                artifacts.push(coordinatorResult.artifact)
                lastReviewNotes =
                    (coordinatorResult.artifact.metadata
                        ?.review_notes as string) ?? ""
                if (coordinatorResult.status === "completed") {
                    return {
                        coordinatorResult,
                        subtaskSummaries,
                        lastReviewNotes,
                    }
                }
                continue
            }

            if (stewardAction.action === "re_decompose") {
                const plannerContext = `Re-decompose this task:\n${originalDescription}`
                const plannerResult = await this.deps.runAgent(
                    "planner",
                    plannerContext,
                    undefined,
                    undefined,
                    depth
                )
                artifacts.push(plannerResult.artifact)
                const newPlan = parsePlannerOutput(plannerResult)
                if (newPlan?.type === "decomposition") {
                    currentSubtasks = this.filterDuplicateSetupSubtask(newPlan)
                    const newParallel =
                        newPlan.parallel &&
                        !this.haveOverlappingFileScopes(currentSubtasks)
                    const newTotal =
                        (newPlan.setupTask ? 1 : 0) + currentSubtasks.length
                    currentResults = await this.runSubtasks(
                        currentSubtasks,
                        newParallel,
                        newPlan,
                        taskId,
                        originalDescription,
                        depth,
                        newTotal
                    )
                    for (const sr of currentResults) {
                        artifacts.push(...sr.artifacts)
                    }
                    const anyNewFailed = currentResults.some(
                        (r) => r.status === "failed"
                    )
                    if (anyNewFailed) {
                        return {
                            coordinatorResult: {
                                ...coordinatorResult,
                                status: "failed",
                            },
                            subtaskSummaries,
                            lastReviewNotes,
                        }
                    }
                    subtaskSummaries = buildSubtaskSummaries(currentResults)
                    coordinatorContext =
                        buildCoordinatorContext(subtaskSummaries)
                    coordinatorResult = await this.deps.runAgent(
                        "coordinator",
                        coordinatorContext,
                        undefined,
                        undefined,
                        depth
                    )
                    artifacts.push(coordinatorResult.artifact)
                    lastReviewNotes =
                        (coordinatorResult.artifact.metadata
                            ?.review_notes as string) ?? ""
                    if (coordinatorResult.status === "completed") {
                        return {
                            coordinatorResult,
                            subtaskSummaries,
                            lastReviewNotes,
                        }
                    }
                }
            }
        }

        return { coordinatorResult, subtaskSummaries, lastReviewNotes }
    }

    private async runFinalOracleEscalation(
        originalDescription: string,
        plan: Extract<PlannerOutput, { type: "decomposition" }>,
        subtaskResults: WorkflowResult[],
        coordinatorResult: AgentResult,
        lastReviewNotes: string,
        subtaskSummaries: string,
        depth: number,
        artifacts: Artifact[]
    ): Promise<WorkflowResult | null> {
        const buildCoordinatorContext = (
            summaries: string,
            reviewNotes?: string
        ): string => {
            const base = [
                `Original task: ${originalDescription}`,
                `\nCompleted subtasks:\n${summaries}`,
                "\nMerge the results and verify coherence. Run the full test suite.",
            ].join("\n")
            if (reviewNotes) {
                return `${base}\n\nPrevious verification found issues. Fix them:\n${reviewNotes}`
            }
            return base
        }

        const oracleAction = await this.escalation.runOracle(
            originalDescription,
            plan,
            subtaskResults,
            coordinatorResult,
            lastReviewNotes
        )
        if (
            oracleAction?.action === "nudge_root_steward" &&
            oracleAction.nudgeMessage
        ) {
            const withNudge = await this.escalation.runStewardAndParse(
                originalDescription,
                plan,
                subtaskResults,
                coordinatorResult,
                lastReviewNotes,
                0,
                oracleAction.nudgeMessage
            )
            if (withNudge?.action === "retry_merge") {
                const ctx = buildCoordinatorContext(
                    subtaskSummaries,
                    lastReviewNotes
                )
                const retryResult = await this.deps.runAgent(
                    "coordinator",
                    ctx,
                    undefined,
                    undefined,
                    depth
                )
                artifacts.push(retryResult.artifact)
                if (retryResult.status === "completed") {
                    return {
                        status: "completed",
                        artifacts,
                        agentResults: this.deps.allAgentResults,
                    }
                }
            }
        } else if (oracleAction?.action === "retry_once") {
            const ctx = buildCoordinatorContext(
                subtaskSummaries,
                lastReviewNotes
            )
            const retryResult = await this.deps.runAgent(
                "coordinator",
                ctx,
                undefined,
                undefined,
                depth
            )
            artifacts.push(retryResult.artifact)
            if (retryResult.status === "completed") {
                return {
                    status: "completed",
                    artifacts,
                    agentResults: this.deps.allAgentResults,
                }
            }
        }
        return null
    }

    private async maybeOversightCheckIn(): Promise<void> {
        if (!this.deps.oversightTracker) return
        const signals = this.deps.oversightTracker.getSignals()
        const lastOutcome = this.deps.oversightTracker.getLastNudgeOutcome()
        if (Object.keys(signals).length === 0 && !lastOutcome) return

        const ctx = this.compositeOversightContext
        if (!ctx) return

        const probability =
            Object.keys(signals).length > 0
                ? 1
                : (this.deps.config.oversightProbability ?? 0.25)
        if (Math.random() >= probability) return
        const maxPer = this.deps.config.maxOversightPerComposite ?? 2
        if (this.oversightCycleCount >= maxPer) return
        const nextDesc =
            ctx.subtaskDescriptions[ctx.currentSubtaskIndex] ?? "next subtask"
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
        const stewardResult = await this.deps.runAgent(
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
        this.oversightCycleCount += 1
        this.deps.eventBus.emit({
            type: "oversight:check_in",
            depth: ctx.depth,
            subtaskIndex: ctx.currentSubtaskIndex,
            hasNudge: !!nudge,
        })
    }
}
