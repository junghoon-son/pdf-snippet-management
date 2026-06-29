// Shared AI-proxy handler — pure (no global env, no framework objects), so the
// SAME logic runs as the Vercel serverless function (api/ai/reader.js) AND as a
// Vite dev-server middleware (vite.config.js), giving local + prod parity.
//
// What it does for the private beta:
//   1. Verifies the caller's Clerk session token. Sign-ups are restricted to
//      the Clerk allowlist, so a valid session === an allowlisted beta tester.
//   2. Injects the server-held GEMINI_API_KEY and PINS the model server-side
//      (clients can't pick an expensive model).
//   3. Forwards the Gemini generateContent body and returns Gemini's JSON
//      unchanged — the client (gemini.js) still does the response translation.
//
// The "_" filename prefix tells Vercel this is a shared lib, not a route.
import { verifyToken } from "@clerk/backend";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";

export async function handleReader({ token, body, secretKey, geminiKey, model }) {
  if (!secretKey) {
    return { status: 500, json: { error: "server misconfigured: CLERK_SECRET_KEY not set" } };
  }
  if (!geminiKey) {
    return { status: 500, json: { error: "server misconfigured: GEMINI_API_KEY not set" } };
  }
  if (!token) {
    return { status: 401, json: { error: "missing session token" } };
  }
  try {
    // Throws on an invalid/expired signature. Allowlist enforcement happened
    // at sign-up, so any valid session is an authorized beta user.
    await verifyToken(token, { secretKey });
  } catch (e) {
    // Surface the real reason so 401s are diagnosable (token-expired vs
    // invalid-signature/instance-mismatch vs jwks issues).
    return {
      status: 401,
      json: {
        error: "invalid or expired session",
        reason: e?.reason || e?.message || String(e),
      },
    };
  }

  const useModel = model || DEFAULT_MODEL;
  const url = `${GEMINI_BASE}/${encodeURIComponent(useModel)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    return { status: 502, json: { error: "upstream request failed: " + (err?.message || "unknown") } };
  }
  const json = await res.json().catch(() => ({ error: "unparseable upstream response" }));
  return { status: res.status, json };
}
