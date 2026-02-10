import { ConfigError } from "../core/errors.js"
import type { LLMProvider, LLMProviderType } from "../types.js"
import { AnthropicProvider } from "./AnthropicProvider.js"
import { OpenAIProvider } from "./OpenAIProvider.js"

export function createLLMProvider(
    type: LLMProviderType,
    apiKey: string
): LLMProvider {
    if (!apiKey) {
        throw new ConfigError(`API key required for ${type} provider`)
    }
    switch (type) {
        case "openai":
            return new OpenAIProvider(apiKey)
        case "anthropic":
            return new AnthropicProvider(apiKey)
    }
}

export { AnthropicProvider } from "./AnthropicProvider.js"
export { OpenAIProvider } from "./OpenAIProvider.js"
