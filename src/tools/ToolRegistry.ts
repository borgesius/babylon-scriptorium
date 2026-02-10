import type { AgentRole, ToolDefinition } from "../types.js"
import { getToolsForRole } from "./definitions.js"

export class ToolRegistry {
    private overrides: Map<AgentRole, ToolDefinition[]> = new Map()

    public getTools(role: AgentRole): ToolDefinition[] {
        return this.overrides.get(role) ?? getToolsForRole(role)
    }

    public setTools(role: AgentRole, tools: ToolDefinition[]): void {
        this.overrides.set(role, tools)
    }
}
