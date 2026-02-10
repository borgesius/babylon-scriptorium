export class TaskBotError extends Error {
    public readonly code: string
    public override readonly cause?: Error

    constructor(message: string, code: string, cause?: Error) {
        super(message)
        this.name = "TaskBotError"
        this.code = code
        this.cause = cause
    }
}

export class LLMError extends TaskBotError {
    constructor(message: string, cause?: Error) {
        super(message, "LLM_ERROR", cause)
        this.name = "LLMError"
    }
}

export class ToolExecutionError extends TaskBotError {
    public readonly toolName: string

    constructor(toolName: string, message: string, cause?: Error) {
        super(message, "TOOL_ERROR", cause)
        this.name = "ToolExecutionError"
        this.toolName = toolName
    }
}

export class WorkflowError extends TaskBotError {
    constructor(message: string, cause?: Error) {
        super(message, "WORKFLOW_ERROR", cause)
        this.name = "WorkflowError"
    }
}

export class ConfigError extends TaskBotError {
    constructor(message: string) {
        super(message, "CONFIG_ERROR")
        this.name = "ConfigError"
    }
}
