import type { AgentRole, LLMProviderType, ModelConfig } from "../types.js"

const DEFAULT_MODELS: Record<AgentRole, ModelConfig> = {
    analyzer: {
        provider: "anthropic",
        model: "claude-haiku-3-20250514",
        temperature: 0.3,
        maxTokens: 4096,
    },
    planner: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.5,
        maxTokens: 8192,
    },
    executor: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.2,
        maxTokens: 16384,
    },
    reviewer: {
        provider: "openai",
        model: "gpt-4o",
        temperature: 0.1,
        maxTokens: 8192,
    },
    coordinator: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.4,
        maxTokens: 8192,
    },
    steward: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.2,
        maxTokens: 4096,
    },
    oracle: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.1,
        maxTokens: 2048,
    },
}

const DEFAULT_MAX_TURNS: Record<AgentRole, number> = {
    analyzer: 5,
    planner: 8,
    executor: 20,
    reviewer: 8,
    coordinator: 10,
    steward: 3,
    oracle: 2,
}

export function getDefaultModel(
    role: AgentRole,
    overrideProvider?: LLMProviderType,
    overrideModel?: string
): ModelConfig {
    const base = DEFAULT_MODELS[role]
    return {
        ...base,
        provider: overrideProvider ?? base.provider,
        model: overrideModel ?? base.model,
    }
}

export function getDefaultMaxTurns(role: AgentRole): number {
    return DEFAULT_MAX_TURNS[role]
}
