import { LogRenderer } from "./LogRenderer.js"
import { TerminalRenderer } from "./TerminalRenderer.js"
import type { CreateRendererOptions, Renderer } from "./types.js"

export type RendererType = "terminal" | "log" | "none"

export function createRenderer(
    type: RendererType,
    options?: CreateRendererOptions
): Renderer | null {
    switch (type) {
        case "terminal":
            return new TerminalRenderer(options)
        case "log":
            return new LogRenderer()
        case "none":
            return null
    }
}

export { LogRenderer } from "./LogRenderer.js"
export { TerminalRenderer } from "./TerminalRenderer.js"
export type {
    CreateRendererOptions,
    Renderer,
    RenderNode,
    RenderNodeStatus,
} from "./types.js"
