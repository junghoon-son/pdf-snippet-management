// Dev-only verbose logging, OFF by default so the console stays quiet during
// normal use. Turn it on from the browser console with:
//   localStorage.setItem("marklee-debug", "1"); location.reload();
// (Production builds strip all console.* via vite.config.js, so this only
// affects `vite dev`.) console.warn / console.error are intentionally NOT
// routed through here — real warnings and errors should always surface.
const ENABLED =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("marklee-debug") === "1";

export function debug(...args) {
  if (ENABLED) console.log(...args);
}
