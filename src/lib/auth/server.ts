import { createNeonAuth } from "@neon/auth/next/server";

export function getAuth() {
  const baseUrl = process.env.NEON_AUTH_BASE_URL;
  const cookieSecret = process.env.NEON_AUTH_COOKIE_SECRET;

  if (!baseUrl) throw new Error("NEON_AUTH_BASE_URL is required");
  if (!cookieSecret) throw new Error("NEON_AUTH_COOKIE_SECRET is required");

  return createNeonAuth({
    baseUrl,
    cookies: { secret: cookieSecret },
  });
}
