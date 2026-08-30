function privateIpv4(value: string) {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 ||
    a === 192 && b === 0 && (c === 0 || c === 2) ||
    a === 192 && b === 88 && c === 99 ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113;
}

function privateIpv6(value: string) {
  const normalized = value.toLowerCase().split("%")[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIpv4(mapped[1]);
  // Fail closed to global-unicast 2000::/3. Teredo, 6to4, documentation, and
  // ORCHID ranges are excluded because they can obscure the ultimate target.
  return !/^[23][0-9a-f]{3}:/.test(normalized) || normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("2001:0000:") || normalized.startsWith("2001:0:") ||
    normalized.startsWith("2001:0010:") || normalized.startsWith("2001:10:") ||
    normalized.startsWith("2001:0020:") || normalized.startsWith("2001:20:") ||
    normalized.startsWith("2001:0db8:") || normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2002:") || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") || normalized.startsWith("fea") ||
    normalized.startsWith("feb") || normalized.startsWith("ff");
}

export function normalizeWordPressSiteUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash ||
    !url.hostname || url.hostname.length > 253 ||
    (url.port && url.port !== "443")
  ) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")
  ) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && privateIpv4(hostname)) {
    return null;
  }
  if (hostname.includes(":") && privateIpv6(hostname)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (/(^|\/)wp-json(?:\/|$)/i.test(path)) return null;
  return `${url.protocol}//${url.host}${path}`;
}

export async function assertPublicWordPressHost(siteUrl: string) {
  const normalized = normalizeWordPressSiteUrl(siteUrl);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return !privateIpv4(hostname);
  if (hostname.includes(":")) return !privateIpv6(hostname);
  try {
    const [ipv4, ipv6] = await Promise.all([
      Deno.resolveDns(hostname, "A").catch(() => []),
      Deno.resolveDns(hostname, "AAAA").catch(() => []),
    ]);
    const addresses = [...ipv4, ...ipv6];
    return addresses.length > 0 &&
      addresses.every((address) => address.includes(":") ? !privateIpv6(address) : !privateIpv4(address));
  } catch {
    return false;
  }
}

export async function safeWordPressFetch(
  siteUrl: string,
  path: string,
  init: RequestInit,
) {
  const normalized = normalizeWordPressSiteUrl(siteUrl);
  if (!normalized || !await assertPublicWordPressHost(normalized)) {
    throw new Error("Unsafe WordPress site URL");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return await fetch(`${normalized}${suffix}`, {
    ...init,
    redirect: "error",
    signal: init.signal || AbortSignal.timeout(20_000),
  });
}
