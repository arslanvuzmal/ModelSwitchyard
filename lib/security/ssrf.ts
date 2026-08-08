import { URL } from 'node:url';

/**
 * SSRF (Server-Side Request Forgery) defense for custom provider base URLs.
 *
 * Treats all custom base URLs as hostile input and validates them
 * against a strict allowlist/blocklist before making any outbound requests.
 */

// Private IP ranges (RFC 1918, RFC 4193, RFC 3927, RFC 6598)
const PRIVATE_IP_RANGES = [
  // 127.0.0.0/8 - Loopback
  { start: ipToInt('127.0.0.0'), end: ipToInt('127.255.255.255') },
  // 10.0.0.0/8 - Private Class A
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.255.255.255') },
  // 172.16.0.0/12 - Private Class B
  { start: ipToInt('172.16.0.0'), end: ipToInt('172.31.255.255') },
  // 192.168.0.0/16 - Private Class C
  { start: ipToInt('192.168.0.0'), end: ipToInt('192.168.255.255') },
  // 169.254.0.0/16 - Link-local
  { start: ipToInt('169.254.0.0'), end: ipToInt('169.254.255.255') },
  // 100.64.0.0/10 - Carrier-grade NAT (RFC 6598)
  { start: ipToInt('100.64.0.0'), end: ipToInt('100.127.255.255') },
  // Cloud metadata endpoints
  { start: ipToInt('169.254.169.254'), end: ipToInt('169.254.169.254') },
  // 0.0.0.0/8 - Current network
  { start: ipToInt('0.0.0.0'), end: ipToInt('0.255.255.255') },
];

// Blocked hostname patterns
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.azure.com',
  '169.254.169.254',
  'instance-data.ec2.internal',
  'metadata.packet.net',
];

// Blocked protocols
const ALLOWED_PROTOCOLS = ['https:'];

// Blocked ports (common internal services)
const BLOCKED_PORTS = new Set([
  22, // SSH
  23, // Telnet
  25, // SMTP
  53, // DNS
  110, // POP3
  139, // NetBIOS
  143, // IMAP
  445, // SMB
  631, // IPP
  993, // IMAPS
  995, // POP3S
  1433, // MSSQL
  1521, // Oracle
  3306, // MySQL
  3389, // RDP
  5432, // PostgreSQL
  5900, // VNC
  6379, // Redis
  8080, // HTTP proxy
  8443, // HTTPS alt
  9000, // PHP-FPM
  9200, // Elasticsearch
  27017, // MongoDB
]);

// Maximum response size (10MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// DNS cache for rebinding protection
const dnsCache = new Map<string, { ips: string[]; expiresAt: number }>();
const DNS_CACHE_TTL = 60_000; // 1 minute

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number) as [number, number, number, number];
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function isPrivateIp(ip: string): boolean {
  // Handle IPv6 loopback
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;

  // Handle IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  // Parse IPv4
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;

  const intIp = ipToInt(ip);

  for (const range of PRIVATE_IP_RANGES) {
    if (intIp >= range.start && intIp <= range.end) {
      return true;
    }
  }

  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.some(
    (blocked) => lower === blocked || lower.endsWith(`.${blocked}`),
  );
}

function isAllowedProtocol(protocol: string): boolean {
  return ALLOWED_PROTOCOLS.includes(protocol.toLowerCase());
}

function isBlockedPort(port: number | string): boolean {
  const portNum = typeof port === 'string' ? parseInt(port, 10) : port;
  return BLOCKED_PORTS.has(portNum);
}

/**
 * Resolves a hostname to IPs with caching and rebinding protection.
 * Returns the first non-private IP, or throws if all resolved IPs are private.
 */
