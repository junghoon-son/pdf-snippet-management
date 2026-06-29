// Web figure/region detector — calls the authenticated /api/ai/segment proxy
// (Gemini Flash vision) and returns the SAME candidate shape as the desktop's
// runOnnxLayout, so it's a drop-in in the extraction flow:
//   [{ page, candidates: [{ id, left, top, width, height, label, source }] }]
//
// Pages are sent in small batches: one Gemini vision call runs per page, and
// batching keeps each request well under Vercel's ~4.5MB serverless body cap.
// pageCap bounds cost (1 call/page/query) and request size on large docs.

export async function runGeminiSegment(pageImages, { pageCap = 10, batchSize = 4 } = {}) {
  const token = await window.Clerk?.session?.getToken?.();
  if (!token) throw new Error("You're signed out — sign in to use AI.");

  const pages = (pageImages || [])
    .filter((p) => p && p.base64)
    .slice(0, pageCap)
    .map((p) => ({ page: p.page, base64: p.base64, mimeType: "image/png" }));
  if (!pages.length) return [];

  const detections = [];
  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const res = await fetch("/api/ai/segment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pages: batch }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
      throw new Error(`segment proxy ${res.status}: ${detail}`);
    }
    const json = await res.json();
    if (Array.isArray(json.detections)) detections.push(...json.detections);
  }
  return detections;
}
