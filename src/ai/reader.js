// Reader — single-doc semantic-highlight extraction.
//
// One LLM call with a `record_highlights` tool. The tool's input schema
// forces verbatim quoting + structured fields. Caller passes a query
// and the doc as plain text; gets back an array of suggestions.

import { callMessages } from "./providers.js";

// Minimal system prompt. The heavy lifting is done by:
//   - the tool-use schema (forces structured output)
//   - the per-query candidate list (Docling/Ollama identifies figures)
//   - the deterministic resolver (handles whitespace/dash/quote drift)
// We only need to tell Claude the load-bearing rules: verbatim quotes,
// prefer pre-detected candidates, route into existing groups.
const READER_SYSTEM = `Find the passages and figures in this document that answer the question. Return them via the record_highlights tool.

EMIT HIGHLIGHTS GENEROUSLY. Two cases:
- "all" / "every" / "each" of something → emit ONE highlight per instance, don't summarize. Fill the 15-highlight budget when there are that many genuine matches.
- "key findings" / "main points" / "important takeaways" / "the conclusions" / "interesting parts" → emit 5-10 text highlights covering the most consequential claims, conclusions, methods, or results. Aim for the sentences a reader would underline in a final pass. ALWAYS return at least 3 highlights when the document has substantive content.

NEVER return an empty highlights array when the document clearly contains content relevant to the question. If you're hedging on whether something matches, return it with confidence="low" rather than dropping it.

MIX TEXT AND IMAGES FREELY. Most queries benefit from both kinds of highlights:
- A "key findings" query should surface text claims AND the figures/tables that support them.
- A "highlight the methods" query should surface text describing methods AND any methodology diagrams.
- A "show me the figures" query should still surface relevant text claims that those figures are about.
When a pre-detected candidate list is provided, scan it for figures whose captions match the query's topic — those are almost always worth emitting alongside text quotes.

WHEN THE QUERY EXPLICITLY MENTIONS figures, charts, tables, panels, diagrams, plots, images, or similar visual terms, you MUST emit at least one image highlight per visible figure. Do not return text-only output for a query that asked for figures. If no pre-detected candidate matches, fall back to a free-form rect inferred from the page image. If page images aren't provided either, emit an image highlight with the candidate's figure_id from the list regardless of caption match — better an approximate figure than none.

TEXT highlights — "quote" is copied VERBATIM from the document. Skip rather than paraphrase. Prefer short, distinctive 1-3 sentence spans.

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

Max 15 highlights, ranked by relevance.`;

const READER_TOOL = {
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

// Run the Reader. `figureDetections` carries the pre-detected candidate
// regions from Ollama/Docling/built-in detector; `pageImages` is only
// included when vision is enabled (otherwise the model picks figures
// purely from the candidate list + their captions).
export async function runReader({ query, docText, docTitle, groupNames, pageImages, figureDetections, plan }) {
  const wantsText = plan ? plan.wantsText !== false : true;
  const wantsFigures = plan ? !!plan.wantsFigures : true;
  const lines = [];
  lines.push(`Question: ${query}`);
  if (wantsText && !wantsFigures) {
    lines.push("Mode: TEXT ONLY — emit only kind=text highlights. Do NOT emit any kind=image highlights.");
  } else if (wantsFigures && !wantsText) {
    lines.push("Mode: FIGURES ONLY — emit only kind=image highlights for figures, charts, tables, panels. Do NOT emit any kind=text highlights.");
  } else {
    lines.push("Mode: MIXED — emit BOTH kind=text and kind=image highlights as appropriate.");
  }
  lines.push("");

  if (groupNames && groupNames.length) {
    lines.push(`Existing groups: ${groupNames.map((g) => `"${g}"`).join(", ")}`);
  } else {
    lines.push("No existing groups — propose 1-4 short new group names total.");
  }
  lines.push("");

  if (docTitle) {
    lines.push(`Document title: ${docTitle}`);
    lines.push("");
  }

  if (figureDetections && figureDetections.some((d) => d.candidates?.length)) {
    lines.push("Pre-detected figure candidates (use figure_id):");
    for (const d of figureDetections) {
      if (!d.candidates?.length) continue;
      lines.push(`Page ${d.page}:`);
      for (const c of d.candidates) {
        const caption = c.caption ? ` — ${c.caption.slice(0, 80)}` : "";
        lines.push(`  ${c.id}: ${c.kind || "figure"} at left=${c.left.toFixed(3)} top=${c.top.toFixed(3)} w=${c.width.toFixed(3)} h=${c.height.toFixed(3)}${caption}`);
      }
    }
    lines.push("");
  }

  // Build the user content. If we have page images, interleave them
  // before the text dump so the model can correlate visually.
  const content = [{ type: "text", text: lines.join("\n") }];
  if (pageImages && pageImages.length) {
    for (const pg of pageImages) {
      content.push({ type: "text", text: `\n— Page ${pg.page} image —` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: pg.base64 },
      });
    }
  }
  content.push({
    type: "text",
    text: `\nDocument text:\n---\n${docText}\n---`,
  });

  const res = await callMessages({
    system: READER_SYSTEM,
    messages: [{ role: "user", content }],
    tools: [READER_TOOL],
    maxTokens: 4096,
  });

  // Diagnostic: log every content block from the model so we can see
  // text + tool_use side by side. If the highlights array is empty,
  // any accompanying text block usually explains why.
  console.log("[ai] full model response content blocks:", res.content);
  const toolUse = (res.content || []).find((c) => c.type === "tool_use" && c.name === "record_highlights");
  const textBlocks = (res.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n").trim();
  if (textBlocks) {
    console.log("[ai] model text alongside tool call:", textBlocks);
  }
  if (!toolUse) {
    throw new Error(textBlocks || "The model did not return any highlights.");
  }
  const arr = (toolUse.input && Array.isArray(toolUse.input.highlights)) ? toolUse.input.highlights : [];
  if (arr.length === 0 && textBlocks) {
    console.warn("[ai] empty highlights but model wrote text — likely refused. Text:", textBlocks);
  }
  return {
    highlights: arr,
    usage: res.usage || null,
    debugText: textBlocks,
  };
}
