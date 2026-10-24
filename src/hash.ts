import { createHmac, timingSafeEqual } from "node:crypto";

export const hmac = (salt: string, value: string) =>
  createHmac("sha256", salt).update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
