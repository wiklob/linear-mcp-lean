import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  // Hash both sides, then constant-time compare the digests. The digests are always
  // equal-length (no early length branch), so even the token *length* leaks nothing
  // via timing. The value compare stays constant-time.
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Inbound bearer gate. Runs BEFORE the MCP transport.
 * Missing or invalid `Authorization: Bearer <token>` → 401.
 * The expected token is `MCP_BEARER_TOKEN` (env); absent → 500 (misconfig, fail closed).
 */
export function bearerGate(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    res.status(500).json({ error: "server misconfigured: MCP_BEARER_TOKEN not set" });
    return;
  }
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !safeEqual(match[1], expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
