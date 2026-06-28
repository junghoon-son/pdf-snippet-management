// Single switch that gates every AI entry point in the UI. Phase 1 is a
// browser-only shell with NO backend / AI server, so the "Ask" surface and
// the BYOK key UI are hidden. Phase 2 flips AI_ENABLED to true once the
// server proxy exists — reader.js / planner.js / providers.js stay intact
// behind this flag and are reused then.
export const AI_ENABLED = false;

export function isAiEnabled() {
  return AI_ENABLED === true;
}
