// Vercel serverless function: POST /api/ai/segment
// Authenticated Gemini-Flash figure/region detector. See api/_segment-handler.js
// for the shared logic (also run as a Vite dev middleware). Body:
//   { pages: [{ page: number, base64: string, mimeType?: string }] }
// Returns: { detections: [{ page, candidates: [{id,left,top,width,height,label,source}] }] }
//
// Reuses the same env as the reader proxy: CLERK_SECRET_KEY, GEMINI_API_KEY.
// Model precedence: GEMINI_SEGMENT_MODEL (so segmentation can use a stronger
// localizer like gemini-2.5-pro) → GEMINI_MODEL → handler default.
import { handleSegment } from "../_segment-handler.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const result = await handleSegment({
    token,
    pages: req.body?.pages,
    secretKey: process.env.CLERK_SECRET_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_SEGMENT_MODEL || process.env.GEMINI_MODEL,
  });
  res.status(result.status).json(result.json);
}
