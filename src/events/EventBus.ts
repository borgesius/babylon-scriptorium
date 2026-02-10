import { EventEmitter } from "node:events"

import type { TaskBotEvent } from "./types.js"

type EventHandler = (event: TaskBotEvent) => void

export class EventBus {
    private emitter: EventEmitter = new EventEmitter()

    public on(handler: EventHandler): void {
        this.emitter.on("event", handler)
    }

    public emit(event: TaskBotEvent): void {
        this.emitter.emit("event", event)
    }

    public off(handler: EventHandler): void {
        this.emitter.off("event", handler)
    }

    public removeAllListeners(): void {
        this.emitter.removeAllListeners("event")
    }
}
