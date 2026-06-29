// Private-beta auth gate (web only).
//
// This is the module entry for the browser build. The real app (main.js) is
// dynamically imported ONLY after a signed-in, allowlisted user is present —
// so unauthenticated visitors never load or initialize app code.
//
// Sign-up is restricted to the Clerk allowlist (Clerk dashboard →
// Restrictions), so only invited beta testers can get in; this gate just
// enforces "signed in, or you don't see the app."
//
// We use Clerk's HOSTED sign-in (redirectToSignIn) rather than the embedded
// <SignIn> component: @clerk/clerk-js 6.x does NOT load the prebuilt UI
// components on a bare clerk.load() (mountSignIn throws "Clerk was not loaded
// with Ui components"), and the embedded path needs a separate UI bundle.
// The redirect flow needs no UI components, so it's the robust choice for a
// gate. The publishable key comes from VITE_CLERK_PUBLISHABLE_KEY.
import { Clerk } from "@clerk/clerk-js";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error(
    "Missing VITE_CLERK_PUBLISHABLE_KEY — set it in .env.local for local dev " +
      "and in the Vercel project's Environment Variables for deploys.",
  );
}

// Cover the app shell immediately (before Clerk finishes loading) so the
// signed-out user never sees a flash of the un-booted app behind the gate.
const overlay = document.createElement("div");
overlay.id = "clerk-gate";
overlay.style.cssText =
  "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
  "justify-content:center;background:#fbfaf6;";
const card = document.createElement("div");
card.style.cssText =
  "display:flex;flex-direction:column;align-items:center;gap:14px;" +
  "font-family:ui-sans-serif,system-ui,sans-serif;color:#7a7460;";
card.innerHTML =
  '<div style="display:flex;align-items:center;gap:10px;">' +
    '<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true" style="overflow:visible">' +
      '<rect x="3" y="3" width="58" height="58" rx="14" fill="#fffefa" stroke="#e8e3d4" stroke-width="2"/>' +
      '<rect x="12" y="38" width="40" height="13" rx="2.5" fill="#ffd75a" transform="rotate(-2 32 44)"/>' +
      '<text x="32" y="42" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="34" fill="#231f17">M</text>' +
    '</svg>' +
    '<span style="font-family:Georgia,serif;font-weight:600;font-size:26px;color:#231f17;letter-spacing:-0.01em;">' +
      '<span style="background:#ffd75a;color:#231f17;padding:0 3px;border-radius:3px;">Mark</span>lee' +
    '</span>' +
  '</div>' +
  '<span id="clerk-gate-status" style="font-size:13px;">Loading…</span>';
overlay.appendChild(card);
const gateStatus = card.querySelector("#clerk-gate-status");
document.body.appendChild(overlay);

const clerk = new Clerk(publishableKey);
let booted = false;

async function bootApp() {
  if (booted) return;
  booted = true;
  overlay.remove();
  // main.js binds to the existing index.html structure; its top-level code
  // runs on import, which is exactly when we want it — after auth.
  await import("./main.js");
  mountSignOut();
}

await clerk.load();

// Expose the loaded Clerk instance so app modules (the AI proxy client in
// gemini.js) can read the session token for authenticated /api/ai requests.
window.Clerk = clerk;

// If a session already exists (or arrives), boot in place.
clerk.addListener(() => {
  if (clerk.isSignedIn) bootApp();
});

if (clerk.isSignedIn) {
  await bootApp();
} else {
  // Full-page redirect to Clerk's hosted sign-in. After sign-in Clerk
  // redirects back to the app origin; this entry re-runs, the session is
  // present, and bootApp() loads the app.
  gateStatus.textContent = "Redirecting to sign-in…";
  try {
    await clerk.redirectToSignIn({ signInForceRedirectUrl: window.location.origin });
  } catch (err) {
    gateStatus.textContent =
      "Couldn't reach sign-in. Refresh to retry. (" +
      (err && err.message ? err.message : "unknown error") +
      ")";
  }
}

function mountSignOut() {
  const btn = document.createElement("button");
  btn.id = "clerk-signout";
  btn.type = "button";
  btn.textContent = "Sign out";
  btn.title = "Sign out of the beta";
  btn.style.cssText =
    "position:fixed;bottom:10px;left:10px;z-index:99990;" +
    "font:11px ui-monospace,monospace;padding:4px 8px;background:#eee5cf;" +
    "color:#6a6450;border:1px solid #d8d0b8;border-radius:6px;cursor:pointer;opacity:0.7;";
  btn.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "0.7"));
  btn.addEventListener("click", async () => {
    await clerk.signOut();
    location.reload();
  });
  document.body.appendChild(btn);
}
