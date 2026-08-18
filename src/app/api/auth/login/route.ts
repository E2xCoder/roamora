import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/server/config";
import { verifyPassword } from "@/server/auth/password";
import {
  SESSION_COOKIE,
  createSession,
  isAuthConfigured,
} from "@/server/auth/session";
import { apiError, parseBody, serverError } from "@/server/api-utils";

const loginSchema = z.object({
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, loginSchema);
  if (!parsed.ok) return parsed.response;

  if (!isAuthConfigured(config.AUTH_SECRET, config.ROAMORA_PASSWORD_HASH)) {
    return apiError(
      "Kimlik doğrulama yapılandırılmamış. AUTH_SECRET ve ROAMORA_PASSWORD_HASH ayarla.",
      "AUTH_NOT_CONFIGURED",
      503
    );
  }

  try {
    const ok = await verifyPassword(
      parsed.data.password,
      config.ROAMORA_PASSWORD_HASH!
    );

    if (!ok) {
      // Deliberately vague, and no timing shortcut: verifyPassword always
      // performs the full derivation.
      return apiError("Parola hatalı", "INVALID_CREDENTIALS", 401);
    }

    const session = await createSession(config.AUTH_SECRET!);
    const response = NextResponse.json({ ok: true });

    response.cookies.set(SESSION_COOKIE, session.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: session.maxAge,
    });

    return response;
  } catch (err) {
    return serverError(err, "LOGIN_FAILED");
  }
}
