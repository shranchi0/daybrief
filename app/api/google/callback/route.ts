import type { Credentials } from "google-auth-library";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "../../../../src/config";
import { oauthClient } from "../../../../src/integrations/google";
import { connectPartnerGoogle } from "../../../../src/lib/pipeline-store";

/**
 * OAuth callback: verify state (CSRF), exchange the code, enforce the firm
 * domain via the verified id_token (the `hd` request param is cosmetic only),
 * then store the refresh token on the partner row.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("daybrief_oauth_state")?.value;

  const fail = (message: string, status = 400) =>
    new NextResponse(page("Connection failed", message + " — close this tab and try the link again."), {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  if (!code) return fail(`Google returned no code (${req.nextUrl.searchParams.get("error") ?? "unknown error"}).`);
  if (!state || !cookieState || state !== cookieState) return fail("State mismatch (stale or forged request).");

  const client = oauthClient();
  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (e) {
    return fail(`Code exchange failed (${e instanceof Error ? e.message : String(e)}) — the link may have expired.`);
  }
  if (!tokens.id_token) return fail("Google returned no identity token.");
  if (!tokens.refresh_token) return fail("Google returned no refresh token — remove daybrief under myaccount.google.com → Security → Third-party access, then reconnect.");

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env().GOOGLE_OAUTH_CLIENT_ID });
  const payload = ticket.getPayload();
  const email = payload?.email?.toLowerCase();
  const firm = env().FIRM_DOMAIN.toLowerCase();
  if (!email || !(payload?.hd === firm || email.endsWith(`@${firm}`))) {
    return fail(`Only ${firm} accounts can connect.`, 403);
  }

  await connectPartnerGoogle({
    email,
    name: payload?.name ?? email.split("@")[0] ?? email,
    refreshToken: tokens.refresh_token,
  });

  const res = new NextResponse(
    page("Calendar connected", `daybrief will brief ${email}'s external meetings every weekday morning. You can close this tab.`),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
  // Clear with the same path the connect route set, or the delete misses it.
  res.cookies.set("daybrief_oauth_state", "", { maxAge: 0, path: "/api/google" });
  return res;
}

function page(title: string, body: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)} — daybrief</title>
<body style="font-family:ui-sans-serif,system-ui;max-width:520px;margin:15vh auto;padding:0 24px;line-height:1.5">
<h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(body)}</p></body>`;
}
