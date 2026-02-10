import { Orchestrator } from "./orchestrator/Orchestrator.js"
import type { BabylonConfig, RunResult } from "./types.js"

export class BabylonScriptorium {
    private readonly stallion: Orchestrator

    constructor(config: BabylonConfig) {
        this.stallion = new Orchestrator(config)
    }

    public async run(description: string): Promise<RunResult> {
        return this.stallion.run(description)
    }

    public abort(): void {
        this.stallion.abort()
    }
}

export type {
    AgentCostEntry,
    AgentResult,
    AgentRole,
    Artifact,
    BabylonConfig,
    CostBreakdown,
    RunResult,
    TokenUsage,
    WorkflowCostSummary,
} from "./types.js"
