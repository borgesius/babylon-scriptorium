import Anthropic from "@anthropic-ai/sdk"

import { LLMError } from "../core/errors.js"
import type {
    LLMMessage,
    LLMProvider,
    LLMResponse,
    LLMToolCall,
    ModelConfig,
    TokenUsage,
    ToolDefinition,
} from "../types.js"

export class AnthropicProvider implements LLMProvider {
    private client: Anthropic

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey })
    }

    public async chat(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        model: ModelConfig
    ): Promise<LLMResponse> {
        try {
            const { system, anthropicMessages } = convertMessages(messages)
            const anthropicTools =
                tools.length > 0 ? tools.map(toAnthropicTool) : undefined

            const response = await this.client.messages.create({
                model: model.model,
                system: system || undefined,
                messages: anthropicMessages,
                tools: anthropicTools,
                temperature: model.temperature,
                max_tokens: model.maxTokens ?? 4096,
            })

            let textContent = ""
            const toolCalls: LLMToolCall[] = []

            for (const block of response.content) {
                if (block.type === "text") {
                    textContent += block.text
                } else if (block.type === "tool_use") {
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        arguments: block.input as Record<string, unknown>,
                    })
                }
            }

            const usage: TokenUsage = {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens:
                    response.usage.input_tokens + response.usage.output_tokens,
            }

            let stopReason: LLMResponse["stopReason"] = "end_turn"
            if (response.stop_reason === "tool_use") {
                stopReason = "tool_use"
            } else if (response.stop_reason === "max_tokens") {
                stopReason = "max_tokens"
            }

            return {
                content: textContent || null,
                toolCalls,
                usage,
                stopReason,
            }
        } catch (error) {
            if (error instanceof LLMError) throw error
            throw new LLMError(
                `Anthropic API error: ${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error : undefined
            )
        }
    }
}

interface ConvertedMessages {
    system: string
    anthropicMessages: Anthropic.MessageParam[]
}

function convertMessages(messages: LLMMessage[]): ConvertedMessages {
    let system = ""
    const anthropicMessages: Anthropic.MessageParam[] = []

    for (const msg of messages) {
        if (msg.role === "system") {
            system += (system ? "\n\n" : "") + msg.content
            continue
        }

        if (msg.role === "user") {
            anthropicMessages.push({ role: "user", content: msg.content })
            continue
        }

        if (msg.role === "tool") {
            const toolResultBlock: Anthropic.ToolResultBlockParam = {
                type: "tool_result",
                tool_use_id: msg.toolCallId ?? "",
                content: msg.content,
            }
            const lastMsg = anthropicMessages[anthropicMessages.length - 1]
            if (
                lastMsg &&
                lastMsg.role === "user" &&
                Array.isArray(lastMsg.content)
            ) {
                lastMsg.content.push(toolResultBlock)
            } else {
                anthropicMessages.push({
                    role: "user",
                    content: [toolResultBlock],
                })
            }
            continue
        }

        const contentBlocks: Anthropic.ContentBlockParam[] = []
        if (msg.content) {
            contentBlocks.push({ type: "text", text: msg.content })
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const tc of msg.toolCalls) {
                contentBlocks.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.name,
                    input: tc.arguments,
                })
            }
        }
        if (contentBlocks.length > 0) {
            anthropicMessages.push({
                role: "assistant",
                content: contentBlocks,
            })
        }
    }

    return { system, anthropicMessages }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as unknown as Anthropic.Tool.InputSchema,
    }
}
