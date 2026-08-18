import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApiErrorBody } from "./schemas";

/**
 * Consistent API responses.
 *
 * Handlers used to catch errors and return `[]` with status 200, which made a
 * database failure indistinguishable from an empty database. Failures now
 * carry a status, a machine-readable code and — where relevant — the pipeline
 * stage that failed (spec §55, §62).
 */

export function apiError(
  message: string,
  code: string,
  status: number,
  extra?: { stage?: string; details?: unknown }
) {
  const body: ApiErrorBody = { error: message, code, ...extra };
  return NextResponse.json(body, { status });
}

export function badRequest(error: z.ZodError) {
  return apiError("Geçersiz istek", "VALIDATION_FAILED", 400, {
    details: error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}

export function serverError(err: unknown, code = "INTERNAL_ERROR") {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${code}:`, message);
  return apiError("Sunucu hatası", code, 500, { details: message });
}

/** Parses search params through a zod schema, coercing repeated keys away. */
export function parseQuery<T extends z.ZodType>(url: string, schema: T) {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  return schema.safeParse(params);
}

/** Parses a JSON body, treating malformed JSON as a validation failure. */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<
  { ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: apiError("Gövde geçerli JSON değil", "INVALID_JSON", 400),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: badRequest(parsed.error) };
  return { ok: true, data: parsed.data };
}
