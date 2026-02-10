import type { EventBus } from "../events/EventBus.js"
import type { TaskBotEvent } from "../events/types.js"

export interface OversightSignals {
    repeatedSameTool?: string
    longStepDurationMs?: number
    stepFailedOrNeedsReview?: boolean
}

export interface OversightThresholds {
    repeatedToolCount: number
    longStepSeconds: number
}

const DEFAULT_THRESHOLDS: OversightThresholds = {
    repeatedToolCount: 3,
    longStepSeconds: 90,
}

interface StepData {
    toolCalls: string[]
    durationMs?: number
    status?: string
}

export class OversightTracker {
    private readonly agentIdToStepId = new Map<string, string>()
    private readonly stepData = new Map<string, StepData>()
    private lastSignals: OversightSignals = {}
    private lastNudgeOutcome: { nudge: string; outcome: string } | null = null
    private readonly thresholds: OversightThresholds
    private handler: ((event: TaskBotEvent) => void) | null = null

    constructor(
        private readonly eventBus: EventBus,
        thresholds?: Partial<OversightThresholds>
    ) {
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
    }

    public attach(): void {
        if (this.handler) return
        this.handler = (event: TaskBotEvent): void => this.onEvent(event)
        this.eventBus.on(this.handler)
    }

    public detach(): void {
        if (this.eventBus && this.handler) {
            this.eventBus.off(this.handler)
        }
        this.handler = null
    }

    private onEvent(event: TaskBotEvent): void {
        switch (event.type) {
            case "step:start":
                this.stepData.set(event.stepId, { toolCalls: [] })
                break
            case "agent:spawn":
                if (event.stepId) {
                    this.agentIdToStepId.set(event.agentId, event.stepId)
                }
                break
            case "agent:tool_call": {
                const stepId = this.agentIdToStepId.get(event.agentId)
                if (stepId) {
                    const data = this.stepData.get(stepId)
                    if (data) {
                        data.toolCalls.push(event.toolName)
                    }
                }
                break
            }
            case "step:complete": {
                const data = this.stepData.get(event.stepId)
                if (data) {
                    data.durationMs = event.duration
                    data.status = event.status
                    this.lastSignals = this.deriveSignals(data)
                    this.stepData.delete(event.stepId)
                }
                this.agentIdToStepId.forEach((sid, aid) => {
                    if (sid === event.stepId) {
                        this.agentIdToStepId.delete(aid)
                    }
                })
                break
            }
            default:
                break
        }
    }

    private deriveSignals(data: StepData): OversightSignals {
        const signals: OversightSignals = {}
        if (data.toolCalls.length >= this.thresholds.repeatedToolCount) {
            const last = data.toolCalls.slice(
                -this.thresholds.repeatedToolCount
            )
            const allSame =
                last.length === this.thresholds.repeatedToolCount &&
                new Set(last).size === 1
            if (allSame) {
                signals.repeatedSameTool = last[0] ?? ""
            }
        }
        if (
            data.durationMs != null &&
            data.durationMs > this.thresholds.longStepSeconds * 1000
        ) {
            signals.longStepDurationMs = data.durationMs
        }
        if (data.status === "failed" || data.status === "needs_review") {
            signals.stepFailedOrNeedsReview = true
        }
        return signals
    }

    public getSignals(): OversightSignals {
        return { ...this.lastSignals }
    }

    public clearSignals(): void {
        this.lastSignals = {}
    }

    public recordNudgeOutcome(nudge: string, outcome: string): void {
        this.lastNudgeOutcome = { nudge, outcome }
    }

    public getLastNudgeOutcome(): { nudge: string; outcome: string } | null {
        return this.lastNudgeOutcome
    }
}
