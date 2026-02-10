import type { CostBreakdown, TokenUsage } from "../types.js"
import { log } from "./Logger.js"

export interface ModelPricing {
    inputPerMillion: number
    outputPerMillion: number
}

const DEFAULT_PRICING: ModelPricing = {
    inputPerMillion: 3,
    outputPerMillion: 15,
}

const MODEL_PRICING: Record<string, ModelPricing> = {
    "claude-sonnet-4-20250514": {
        inputPerMillion: 3,
        outputPerMillion: 15,
    },
    "claude-opus-4-20250514": {
        inputPerMillion: 15,
        outputPerMillion: 75,
    },
    "claude-haiku-3-20250514": {
        inputPerMillion: 0.25,
        outputPerMillion: 1.25,
    },
    "gpt-4o": {
        inputPerMillion: 2.5,
        outputPerMillion: 10,
    },
    "gpt-4o-mini": {
        inputPerMillion: 0.15,
        outputPerMillion: 0.6,
    },
    "gpt-4.1": {
        inputPerMillion: 2,
        outputPerMillion: 8,
    },
    "gpt-4.1-mini": {
        inputPerMillion: 0.4,
        outputPerMillion: 1.6,
    },
    "gpt-4.1-nano": {
        inputPerMillion: 0.1,
        outputPerMillion: 0.4,
    },
}

export function getModelPricing(model: string): ModelPricing {
    const pricing = MODEL_PRICING[model]
    if (pricing) return pricing

    const partialMatch = Object.keys(MODEL_PRICING).find((key) =>
        model.startsWith(key)
    )
    if (partialMatch) return MODEL_PRICING[partialMatch]

    log.app("Unknown model %s, using default pricing", model)
    return DEFAULT_PRICING
}

export function calculateCost(model: string, usage: TokenUsage): CostBreakdown {
    const pricing = getModelPricing(model)
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion
    const outputCost =
        (usage.completionTokens / 1_000_000) * pricing.outputPerMillion
    return {
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
    }
}

export function formatCost(cost: number): string {
    if (cost < 0.01) return `$${cost.toFixed(4)}`
    return `$${cost.toFixed(2)}`
}
