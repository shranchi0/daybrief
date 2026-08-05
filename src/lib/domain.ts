/**
 * Normalize user-supplied company-domain input ("https://www.Acme.dev/about?x=1",
 * "acme.dev:443") to a bare apex-ish hostname ("acme.dev"). The domain is the
 * companies-table unique key, so every entry point must normalize identically.
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`Invalid domain: "${input}"`);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) throw new Error(`Invalid domain: "${input}"`);
  return host;
}

/** True when a result URL belongs to the given domain (or a subdomain of it). */
export function urlMatchesDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
