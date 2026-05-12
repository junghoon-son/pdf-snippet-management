// Two-stage dispatch — stage 1: intent router.
//
// One small LLM call that classifies the user's query into what the
// downstream stack needs. Decouples user intent from expensive pipeline
// triggers — the figure detector (ONNX/Ollama/Docling) now runs ONLY
// when the query actually wants figures, not whenever the global toggle
// happens to be on.
//
// The result is also model-portable: any provider that supports tool
// calls can serve as the router, including future local models.

import { callMessages } from "./providers.js";

const PLANNER_SYSTEM = `You are an intent classifier for a PDF annotation tool. Given the user's request, decide what the downstream stack should fetch.

Return via the record_plan tool:
- needs_text: true if the user wants to surface text passages — claims, definitions, findings, methods, conclusions, takeaways, quotes, etc.
- needs_figures: true if the user wants to surface figures, charts, tables, diagrams, panels, plots, schematics, or visual elements
- figure_pages: optional list of page numbers (1-indexed) if the user named specific pages (e.g. "page 3")

Most queries need ONE of these, not both:
- "key findings" / "main points" / "highlight the methods" / "what are the conclusions" / "summarize the results" / "the abstract" → needs_text=true, needs_figures=false
- "show me the figures" / "highlight all figures" / "all tables" / "what charts are there" / "figure 3 only" → needs_text=false, needs_figures=true

Both is correct ONLY when the query explicitly asks for both:
- "key findings AND figures" / "highlight the methods and any diagrams" / "everything important including charts" → needs_text=true, needs_figures=true

When in doubt, prefer text-only — the figure detector is slow.`;

const PLANNER_TOOL = {
  name: "record_plan",
  description: "Record what kinds of highlights this query needs.",
  input_schema: {
    type: "object",
    properties: {
      needs_text: {
        type: "boolean",
        description: "True if text passages should be highlighted.",
      },
      needs_figures: {
        type: "boolean",
        description: "True if figures, charts, tables, diagrams should be highlighted.",
      },
      figure_pages: {
        type: "array",
        items: { type: "integer" },
        description: "Page numbers (1-indexed) if specific pages were named.",
      },
    },
    required: ["needs_text", "needs_figures"],
  },
};

// Classify the query. Returns { needsText, needsFigures, figurePages }.
// On failure, falls back to a safe default (both true) so the user's
// intent isn't silently dropped.
export async function planQuery({ query, docTitle }) {
  const userText =
    `Query: ${query}` +
    (docTitle ? `\nDocument: ${docTitle}` : "");
  let res;
  try {
    res = await callMessages({
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      tools: [PLANNER_TOOL],
      maxTokens: 256,
    });
  } catch (err) {
    console.warn("[planner] call failed, defaulting to both:", err);
    return { needsText: true, needsFigures: true, figurePages: [], source: "fallback" };
  }
  const toolUse = (res.content || []).find(
    (c) => c.type === "tool_use" && c.name === "record_plan",
  );
  if (!toolUse) {
    console.warn("[planner] no tool call in response — defaulting to both");
    return { needsText: true, needsFigures: true, figurePages: [], source: "fallback" };
  }
  const input = toolUse.input || {};
  const plan = {
    needsText: input.needs_text !== false,
    needsFigures: !!input.needs_figures,
    figurePages: Array.isArray(input.figure_pages) ? input.figure_pages : [],
    source: "llm",
  };
  // Never return all-false — that strands the user. Default to text-only.
  if (!plan.needsText && !plan.needsFigures) plan.needsText = true;
  return plan;
}
