import type { AgentRole } from "../types.js"

export const ROLE_LABELS: Record<AgentRole, string> = {
    analyzer: "Librarian",
    planner: "Cartographer",
    executor: "Dreamer",
    reviewer: "Mirror",
    coordinator: "Aleph",
    steward: "Steward",
    oracle: "Oracle",
}

export function getRoleLabel(role: AgentRole): string {
    return ROLE_LABELS[role] ?? role
}
