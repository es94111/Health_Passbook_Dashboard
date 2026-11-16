// Shared readiness gate for the auto-running structured-AI pipelines (medical
// summary + safety alerts; moved here from medical-summary/ when the generation
// machinery was factored out). Model eligibility is intentionally absent: the
// user's auto-generate toggle applies to every selected model that survives
// provider/key gating in the caller's resolvedModelId.
export function shouldAutoRunSummarySlot(input: {
  enabled: boolean
  authLoading: boolean
  slotKey: string
  busy: boolean
  dataReady: boolean
  hasResult: boolean
  hydratedSlotKey: string | null
  autoRunIdentity: string
  triggeredIdentity: string | null
}) {
  return input.enabled &&
    !input.authLoading &&
    Boolean(input.slotKey) &&
    !input.busy &&
    input.dataReady &&
    !input.hasResult &&
    input.hydratedSlotKey === input.slotKey &&
    input.triggeredIdentity !== input.autoRunIdentity
}
