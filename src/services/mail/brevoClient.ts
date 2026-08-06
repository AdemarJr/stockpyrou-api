export type SendEmailInput = {
  to: string | { email: string; name?: string };
  subject: string;
  html: string;
  text?: string;
};

function senderFromEnv(): { email: string; name: string } | null {
  const email = (process.env.BREVO_SENDER_EMAIL || '').trim();
  if (!email) return null;
  const name = (process.env.BREVO_SENDER_NAME || 'Stockpyrou').trim();
  return { email, name };
}

export function isMailConfigured(): boolean {
  return !!(process.env.BREVO_API_KEY || '').trim() && !!senderFromEnv();
}

/**
 * Envia e-mail transacional via Brevo HTTP API.
 * Não lança se não configurado — retorna false.
 */
export async function sendTransactionalEmail(input: SendEmailInput): Promise<boolean> {
  const apiKey = (process.env.BREVO_API_KEY || '').trim();
  const sender = senderFromEnv();
  if (!apiKey || !sender) {
    console.warn('[mail] BREVO_API_KEY ou BREVO_SENDER_EMAIL ausente — e-mail não enviado');
    return false;
  }

  const to =
    typeof input.to === 'string'
      ? [{ email: input.to }]
      : [{ email: input.to.email, name: input.to.name }];

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender,
        to,
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text || stripHtml(input.html),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[mail] Brevo error', res.status, body.slice(0, 400));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[mail] Brevo request failed:', err);
    return false;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
