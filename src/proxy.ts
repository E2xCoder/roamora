import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  isAuthConfigured,
  verifySession,
} from "@/server/auth/session";

/**
 * Gates the whole application behind a session cookie.
 *
 * Next.js 16 renamed Middleware to Proxy: the file must be `proxy.ts` at the
 * project root and export `proxy`. Under the old name and export the gate was
 * silently not applied — anonymous requests to /api/places returned 200.
 *
 * When AUTH_SECRET / ROAMORA_PASSWORD_HASH are absent the instance runs open —
 * otherwise a fresh clone would be unusable — but `/api/auth/status` reports
 * that state so the UI can warn instead of implying the instance is secured.
 */

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/status"];

export async function proxy(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const passwordHash = process.env.ROAMORA_PASSWORD_HASH;

  if (!isAuthConfigured(secret, passwordHash)) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const valid = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
    secret!
  );
  if (valid) return NextResponse.next();

  // API callers get a status code they can act on; humans get the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Oturum gerekli", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icons/|thumbnails/).*)",
  ],
};
