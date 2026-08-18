import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { isAuthConfigured } from "@/server/auth/session";

/**
 * Reports whether this instance is actually protected, so the UI can warn
 * when it is not rather than silently implying it is (§98).
 */
export async function GET() {
  return NextResponse.json({
    configured: isAuthConfigured(
      config.AUTH_SECRET,
      config.ROAMORA_PASSWORD_HASH
    ),
  });
}
