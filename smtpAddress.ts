/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Where an SMTP server is, looked up the way the rest of the server looks
// hosts up (the operating system's resolver — dns.lookup, the same one IMAP
// and every other connection use).
//
// nodemailer resolves the SMTP host itself with c-ares (dns.resolve4 /
// resolve6), asking the DNS servers directly. On a server whose network only
// lets the system resolver through (some office / Windows / firewalled
// hosts), that times out — "DNS lookup for <host> timed out" — while reading
// mail (IMAP) works. Handing nodemailer the IP skips its own lookup; the TLS
// certificate is still checked against the real name (servername).

import dns from "node:dns";
import net from "node:net";

export async function smtpAddress(host: string, timeoutMs = 10_000): Promise<{ host: string; servername?: string }> {
  const name = String(host || "").trim();
  if (!name || net.isIP(name)) return { host: name };
  try {
    const found = await Promise.race([
      dns.promises.lookup(name, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
    ]);
    // IPv4 first: many servers have no working IPv6 route.
    const pick = found.find((a) => a.family === 4) || found[0];
    return pick ? { host: pick.address, servername: name } : { host: name };
  } catch {
    // Let nodemailer try on its own (and report its own error).
    return { host: name };
  }
}
