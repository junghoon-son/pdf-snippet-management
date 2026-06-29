// Single switch that gates every AI entry point in the UI. The web build
// routes AI through the authenticated /api/ai/reader proxy (Gemini Flash,
// gated by the Clerk session), so the "Ask" surface is enabled. The legacy
// BYOK key UI stays removed — credentials live server-side now.
export const AI_ENABLED = true;

export function isAiEnabled() {
  return AI_ENABLED === true;
}
