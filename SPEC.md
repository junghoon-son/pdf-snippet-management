# Marklee Annotation Format

**Version:** 0.1 (DRAFT)
**Status:** Working Draft
**Date:** 2026-05-08
**License:** CC BY 4.0

## Abstract

Marklee is a portable, format-agnostic annotation format for documents. Annotations live in JSON sidecar files alongside source documents (PDF, Markdown, DOCX). They use **edit-tolerant text anchors** so they survive small changes to the source, carry a **directed labeled graph** of relationships between annotations, and define a **permalink URL grammar** for sharing a single annotation as a hyperlink.

The format also defines a centrality algorithm — **MarkRank** — that scores each annotation by graph centrality. The algorithm is to Marklee what PageRank is to the web: a normative ranking function over the data the format encodes.

The format is local-first and file-based: no server, no account, no proprietary blob. Sidecars are plain JSON next to the source document, version-controllable, scriptable from a CLI, and self-describing.

## 1. Scope

### 1.1 In scope

- JSON sidecar file format (one sidecar per source document).
- Snippet schema for text and image annotations.
- Edge schema for relationships between annotations.
- Group schema for many-to-many tagging.
- The anchor resolution algorithm (text + context + section path).
- Content addressing of source documents (SHA-256).
- Permalink URL grammar for sharing one annotation.
- The MarkRank centrality algorithm over the annotation graph (Section 8).

### 1.2 Out of scope

- Document content storage or hosting.
- Authentication, authorization, multi-user collaboration.
- Network protocols for collaborative editing.
- Source document rendering (handled by format-specific viewers).
- Workspace / collection management at the client level.

### 1.3 Conformance language

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in this document are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119).

A *conformant reader* MUST be able to parse any sidecar that follows the schema, even if it does not display all fields.

A *conformant writer* MUST emit sidecars that validate against the JSON Schema in Appendix A.

## 2. Document model

### 2.1 Document

A **document** is a source file in one of the supported formats:

| Format | `kind` | Properties |
|--------|--------|------------|
| PDF | `"pdf"` | Paginated, byte-stable, fixed layout. |
| Markdown / CommonMark | `"markdown"` | Reflowable plain text, paginated only on render. |
| Microsoft Word | `"docx"` | Reflowable, binary XML. |

Conformant implementations MUST support `pdf`. Other kinds are OPTIONAL but defined.

### 2.2 Sidecar

A **sidecar** is a JSON file located at `<document-path>.annot.json` containing all annotations for one document. Sidecars are independent — moving a document and its sidecar together MUST preserve all annotations.

### 2.3 Snippet

A **snippet** is one annotation: a region of the document with attached metadata (text, comment, group memberships, anchor, optional image clip).

### 2.4 Edge

An **edge** is a directed labeled relationship between two snippets. The set of edges across one or more sidecars forms a directed graph.

### 2.5 Group

A **group** is a tag-like overlay. A snippet MAY belong to zero or more groups.

### 2.6 Anchor

An **anchor** is the locator that places a snippet within a (possibly edited) source document. See Section 4.

## 3. Sidecar schema

### 3.1 Top-level structure

