#!/usr/bin/env node
// Stamp build provenance into dist/build-info.json so the running server can
// report exactly which commit it was built from (GET /version). Runs as npm
// `postbuild` — after `tsc`, so dist/ already exists. The deploy box has no git
// checkout, so the SHA must be baked here at build time; a non-git build (e.g.
// from a tarball) stamps commit:"unknown" instead of failing the build.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function git(args) {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const commit = git("rev-parse HEAD") || "unknown";
const commitShort = git("rev-parse --short HEAD") || "unknown";
const dirty = commit !== "unknown" && git("status --porcelain") !== "";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const info = {
  name: pkg.name,
  version: pkg.version,
  commit,
  commitShort,
  dirty,
  builtAt: new Date().toISOString(),
};

writeFileSync(
  new URL("../dist/build-info.json", import.meta.url),
  JSON.stringify(info, null, 2) + "\n",
);
console.log(`stamped dist/build-info.json — ${commitShort}${dirty ? "-dirty" : ""} @ ${info.builtAt}`);
