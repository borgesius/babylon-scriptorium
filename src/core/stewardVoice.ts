export const STEWARD_VOICE_PREFIX =
    "The Steward (voice of the scriptorium) reminds you: "

export function formatStewardVoice(nudge: string): string {
    if (!nudge.trim()) return ""
    return `${STEWARD_VOICE_PREFIX}${nudge.trim()}`
}
