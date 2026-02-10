import { randomUUID } from "node:crypto"

import type { FileStore } from "../persistence/FileStore.js"
import type {
    AgentRole,
    Artifact,
    TaskComplexity,
    TaskData,
    TaskStatus,
} from "../types.js"

export class TaskManager {
    private readonly store: FileStore
    private readonly tasks: Map<string, TaskData> = new Map()

    constructor(store: FileStore) {
        this.store = store
    }

    public async create(
        description: string,
        parentId?: string
    ): Promise<TaskData> {
        const now = new Date().toISOString()
        const task: TaskData = {
            id: randomUUID(),
            parentId,
            description,
            status: "pending",
            artifacts: [],
            subtaskIds: [],
            createdAt: now,
            updatedAt: now,
        }
        this.tasks.set(task.id, task)
        await this.persist(task)
        return task
    }

    public get(id: string): TaskData | undefined {
        return this.tasks.get(id)
    }

    public async updateStatus(
        id: string,
        status: TaskStatus
    ): Promise<TaskData | undefined> {
        const task = this.tasks.get(id)
        if (!task) return undefined
        task.status = status
        task.updatedAt = new Date().toISOString()
        await this.persist(task)
        return task
    }

    public async setComplexity(
        id: string,
        complexity: TaskComplexity
    ): Promise<void> {
        const task = this.tasks.get(id)
        if (!task) return
        task.complexity = complexity
        task.updatedAt = new Date().toISOString()
        await this.persist(task)
    }

    public async assignRole(id: string, role: AgentRole): Promise<void> {
        const task = this.tasks.get(id)
        if (!task) return
        task.assignedRole = role
        task.updatedAt = new Date().toISOString()
        await this.persist(task)
    }

    public async addArtifact(id: string, artifact: Artifact): Promise<void> {
        const task = this.tasks.get(id)
        if (!task) return
        task.artifacts.push(artifact)
        task.updatedAt = new Date().toISOString()
        await this.persist(task)
    }

    public async addSubtask(parentId: string, childId: string): Promise<void> {
        const task = this.tasks.get(parentId)
        if (!task) return
        task.subtaskIds.push(childId)
        task.updatedAt = new Date().toISOString()
        await this.persist(task)
    }

    public async load(id: string): Promise<TaskData | null> {
        const existing = this.tasks.get(id)
        if (existing) return existing
        const loaded = await this.store.read<TaskData>(`tasks/${id}`)
        if (loaded) {
            this.tasks.set(id, loaded)
        }
        return loaded
    }

    private async persist(task: TaskData): Promise<void> {
        await this.store.write(`tasks/${task.id}`, task)
    }
}