```json
{
  "markleeVersion": "0.1",
  "source":   { ... },
  "snippets": [ ... ],
  "edges":    [ ... ],
  "groups":   [ ... ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `markleeVersion` | string | new files: yes; reading: no | semver of this spec |
| `source` | object | no | document metadata (Section 3.2) |
| `snippets` | array | yes | zero or more snippet objects |
| `edges` | array | no | zero or more edge objects |
| `groups` | array | no | zero or more group metadata; SHOULD only list groups referenced by this sidecar's snippets so the file is self-contained |

Unknown top-level fields MUST be preserved by readers on round-trip.

### 3.2 Source

```json
{
  "path":        "/abs/or/rel/path/file.pdf",
  "filename":    "file.pdf",
  "title":       "Original Title",
  "author":      "Author Name",
  "kind":        "pdf",
  "contentHash": "sha256:ab12cd34..."
}
```

All fields OPTIONAL. `kind` MUST be one of `"pdf"`, `"markdown"`, `"docx"` if present. `contentHash` MUST be lowercase hex, OPTIONALLY prefixed with `sha256:` (Section 5).

### 3.3 Snippet

```json
{
  "id":              "uuid",
  "kind":            "text",
  "page":            5,
  "text":            "load-bearing quote",
  "textNormalized":  "load-bearing quote",
  "rects":           [{ "left": 0.1, "top": 0.2, "width": 0.3, "height": 0.04 }],
  "imagePath":       ".file.pdf.clips/abc.png",
  "clipUrl":         "https://cdn.example.com/clip.png",
  "clipHash":        "sha256:ab12...",
  "contextBefore":   "preceding 40 chars",
  "contextAfter":    "following 40 chars",
  "anchor":          "Methods > Statistical analysis",
  "flowPos":         423,
  "comment":         "free-form user note",
  "groups":          ["group-uuid"],
  "tags":            [],
  "pos":             { "x": 102, "y": 88 },
  "created":         "2026-05-08T10:23:11Z"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | UUID v4 RECOMMENDED |
| `kind` | string | yes | `"text"` or `"image"` |
| `page` | integer | yes | 1-indexed; MUST be 1 for flow docs |
| `text` | string | yes | verbatim quote from source (text snippets); OR descriptive label (image snippets) |
| `textNormalized` | string | no | normalized form (Section 4.1); RECOMMENDED for resilience |
| `rects` | array | yes for PDF text | fractional page coords [0..1]; MUST be `[]` for flow docs |
| `imagePath` | string | yes for image | relative to sidecar dir; PNG only in v0.1 |
| `clipUrl` | string | no | hosted URL of the clip PNG; lets a permalink display the clip without the source PDF |
| `clipHash` | string | no | SHA-256 of the original clip PNG; receiver MAY use for verification |
| `contextBefore` | string | no | normalized text immediately preceding `text`; SHOULD be present for resilience |
| `contextAfter` | string | no | normalized text immediately following `text` |
| `anchor` | string | no | nearest preceding heading chain, e.g. `"Methods > Findings"` |
| `flowPos` | integer | no | stable ordinal within flow doc (text-node index) |
| `comment` | string | no | user-authored note |
| `groups` | array of string | no | group IDs |
| `tags` | array of string | no | free-form labels distinct from groups |
| `pos` | object | no | client-side graph layout position |
| `created` | string | no | ISO 8601 timestamp |

Future versions MAY add fields. Readers MUST preserve unknown fields on round-trip.

### 3.4 Edge

```json
{
  "id":     "uuid",
  "source": "snippet-id",
  "target": "snippet-id",
  "label":  "supports"
}
```

`label` is a free-form string. Recommended labels include `"supports"`, `"contradicts"`, `"elaborates"`, `"cites"`, but any string is permitted.

### 3.5 Group

```json
{
  "id":    "uuid",
  "name":  "Methodology",
  "color": "#88aaff"
}
```

## 4. Anchor resolution

The **anchor resolution algorithm** locates where in a (possibly edited) source document a given snippet anchors. Implementations MUST attempt the following tiers in order, returning the first successful match:

### Tier 1 — Exact text + context

Find all occurrences of `textNormalized` (or `normalize(text)` if absent) in the document's normalized full text. If exactly one occurrence has its preceding window matching `contextBefore` AND its following window matching `contextAfter` (both after normalization), return that match.

### Tier 2 — Exact text only

If `textNormalized` occurs exactly once in the document, return it. (Multiple occurrences with no context to disambiguate fall through.)

### Tier 3 — Fuzzy within section

(Flow documents only.) Restrict the search to the document section identified by `anchor`. Compute Levenshtein similarity between `textNormalized` and overlapping windows of section text. If the best match has similarity ≥ 0.8, return it.

### Tier 4 — Orphaned

No match. The snippet is preserved in the sidecar; clients SHOULD render an "orphaned" indicator and offer manual re-linking.

### 4.0 Applicability

This algorithm applies only to snippets with `kind: "text"`. Image snippets (`kind: "image"`) are inherently positional — they identify a rectangle of source pixels, not a quoted phrase, and have no edit-tolerant fallback. Implementations MUST locate image snippets by `page` + `rects` directly, optionally verifying against `clipHash` (Section 3.3) when present.

### 4.1 Normalization

The following transforms apply when computing `textNormalized` and when matching:

1. Unicode NFKC.
2. Strip soft hyphens (U+00AD).
3. Replace `\r\n` and `\r` with `\n`.
4. Replace runs of whitespace (including newlines) with a single space.
5. Trim leading and trailing whitespace.
6. (For matching only — not for storage:) case-folding via `String.prototype.toLowerCase()`.

Storage of `textNormalized` SHOULD preserve case. Matching is case-insensitive.

## 5. Content hashing

A document's `contentHash` is the SHA-256 of its raw bytes, lowercase hex, OPTIONALLY prefixed with `sha256:`.

```
contentHash = "sha256:" + lowercase_hex(SHA-256(document_bytes))
```

Clients SHOULD compute and store the hash when a sidecar is first written. Clients comparing a hash SHOULD warn but NOT refuse on mismatch — small edits are common and the anchor resolution algorithm typically recovers.

## 6. Permalink URL grammar

A **Marklee Permalink** encodes a single snippet anchor as a URL. It is the wire form of an anchor — what an anchor looks like when serialized for sharing across the web.

### 6.1 Form (text snippets)

```
<base>/v?
   hash    = <contentHash>          (REQUIRED)
   src     = <url-encoded source URL>   (RECOMMENDED — where to fetch the document)
   page    = <integer>              (PDF; 1-indexed)
   anchor  = <url-encoded heading path>   (flow docs)
   flowPos = <integer>              (flow docs)
   text    = <base64url(textNormalized)>   (OPTIONAL but RECOMMENDED for resilience)
   cb      = <base64url(contextBefore)>    (OPTIONAL)
   ca      = <base64url(contextAfter)>     (OPTIONAL)
   id      = <snippet-id>           (OPTIONAL — references a snippet by ID for comment lookup)
```

`base64url` is RFC 4648 §5 unpadded.

### 6.1.1 Form (image snippets)

For image (region clip) snippets the permalink instead encodes the rectangle to be re-rendered from the source:

```
<base>/v?
   kind     = "image"               (REQUIRED to disambiguate)
   hash     = <contentHash>         (REQUIRED — source PDF hash)
   src      = <url-encoded source URL>   (RECOMMENDED)
   page     = <integer>             (REQUIRED — 1-indexed)
   rect     = <L,T,W,H>             (REQUIRED — four floats in [0..1], comma-separated, fractional page coords)
   id       = <snippet-id>          (OPTIONAL)
   clipUrl  = <url>                 (OPTIONAL — pre-rendered PNG of the clip, hosted)
   clipHash = <sha256>              (OPTIONAL — content hash of the original clip PNG, lowercase hex)
   text     = <base64url(...)>      (OPTIONAL — descriptive label, NOT used for matching)
```

A receiver MUST be able to display the snippet by re-rendering `rect` from the source PDF at `page`. If `clipUrl` is present the receiver MAY display the hosted PNG directly without re-rendering. If `clipHash` is present the receiver MAY verify the re-rendered PNG against it (perceptual hash comparison RECOMMENDED, since render scale will differ).

Image snippets do NOT use the anchor resolution algorithm (Section 4.0). They are positional and frozen at capture time; if the source has been re-paginated the receiver simply gets a different image at the same coordinates.

### 6.2 Resolution

A receiver of a Marklee Permalink MUST:

1. Fetch the source document from `src`. (If `src` is absent and only `hash` is given, the client MAY consult a content-addressable store; this is OPTIONAL and OUT OF SCOPE for v0.1.)
2. Compute SHA-256 of the fetched bytes.
3. If hash mismatches: SHOULD warn but MAY proceed.
4. Decode `text`, `cb`, `ca` from base64url.
5. Run the anchor resolution algorithm (Section 4) using these as the snippet's `text`, `contextBefore`, `contextAfter`, `anchor`, `flowPos`.
6. On success: scroll to and visually emphasize the matched region.
7. On failure: surface an error UI to the user.

### 6.3 Privacy considerations

Including `text`, `cb`, `ca` in the URL discloses document content to anyone with the link. Share-link generators SHOULD treat these as opt-in. The default share form SHOULD include only `hash`, `page` (or `anchor` + `flowPos`), and `id` — sufficient to locate by exact position when the document is unchanged but degrading to "open the doc" when edits have happened. Resilient anchoring (with text + context) SHOULD require an explicit opt-in.

### 6.4 Short codes

To address URL-length and privacy concerns, an implementation MAY use a content-addressable shortcut: the URL contains a short opaque code resolving server-side to a full payload. The shortcode mechanism is OUT OF SCOPE for v0.1.

## 7. Format-specific notes

### 7.1 PDF

- `page` MUST be a 1-indexed integer.
- `rects` MUST be an array of `{left, top, width, height}` in fractional page coordinates (0..1).
- Multi-line text snippets MAY span multiple rects (e.g., text wrapping across lines).
- `kind: "image"` snippets carry `imagePath` to a PNG file relative to the sidecar directory.

### 7.2 Markdown / DOCX (flow documents)

- `page` is always 1.
- `rects` is always `[]`.
- `kind` MUST be `"text"` in v0.1.
- `anchor` SHOULD be the nearest preceding heading chain joined by `" > "`, e.g., `"Methods > Statistical analysis"`. This is the section path used by Tier 3 resolution.
- `flowPos` SHOULD be a stable ordinal indicating snippet order within the document (e.g., the text-node index in document order). This is the natural sort key replacing `page` for flow docs.

## 8. The MarkRank algorithm

**MarkRank** is a centrality algorithm over the snippet graph: a PageRank variant that scores each snippet by how much "incoming attention" it receives from other snippets.

```
rank(s) = (1 - d) / N + d * Σ_{t : edge(t -> s)} rank(t) / outdegree(t)
        + d * dangling_mass / N
```

Where:
- `N` is the total number of snippets in the graph.
- `d` is the damping factor (RECOMMENDED 0.85).
- The sum runs over all snippets `t` that have an edge pointing to `s`.
- `dangling_mass` is the sum of ranks of nodes with no outgoing edges, redistributed uniformly to avoid trapping.

Iterate to a fixed point or for at most 100 iterations. Convergence tolerance RECOMMENDED `1e-7`.

The algorithm is a scoring function over a sidecar (or the union of sidecars in a workspace). It is normative for any tool that claims to compute "MarkRank scores".

## 9. Comparison with prior art

| Spec | Format scope | Anchor model | Sidecar | Edges | Edit-tolerant | Permalink |
|---|---|---|---|---|---|---|
| **Marklee** | PDF + Markdown + DOCX | text + context + section path | yes (JSON) | yes, labeled | yes (4-tier) | defined |
| W3C Web Annotation Data Model | any | TextQuoteSelector etc. | no (server-side) | indirect | partial | defined (URI) |
| Adobe XFDF | PDF only | byte offset | yes (XML) | no | no | yes |
| Hypothesis | HTML mostly | TextQuoteSelector | no (server-side) | reply only | yes | yes |
| PDF `/Annot` | PDF only | byte offset | embedded | no | no | partial |
| EPUB CFI | EPUB only | structural path | n/a | no | no | yes |

Marklee's distinct contributions:
1. Cross-format unified schema (PDF + flow docs in one model).
2. Sidecar-first (no server required).
3. Normative tier-based anchor resolution algorithm.
4. First-class labeled edges for graph reasoning.
5. Permalink URL grammar that carries the anchor (not just the position).

## 10. Versioning

This spec uses semver:
- **Major** increments break compatibility. Readers MUST refuse files with unknown major versions.
- **Minor** increments add fields. Readers MAY ignore unknown fields on read but MUST preserve them on round-trip.
- **Patch** increments are editorial only.

Version 0.x is a working draft. The format MAY change incompatibly until 1.0.

## Appendix A. JSON Schema

See [`schema/marklee-v0.1.json`](schema/marklee-v0.1.json) for a JSON Schema (draft 2020-12) covering Sections 3.1–3.5.

## Appendix B. Test corpus

See [`spec/tests/`](spec/tests/) for a corpus of input sidecars + expected anchor resolutions across various source-edit scenarios. A conformant implementation SHOULD pass the entire corpus.

## Appendix C. Acknowledgements

This specification draws on prior art including:
- W3C Web Annotation Data Model (Robert Sanderson et al.)
- Hypothesis annotation format
- The CommonMark spec methodology (Jeff Atwood, John MacFarlane) — for the practice of pairing a prose spec with an executable test corpus.
- PDF.js text-layer rendering as a reference for fractional rect coordinates.

## Appendix D. Changelog

- **0.1** (2026-05-08): Initial working draft.
