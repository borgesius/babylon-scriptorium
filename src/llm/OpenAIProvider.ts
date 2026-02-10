import OpenAI from "openai"

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

export class OpenAIProvider implements LLMProvider {
    private client: OpenAI

    constructor(apiKey: string) {
        this.client = new OpenAI({ apiKey })
    }

    public async chat(
        messages: LLMMessage[],
        tools: ToolDefinition[],
        model: ModelConfig
    ): Promise<LLMResponse> {
        try {
            const openaiMessages = messages.map(toOpenAIMessage)
            const openaiTools =
                tools.length > 0 ? tools.map(toOpenAITool) : undefined

            const response = await this.client.chat.completions.create({
                model: model.model,
                messages: openaiMessages,
                tools: openaiTools,
                temperature: model.temperature,
                max_completion_tokens: model.maxTokens,
            })

            const choice = response.choices[0]
            if (!choice) {
                throw new LLMError("OpenAI returned no choices")
            }

            const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? [])
                .filter(
                    (tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall =>
                        tc.type === "function"
                )
                .map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments) as Record<
                        string,
                        unknown
                    >,
                }))

            const usage: TokenUsage = {
                promptTokens: response.usage?.prompt_tokens ?? 0,
                completionTokens: response.usage?.completion_tokens ?? 0,
                totalTokens: response.usage?.total_tokens ?? 0,
            }

            let stopReason: LLMResponse["stopReason"] = "end_turn"
            if (choice.finish_reason === "tool_calls") {
                stopReason = "tool_use"
            } else if (choice.finish_reason === "length") {
                stopReason = "max_tokens"
            }

            return {
                content: choice.message.content,
                toolCalls,
                usage,
                stopReason,
            }
        } catch (error) {
            if (error instanceof LLMError) throw error
            throw new LLMError(
                `OpenAI API error: ${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error : undefined
            )
        }
    }
}

function toOpenAIMessage(msg: LLMMessage): OpenAI.ChatCompletionMessageParam {
    if (msg.role === "system") {
        return { role: "system", content: msg.content }
    }
    if (msg.role === "user") {
        return { role: "user", content: msg.content }
    }
    if (msg.role === "tool") {
        return {
            role: "tool",
            tool_call_id: msg.toolCallId ?? "",
            content: msg.content,
        }
    }
    const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: msg.content || null,
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
            },
        }))
    }
    return assistantMsg
}

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as unknown as Record<string, unknown>,
        },
    }
}
