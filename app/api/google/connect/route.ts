import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "../../../../src/config";
import { GOOGLE_SCOPES, oauthClient } from "../../../../src/integrations/google";

/**
 * Start the per-partner Google connection. prompt=consent + access_type=offline
 * guarantees a fresh refresh token on every (re)connect.
 */
export function GET(): NextResponse {
  const state = randomBytes(16).toString("hex");
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    // openid/email/profile make Google return an id_token, which the callback
    // verifies to know who connected; without them only API tokens come back.
    scope: [...GOOGLE_SCOPES, "openid", "email", "profile"],
    hd: env().FIRM_DOMAIN,
    state,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set("daybrief_oauth_state", state, {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https"),
    sameSite: "lax",
    maxAge: 600,
    path: "/api/google",
  });
  return res;
}
