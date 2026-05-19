// Reader — single-doc semantic-highlight extraction.
//
// One LLM call with a `record_highlights` tool. The tool's input schema
// forces verbatim quoting + structured fields. Caller passes a query
// and the doc as plain text; gets back an array of suggestions.

import { callMessages, getMaxOutputTokens } from "./providers.js";
import { READER_SYSTEM, READER_TOOL } from "./reader-prompt.js";

// READER_SYSTEM + READER_TOOL moved to ./reader-prompt.js — pure
// constants, shared by both this Tauri-side caller and the headless
// CLI (scripts/ai-batch.mjs). One source of truth for prompt + schema.

// Run the Reader. `figureDetections` carries the pre-detected candidate
// regions from RT-DETR / built-in detector; `pageImages` is only included
// when vision is enabled (otherwise the model picks figures purely from
// the candidate list + their captions).
export async function runReader({ query, docText, docTitle, groupNames, pageImages, figureDetections, plan, sourceKind }) {
  // Image sources (PNG/JPEG) override the mode regardless of plan —
  // there's no text to quote and no multi-page layout to detect, so
  // the model gets one image and returns rect-only highlights.
  const isImageSource = sourceKind === "image";
  const wantsText = isImageSource ? false : (plan ? plan.wantsText !== false : true);
  const wantsFigures = isImageSource ? true : (plan ? !!plan.wantsFigures : true);
  const lines = [];
  lines.push(`Question: ${query}`);
  if (isImageSource) {
    lines.push("Mode: IMAGE SOURCE — the document IS a single image (PNG/JPEG). Return only kind=image highlights with rects pointing to regions of interest inside the image. Use page=1 for all rects. Do NOT emit any kind=text highlights (the source has no extractable text). figure_id is unavailable here; always supply rect={left, top, width, height} in fractional [0..1] coords.");
  } else if (wantsText && !wantsFigures) {
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
    maxTokens: getMaxOutputTokens(),
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
