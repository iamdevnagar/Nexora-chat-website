const codespacesOriginPattern = /^https:\/\/[a-z\d-]+-\d+\.app\.github\.dev$/i;

export function parseClientOrigins(value, production = false) {
  const configuredOrigins = (value || (production ? "" : "http://localhost:5173"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (production && configuredOrigins.length === 0) {
    throw new Error("CLIENT_ORIGIN must contain the HTTPS origin(s) used to open NEXORA in production.");
  }

  for (const origin of configuredOrigins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CLIENT_ORIGIN contains an invalid origin: ${origin}`);
    }

    if (parsed.origin !== origin || (production && parsed.protocol !== "https:")) {
      throw new Error(`CLIENT_ORIGIN must contain exact${production ? " HTTPS" : ""} origins without paths or trailing slashes: ${origin}`);
    }
    if (production && (
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      || parsed.hostname.endsWith(".localhost")
      || codespacesOriginPattern.test(origin)
    )) {
      throw new Error("CLIENT_ORIGIN cannot use localhost or a Codespaces development domain in production.");
    }
  }

  return configuredOrigins;
}

export function isAllowedOrigin(origin, configuredOrigins, allowCodespacesOrigin = false) {
  return !origin
    || configuredOrigins.includes(origin)
    || (allowCodespacesOrigin && codespacesOriginPattern.test(origin));
}
