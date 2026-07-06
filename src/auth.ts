import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
