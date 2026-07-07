// Build provenance for the running server. `dist/build-info.json` is generated
// at build time by bin/gen-version.mjs (npm `postbuild`) and ships inside dist/
// on redeploy. The box has no git, so the SHA is baked at build time on the dev
// machine — read here at runtime. If the file is absent (an unstamped/unbuilt
// run), report `stamped:false` explicitly rather than guessing a version.
import { readFileSync } from "node:fs";

export interface BuildInfo {
  name: string;
  version: string;
  commit: string; // full git SHA, or "unknown"
  commitShort: string; // short git SHA, or "unknown"
  dirty: boolean; // build tree had uncommitted changes
  builtAt: string | null; // ISO timestamp, or null if unstamped
  stamped: boolean; // false when dist/build-info.json was missing
}

const FALLBACK: BuildInfo = {
  name: "linear-mcp-lean",
  version: "0.0.0",
  commit: "unknown",
  commitShort: "unknown",
  dirty: false,
  builtAt: null,
  stamped: false,
};

let cached: BuildInfo | null = null;

/** Build info, read once from dist/build-info.json (sibling of this compiled module) and cached. */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  let info: BuildInfo;
  try {
    const raw = readFileSync(new URL("./build-info.json", import.meta.url), "utf8");
    info = { ...FALLBACK, ...JSON.parse(raw), stamped: true };
  } catch {
    info = FALLBACK;
  }
  cached = info;
  return info;
}
