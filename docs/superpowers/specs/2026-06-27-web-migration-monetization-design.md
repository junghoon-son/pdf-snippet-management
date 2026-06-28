# Marklee — Web Migration + Monetization Design

**Date:** 2026-06-27
**Status:** Draft for review
**Branch:** marklee-polish-and-storage

## 1. Goal

Move Marklee from a Tauri desktop app to a browser-only web app deployed on Vercel, then monetize it: a free trial gated by **both** a 7-day window **and** an AI-extraction cap (whichever is hit first), after which AI features require payment via a Stripe link. Documents and annotations stay **local to the browser** (OPFS). Segmentation moves from the Tauri-bundled ONNX model to a server-side **Gemini Flash** call.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Deploy target | Vercel (static client + serverless functions) |
| Document + annotation storage | OPFS (browser-local); never stored on the server |
| Free-tier gate | 7 days **AND** extraction cap, whichever hits first |
| Cap unit | AI extractions (1 Reader query = 1 count; bundled segmentation not double-counted) |
| Proposed cap | **20** free extractions (parameter, tunable) |
| Auth | Clerk magic-link (vanilla `@clerk/clerk-js`) |
| Entitlement store | Neon Postgres |
| Payment | Stripe Payment Link + `checkout.session.completed` webhook |
| Segmentation | Gemini Flash, server-side |
| BYOK | Dropped — provider keys live only in server env |
| What's gated | **AI only.** Manual annotation, OPFS storage, graph, permalinks stay free forever (all client-side, zero operator cost). |

## 3. Phasing

The phases are independently shippable. Phase 1 needs **no backend at all**.

### Phase 1 — Web shell (no server)
The app runs fully in-browser on OPFS: open PDFs, manual highlights, the edge graph, permalinks — all offline. Figure detection uses the existing **pure-JS `figure-detect.js`** (no server). No AI extraction yet (or AI hidden until Phase 2).

### Phase 2 — Backend + monetized AI
Vercel Functions hold provider keys in env. Two AI endpoints (`/api/ai/reader`, `/api/ai/segment`) behind Clerk auth and the entitlement gate. This is where operator-paid inference and the trial gate land together.

### Phase 3 — Payment
Stripe Payment Link → webhook → flip account to paid.

## 4. Phase 1 — Web shell

### 4.1 Finish `OpfsStore` (`src/storage/opfs-store.js`)
Currently a stub (all 11 interface methods throw). Implement by **mirroring `fsa-store.js`** but rooting at `navigator.storage.getDirectory()` instead of a picked directory handle. The file's own header comment already prescribes this. Methods to implement against the `store.js` contract: `readAnnot`, `writeAnnot`, `deleteAnnot`, `readDocumentBytes`, `writeClip`, `readClip`, `deleteClip`, `readGlobalGroups`, `writeGlobalGroups`, `checkPaths`, `copyImageToClipboard`.

- Sidecars: store at OPFS path `<docId>/.marklee/<filename>.annot.json` mirroring the on-disk layout, so the Marklee spec's structure is preserved.
- Clips: OPFS `<docId>/.marklee/clips/<clipId>.png`.
- Global groups: keep the FSA approach (IndexedDB) — it's already browser-portable and shared with FSA.
- `copyImageToClipboard`: use the browser Clipboard API (`navigator.clipboard.write([new ClipboardItem(...)])`); no native bridge.

### 4.2 Store selection
`store.js:autoDetectStore()` already returns `OpfsStore` when `navigator.storage.getDirectory` exists. **Change the precedence so OPFS is preferred over FSA on web** (FSA is Chromium-only; OPFS is cross-browser and matches the "upload, don't open-from-disk" model). `main.js:80-81` currently hard-selects Tauri-vs-FSA — route it through `autoDetectStore()`.

### 4.3 Document import flow
With OPFS there is no persistent folder. Files are imported per the existing `pickBrowserFile()` path (`<input type=file>` / `showOpenFilePicker` fallback, `main.js:261-283`) and **drag-drop**. On import: read bytes → `hashBytes()` (Web Crypto, already portable, `main.js:250`) → write into OPFS → existing `loadPdf()` flow. Imported documents persist in OPFS across sessions (an in-app "library" list keyed by `contentHash`).

### 4.4 Remove Tauri coupling
- `main.js:2` — the static `import { open } from "@tauri-apps/plugin-dialog"` breaks in a browser. Remove; replace the desktop "Open File"/"Open Folder" handlers with the web import flow.
- Delete the desktop-only commands and their UI: `reveal_in_finder`, `write_file` export (replace with a Blob download), native `copy_image_to_clipboard` (replaced in §4.1).
- `data-tauri-drag-region` and any window-chrome affordances become no-ops on web.

### 4.5 Remove BYOK key surface
- Delete the key-entry UI (`#ai-settings-modal`, `index.html:308-363`) and the model/key persistence.
- In `src/ai/anthropic.js`, `gemini.js`, `openai.js`: remove the Tauri `get/set_provider_key` paths **and** the `localStorage` key fallback. (See §5.3 for what replaces the call sites.)
- `initAllProviderKeys()` (`main.js:88`) is deleted; the client never holds a key.

### 4.6 OpenAI
Keep `openai.js` in the provider abstraction for now but it is **not wired** on web (Phase 2 proxies Anthropic for the Reader and Gemini Flash for segmentation). Leaving the adapter avoids ripping out the abstraction; it can be exposed later behind a server endpoint if desired. (YAGNI: no OpenAI endpoint in this design.)

## 5. Phase 2 — Backend + monetized AI

### 5.1 Auth (Clerk)
Vanilla `@clerk/clerk-js` on the client (the app is frameworkless). Magic-link sign-in. The Clerk session token is sent on each `/api/ai/*` request; functions verify it server-side via Clerk's backend SDK and resolve the Clerk `userId` + primary email. No app-managed passwords or sessions.

