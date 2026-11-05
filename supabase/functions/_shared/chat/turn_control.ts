// Superseded work is control flow, not a failed action or an owed reply.
// PostgreSQL freshness checks also protect writes through fenced clients.
export function isTurnInvalidated(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return message === "turn superseded" || message === "turn lease lost";
}
