import { sendTransactionalEmail } from './brevoClient.js';
import {
  passwordChangedEmailHtml,
  passwordResetEmailHtml,
  welcomeEmailHtml,
} from './templates.js';

function frontendBase(): string {
  return (process.env.FRONTEND_URL || 'https://stockpyrou.com.br').replace(/\/$/, '');
}

export function passwordResetTtlMinutes(): number {
  const n = parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '60', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Best-effort: nunca lança. */
export async function sendPasswordResetEmail(params: {
  to: string;
  fullName: string;
  token: string;
}): Promise<boolean> {
  const ttl = passwordResetTtlMinutes();
  const resetUrl = `${frontendBase()}/reset-password?token=${encodeURIComponent(params.token)}`;
  const tpl = passwordResetEmailHtml({
    fullName: params.fullName,
    resetUrl,
    ttlMinutes: ttl,
  });
  return sendTransactionalEmail({
    to: { email: params.to, name: params.fullName || undefined },
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
}

export async function sendPasswordChangedEmail(params: {
  to: string;
  fullName: string;
}): Promise<boolean> {
  const tpl = passwordChangedEmailHtml({ fullName: params.fullName });
  return sendTransactionalEmail({
    to: { email: params.to, name: params.fullName || undefined },
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
}

export async function sendWelcomeEmail(params: {
  to: string;
  fullName: string;
}): Promise<boolean> {
  const tpl = welcomeEmailHtml({
    fullName: params.fullName,
    email: params.to,
    loginUrl: frontendBase(),
  });
  return sendTransactionalEmail({
    to: { email: params.to, name: params.fullName || undefined },
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
}