### 5.2 Entitlement store (Neon Postgres)
One table:

```sql
create table app_user (
  clerk_user_id      text primary key,
  email              text not null,
  trial_started_at   timestamptz not null default now(),
  extractions_used   integer    not null default 0,
  plan               text       not null default 'trial',  -- 'trial' | 'paid'
  stripe_customer_id text,
  created_at         timestamptz not null default now()
);
```

- Row is created on first authenticated request (upsert by `clerk_user_id`). `trial_started_at` = first sign-in (parameter; could be first extraction).

### 5.3 AI proxy endpoints (Vercel Functions, plain JS to match repo)
Provider keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) live in Vercel env. The client's `providers.js` is repointed from public provider URLs to same-origin paths; request/response envelopes are unchanged (providers already normalize to the Anthropic shape), so `reader.js`/`main.js` need no logic change.

- **`POST /api/ai/reader`** — verifies Clerk session → entitlement check+increment (§5.4) → forwards the Reader call to Anthropic (`callMessages` body: `{model, max_tokens, system, messages, tools}`) → returns the normalized envelope. This is the unit that counts as **one extraction**.
- **`POST /api/ai/segment`** — verifies Clerk session → calls **Gemini Flash** vision with the page image(s) → returns the **existing candidate shape** `[{page, candidates:[{id,left,top,width,height,source:"gemini"}]}]` so it is a drop-in for `runOnnxLayout()`. Segmentation is invoked *within* an extraction flow, so it is **bundled** into that extraction's single count, not charged separately.
- Free/offline users keep the client-side `figure-detect.js` detector (not an AI call, not gated). Gemini Flash is the upgraded detector used during a gated AI extraction.

### 5.4 Entitlement enforcement (atomic)
A single conditional update avoids check-then-increment races:

```sql
update app_user
   set extractions_used = extractions_used + 1
 where clerk_user_id = $1
   and ( plan = 'paid'
         or (now() < trial_started_at + interval '7 days'
             and extractions_used < $CAP) )
returning extractions_used, plan;
```

Zero rows returned → gate failed → respond **402 Payment Required** with `{reason: 'trial_expired' | 'cap_reached'}` and the Payment Link URL. The client shows an upgrade prompt. Paid accounts are never decremented or time-limited.

### 5.5 Abuse / cost controls
- Per-IP rate limit on `/api/ai/*` (Vercel Firewall rule or a small Upstash/Redis limiter) on top of the per-account cap — the account cap alone won't stop scripted abuse before sign-in friction.
- `max_tokens` and image-size caps enforced server-side, not trusted from the client.

### 5.6 Privacy note
OPFS keeps documents from being **stored** on the server. During an AI extraction, page text/images are **transmitted** through the proxy to Anthropic/Gemini (transient, not persisted by us). This is inherent to operator-paid inference and should be stated in the product's privacy copy.

## 6. Phase 3 — Payment

- A single Stripe **Payment Link** for the paid tier (price TBD by owner). The client opens it with `?client_reference_id=<clerk_user_id>` and prefilled email.
- **`POST /api/stripe/webhook`** verifies the Stripe signature, handles `checkout.session.completed`: match `client_reference_id` → set `plan='paid'`, store `stripe_customer_id`.
- Handle `customer.subscription.deleted` / cancellation (if the tier is a subscription) → set `plan='trial'` (or a separate `expired` state). If the tier is a one-time purchase, skip subscription events. **Open parameter: one-time vs subscription** — defaulting to subscription; owner to confirm.
- After payment, the next `/api/ai/*` call passes the gate via the `plan='paid'` branch with no further changes.

## 7. Component boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/storage/opfs-store.js` | Local persistence (sidecars, clips, docs) | OPFS, IndexedDB |
| `src/ai/providers.js` (client) | Build request envelopes, call same-origin proxy | fetch |
| `api/ai/reader.js` | Auth + gate + Anthropic Reader passthrough | Clerk, Neon, Anthropic |
| `api/ai/segment.js` | Auth + Gemini Flash segmentation → candidate shape | Clerk, Neon, Gemini |
| `api/lib/entitlement.js` | Atomic check+increment, status read | Neon |
| `api/stripe/webhook.js` | Payment → entitlement flip | Stripe, Neon |
| `auth` (Clerk middleware/helpers) | Identity | Clerk |

Each AI endpoint = thin auth+gate wrapper around one provider call; the entitlement logic is isolated in `api/lib/entitlement.js` so it's unit-testable without HTTP.

## 8. Environment variables
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `DATABASE_URL` (Neon), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_LINK_URL`.

## 9. Out of scope (YAGNI)
- Server-side document storage / cross-device sync (OPFS is local by decision).
- OpenAI on web (adapter retained but unwired).
- Team/multi-seat billing, usage dashboards, coupons.
- OCR for image sources, the `provenance`/coordinate-frame spec additions discussed separately (tracked elsewhere).

## 10. Open parameters for owner
1. **Cap N** — proposed 20 free extractions.
2. **Price + one-time vs subscription** — affects which Stripe events the webhook handles (§6).
3. **`trial_started_at` start** — first sign-in (default) vs first extraction.

## 11. Risks
- **OPFS durability:** OPFS can be evicted by the browser under storage pressure; users should be told their library is browser-local and offered export. (Export-to-file already needed in §4.4.)
- **Cap enforcement floor:** a determined user can make new accounts (new email) to reset the trial; the per-IP limit + email-based identity is the practical ceiling, not a hard guarantee.
- **Gemini Flash segmentation quality** vs the old ONNX RT-DETR is unverified — validate the candidate boxes against a few real PDFs before trusting them in the extraction flow.
