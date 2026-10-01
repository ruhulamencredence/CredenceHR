/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Small shared SMTP mailer — added for Payroll's "Email Payslips" feature
// (see PayrollRoutes.ts's /api/payroll/:id/email and /api/payroll/email-bulk).
// Reads standard SMTP_* env vars (see .env.example); if they're not set,
// isMailerConfigured() reports false and callers surface a clear "email
// isn't set up yet" error instead of attempting to send.
//
// nodemailer is imported lazily (dynamic import) so that a server that
// hasn't run `npm install` yet after this feature was added still boots
// normally — every other route keeps working, only the email routes report
// the missing dependency.

let cachedTransporter: any = null;
let importFailed = false;

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function getTransporter(): Promise<any> {
  if (cachedTransporter) return cachedTransporter;
  if (importFailed || !smtpConfigured()) return null;
  try {
    // @ts-ignore - optional dependency; add to package.json (already done)
    // and run `npm install` to enable actual sending.
    const nodemailer: any = await import("nodemailer");
    const factory = nodemailer.default || nodemailer;
    cachedTransporter = factory.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    return cachedTransporter;
  } catch (err) {
    importFailed = true;
    console.warn("⚠️ nodemailer isn't installed yet — run `npm install` to enable Email Payslips.");
    return null;
  }
}

export function isMailerConfigured(): boolean {
  return smtpConfigured();
}

export async function sendMail(opts: { to: string; subject: string; html: string }): Promise<{ success: boolean; error?: string }> {
  const transporter = await getTransporter();
  if (!transporter) {
    return {
      success: false,
      error: "Email sending isn't set up on the server yet — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env and run `npm install` (for nodemailer), then restart the server."
    };
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: opts.to,
      subject: opts.subject,
      html: opts.html
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || "Failed to send email." };
  }
}
