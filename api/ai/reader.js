// Vercel serverless function: POST /api/ai/reader
// Authenticated Gemini proxy for the private beta. See api/_reader-handler.js
// for the shared logic (also run as a Vite dev middleware for local testing).
//
// Required env (set in the Vercel project + .env.local for local dev):
//   CLERK_SECRET_KEY   — verifies the caller's Clerk session
//   GEMINI_API_KEY     — server-held Gemini key (never shipped to the browser)
//   GEMINI_MODEL       — optional; pins the model (default gemini-2.5-flash)
//
// Note: Vercel serverless request bodies are capped (~4.5MB). Very large PDFs
// sent as base64 can exceed that; beta-sized documents are fine.
import { handleReader } from "../_reader-handler.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const result = await handleReader({
    token,
    body: req.body,
    secretKey: process.env.CLERK_SECRET_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  });
  res.status(result.status).json(result.json);
}
