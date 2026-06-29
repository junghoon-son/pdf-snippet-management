// Shared AI-segmentation handler — pure, run by both the Vercel function
// (api/ai/segment.js) and the Vite dev middleware. Replaces the desktop's
// bundled ONNX RT-DETR detector (dead on web) with a Gemini Flash vision pass.
//
// Input: rendered page images. Output: the SAME candidate shape the old
// runOnnxLayout produced, so it's a drop-in for the extraction flow:
//   [{ page, candidates: [{ id, left, top, width, height, label, source }] }]
//
// Gemini returns boxes as box_2d = [ymin, xmin, ymax, xmax] normalized 0-1000;
// we descale to the app's fractional [0..1] {left,top,width,height}.
import { verifyToken } from "@clerk/backend";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PAGES = 12; // cost guard — one Gemini vision call per page
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const DETECT_PROMPT =
  "Detect every figure, chart, graph, plot, table, diagram, photograph, map, or " +
  "displayed equation on this document page. IGNORE running body text, headings, " +
  "page numbers, and headers/footers. For each region return box_2d as " +
  "[ymin, xmin, ymax, xmax] normalized to 0-1000, plus a short label (e.g. " +
  "\"Figure 2: regression plot\", \"Table 1\"). If multiple panels make up one " +
  "figure, box each panel separately. If the page has no figures, return [].";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    boxes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box_2d: { type: "array", items: { type: "integer" } },
          label: { type: "string" },
        },
        required: ["box_2d", "label"],
      },
    },
  },
  required: ["boxes"],
};

// box_2d [ymin, xmin, ymax, xmax] in 0..1000 → {left, top, width, height} in 0..1.
export function boxToRect(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = box.map((n) => Number(n) / 1000);
  if ([ymin, xmin, ymax, xmax].some((n) => Number.isNaN(n))) return null;
  const left = Math.max(0, Math.min(1, Math.min(xmin, xmax)));
  const top = Math.max(0, Math.min(1, Math.min(ymin, ymax)));
  const right = Math.max(0, Math.min(1, Math.max(xmin, xmax)));
  const bottom = Math.max(0, Math.min(1, Math.max(ymin, ymax)));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0.005 || height <= 0.005) return null; // drop degenerate boxes
  return { left, top, width, height };
}

async function detectPage({ base64, mimeType, geminiKey, model }) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mimeType || "image/png", data: base64 } },
          { text: DETECT_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 2048,
    },
  };
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`gemini ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { boxes: [] };
  }
  const boxes = Array.isArray(parsed.boxes) ? parsed.boxes : [];
  const candidates = [];
  for (const b of boxes) {
    const rect = boxToRect(b?.box_2d);
    if (!rect) continue;
    candidates.push({
      id: LETTERS[candidates.length] || `R${candidates.length}`,
      ...rect,
      label: typeof b?.label === "string" ? b.label : "",
      kind: "figure",
      source: "gemini",
    });
  }
  return candidates;
}

export async function handleSegment({ token, pages, secretKey, geminiKey, model }) {
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
    await verifyToken(token, { secretKey });
  } catch (e) {
    return {
      status: 401,
      json: { error: "invalid or expired session", reason: e?.reason || e?.message || String(e) },
    };
  }

  const list = Array.isArray(pages) ? pages.slice(0, MAX_PAGES) : [];
  if (!list.length) {
    return { status: 400, json: { error: "no pages provided" } };
  }
  const useModel = model || DEFAULT_MODEL;
  const detections = await Promise.all(
    list.map(async (p) => {
      try {
        const candidates = await detectPage({
          base64: p.base64,
          mimeType: p.mimeType,
          geminiKey,
          model: useModel,
        });
        return { page: p.page, candidates };
      } catch (err) {
        return { page: p.page, candidates: [], error: String(err?.message || err) };
      }
    }),
  );
  return { status: 200, json: { detections } };
}