export async function safeResolveHostname(hostname: string): Promise<string> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);

  if (cached && cached.expiresAt > now) {
    const publicIp = cached.ips.find((ip) => !isPrivateIp(ip));
    if (publicIp) return publicIp;
    throw new Error(`Hostname ${hostname} resolves only to private IPs`);
  }

  try {
    // Use Node's built-in DNS resolver
    const { promises: dns } = await import('node:dns');
    const addresses = await dns.lookup(hostname, { all: true });

    const ips = addresses.map((a) => a.address);
    const publicIps = ips.filter((ip) => !isPrivateIp(ip));

    if (publicIps.length === 0) {
      dnsCache.set(hostname, { ips, expiresAt: now + DNS_CACHE_TTL });
      throw new Error(`Hostname ${hostname} resolves only to private IPs`);
    }

    dnsCache.set(hostname, { ips, expiresAt: now + DNS_CACHE_TTL });
    return publicIps[0]!;
  } catch (error) {
    if (error instanceof Error && error.message.includes('private IPs')) {
      throw error;
    }
    throw new Error(
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Validates a custom base URL for SSRF protection.
 * Throws if the URL is not allowed.
 */
export function validateBaseUrl(urlString: string): {
  hostname: string;
  port: number;
  protocol: string;
} {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  // Protocol check
  if (!isAllowedProtocol(url.protocol)) {
    throw new Error(`Protocol ${url.protocol} is not allowed. Only HTTPS is permitted.`);
  }

  // Hostname check
  const hostname = url.hostname;
  if (!hostname || isBlockedHostname(hostname)) {
    throw new Error(`Hostname ${hostname} is blocked`);
  }

  // Port check
  const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  if (isBlockedPort(port)) {
    throw new Error(`Port ${port} is blocked`);
  }

  // No credentials in URL
  if (url.username || url.password) {
    throw new Error('URL must not contain credentials');
  }

  // No path traversal in hostname
  if (hostname.includes('..') || hostname.includes('//')) {
    throw new Error('Invalid hostname');
  }

  return { hostname, port, protocol: url.protocol ?? 'https:' };
}

/**
 * Validates a redirect URL during request following.
 * Re-validates against the same rules.
 */
export function validateRedirectUrl(
  redirectUrl: string,
  _originalHostname: string,
): { hostname: string; port: number; protocol: string } {
  const parsed = validateBaseUrl(redirectUrl);

  // Optional: enforce same hostname for redirects (strict mode)
  // if (parsed.hostname !== originalHostname) {
  //   throw new Error(`Redirect to different host ${parsed.hostname} not allowed`);
  // }

  return parsed;
}

/**
 * Creates a fetch wrapper with SSRF protection.
 * - Validates initial URL
 * - Validates redirects
 * - Enforces response size limit
 * - Sets strict timeouts
 */
export function createSafeFetch(
  options: {
    connectTimeoutMs?: number;
    responseTimeoutMs?: number;
    maxResponseSize?: number;
    allowRedirects?: boolean;
    maxRedirects?: number;
  } = {},
) {
  const {
    connectTimeoutMs = 5000,
    responseTimeoutMs = 30000,
    maxResponseSize = MAX_RESPONSE_SIZE,
    allowRedirects = true,
    maxRedirects = 5,
  } = options;

  return async function safeFetch(
    urlString: string,
    init: RequestInit = {},
  ): Promise<Response> {
    // Validate initial URL
    const originalValidation = validateBaseUrl(urlString);
    const originalHostname = originalValidation.hostname;

    let currentUrl = urlString;
    let redirectCount = 0;

    while (true) {
      const controller = new AbortController();
      const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);
      const responseTimer = setTimeout(() => controller.abort(), responseTimeoutMs);

      try {
        const response = await fetch(currentUrl, {
          ...init,
          signal: controller.signal,
          redirect: 'manual',
        });

        clearTimeout(connectTimer);
        clearTimeout(responseTimer);

        // Handle redirects manually
        if (
          allowRedirects &&
          [301, 302, 303, 307, 308].includes(response.status) &&
          redirectCount < maxRedirects
        ) {
          const location = response.headers.get('location');
          if (location) {
            redirectCount++;
            const absoluteUrl = new URL(location, currentUrl).toString();
            validateRedirectUrl(absoluteUrl, originalHostname);
            currentUrl = absoluteUrl;
            continue;
          }
        }

        // Check response size
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxResponseSize) {
          response.body?.cancel?.();
          throw new Error(
            `Response size ${contentLength} exceeds limit ${maxResponseSize}`,
          );
        }

        // Wrap body to enforce size limit during streaming
        if (response.body) {
          let bytesRead = 0;
          const originalReader = response.body.getReader();

          return new Response(
            new ReadableStream({
              async pull(controller) {
                const { done, value } = await originalReader.read();
                if (done) {
                  controller.close();
                  return;
                }
                bytesRead += value.length;
                if (bytesRead > maxResponseSize) {
                  originalReader.cancel();
                  controller.error(
                    new Error(`Response size exceeds limit ${maxResponseSize}`),
                  );
                  return;
                }
                controller.enqueue(value);
              },
              cancel() {
                originalReader.cancel();
              },
            }),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
        }

        return response;
      } catch (error) {
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        throw error;
      }
    }
  };
}
