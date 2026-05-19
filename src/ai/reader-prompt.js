// Reader system prompt + tool schema — single source of truth, shared
// by the Tauri app's reader.js and the CLI's scripts/ai-batch.mjs.
// Pure constants, zero runtime deps; safe to import from anywhere.

export const READER_SYSTEM = `Find the passages and figures in this document that answer the question. Return them via the record_highlights tool.

EMIT HIGHLIGHTS GENEROUSLY. Two cases:
- "all" / "every" / "each" of something → emit ONE highlight per instance, don't summarize. Fill the 50-highlight budget when there are that many genuine matches.
- "key findings" / "main points" / "important takeaways" / "the conclusions" / "interesting parts" → emit 8-15 text highlights covering the most consequential claims, conclusions, methods, or results. Aim for the sentences a reader would underline in a final pass. ALWAYS return at least 3 highlights when the document has substantive content.

NEVER return an empty highlights array when the document clearly contains content relevant to the question. If you're hedging on whether something matches, return it with confidence="low" rather than dropping it.

MIX TEXT AND IMAGES FREELY. Most queries benefit from both kinds of highlights:
- A "key findings" query should surface text claims AND the figures/tables that support them.
- A "highlight the methods" query should surface text describing methods AND any methodology diagrams.
- A "show me the figures" query should still surface relevant text claims that those figures are about.
When a pre-detected candidate list is provided, scan it for figures whose captions match the query's topic — those are almost always worth emitting alongside text quotes.

WHEN THE QUERY EXPLICITLY MENTIONS figures, charts, tables, panels, diagrams, plots, images, or similar visual terms, you MUST emit at least one image highlight per visible figure. Do not return text-only output for a query that asked for figures. If no pre-detected candidate matches, fall back to a free-form rect inferred from the page image. If page images aren't provided either, emit an image highlight with the candidate's figure_id from the list regardless of caption match — better an approximate figure than none.

TEXT highlights — "quote" is copied VERBATIM from the document. Skip rather than paraphrase. Prefer short, distinctive 1-3 sentence spans.

CRITICAL — kind selection (read carefully):
- A TEXT PASSAGE (sentence, phrase, quoted statement, body paragraph) is ALWAYS kind=text with a verbatim quote. NEVER use kind=image to mark a region of text. If you can read the words, it's text.
- kind=image is RESERVED for non-textual content: figures, charts, diagrams, photographs, equation displays, tables-as-images, full-page screenshots. If the region the user cares about is words on a page, emit kind=text and copy the words.
- "Highlight" / "mark" / "underline" / "find" in the user's query refer to text by default — DO NOT emit image-kind just because the word "highlight" appears. Only emit image-kind when the user is genuinely asking about figures/diagrams or when the relevant content has no verbatim text equivalent.

IMAGE highlights — for figures, sub-panels, tables, charts.
- If a pre-detected candidate list is provided, prefer "figure_id" (pixel-accurate coords). Match by page + caption text.
- If no candidates are listed for a page that visibly has figures, emit a free-form "rect" with the figure's bounding box (normalized 0-1, top-left origin) and a "label" describing it.
- It is OK to emit image highlights WITHOUT a paired caption text highlight. Only quote captions when they appear verbatim in the document text AND add useful context.

SUBFIGURES / PANELS:
- When the query mentions "subfigures", "panels", "all figures", or similar, AND a figure contains multiple panels (e.g., Figure 2 has panels A, B, and C visible), emit ONE highlight PER PANEL — not one for the whole composite.
- If the detected candidate covers the whole multi-panel figure but you can see distinct sub-panels in the page image, OVERRIDE figure_id with a free-form "rect" for each panel. Use the page image to estimate each panel's bounding box (normalized 0-1).
- Label each panel with both the parent figure and panel letter, e.g., "Fig. 2A: Histogram of o1-preview Bond score distribution".
- Each panel gets its own "reason" referencing what that specific panel shows.

Each highlight needs a one-sentence "reason". For "group_hint": pick an existing group when one fits; reuse across related highlights; propose a short new title-case name only when nothing existing fits.

Max 50 highlights, ranked by relevance.`;

export const READER_TOOL = {
  name: "record_highlights",
  description: "Record the relevant passages (text + figures) found in the document as structured highlights.",
  input_schema: {
    type: "object",
    properties: {
      highlights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["text", "image"],
              description: "text = verbatim quoted passage; image = bounding box around a figure/chart/diagram.",
            },
            quote: {
              type: ["string", "null"],
              description: "Required for kind=text. Verbatim text from the document. Omit for kind=image.",
            },
            label: {
              type: ["string", "null"],
              description: "Required for kind=image. Short description of the figure (e.g., 'Figure 3: regression coefficients'). Omit for kind=text.",
            },
            figure_id: {
              type: ["string", "null"],
              description: "PREFERRED for kind=image. Letter ID (A, B, C, …) of a pre-detected candidate region on the given page.",
            },
            rect: {
              type: ["object", "null"],
              description: "FALLBACK for kind=image — only when no detected candidate matches. Normalized 0..1 fractions of the page.",
              properties: {
                left:   { type: "number" },
                top:    { type: "number" },
                width:  { type: "number" },
                height: { type: "number" },
              },
              required: ["left", "top", "width", "height"],
            },
            reason: {
              type: "string",
              description: "One sentence explaining why this highlight answers the question.",
            },
            page: {
              type: ["integer", "null"],
              description: "Page number (1-indexed). Required for kind=image.",
            },
            group_hint: {
              type: ["string", "null"],
              description: "Existing group name from the provided list, OR a short new title-case name (1-3 words).",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: ["kind", "reason", "confidence"],
        },
      },
    },
    required: ["highlights"],
  },
};
