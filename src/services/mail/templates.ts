function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr><td style="background:#2563eb;padding:20px 24px;color:#fff;font-size:20px;font-weight:700;">Stockpyrou</td></tr>
        <tr><td style="padding:28px 24px;">
          <h1 style="margin:0 0 12px;font-size:18px;color:#111827;">${title}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 24px;background:#f9fafb;color:#6b7280;font-size:12px;">
          Este é um e-mail automático. Não responda.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function passwordResetEmailHtml(params: { fullName: string; resetUrl: string; ttlMinutes: number }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Recuperação de senha — Stockpyrou';
  const html = layout(
    'Recuperação de senha',
    `<p style="margin:0 0 12px;line-height:1.5;">Olá${params.fullName ? `, ${escapeHtml(params.fullName)}` : ''},</p>
     <p style="margin:0 0 16px;line-height:1.5;">Recebemos um pedido para redefinir a senha da sua conta. Clique no botão abaixo. O link expira em <strong>${params.ttlMinutes} minutos</strong>.</p>
     <p style="margin:0 0 20px;"><a href="${escapeAttr(params.resetUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Redefinir senha</a></p>
     <p style="margin:0 0 8px;line-height:1.5;font-size:13px;color:#6b7280;">Se o botão não funcionar, copie e cole este link no navegador:</p>
     <p style="margin:0;word-break:break-all;font-size:12px;color:#2563eb;">${escapeHtml(params.resetUrl)}</p>
     <p style="margin:16px 0 0;line-height:1.5;font-size:13px;color:#6b7280;">Se você não solicitou isso, ignore este e-mail.</p>`,
  );
  const text = `Recuperação de senha Stockpyrou\n\nAcesse: ${params.resetUrl}\nVálido por ${params.ttlMinutes} minutos.\nSe não solicitou, ignore.`;
  return { subject, html, text };
}

export function passwordChangedEmailHtml(params: { fullName: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Senha alterada — Stockpyrou';
  const html = layout(
    'Senha alterada',
    `<p style="margin:0 0 12px;line-height:1.5;">Olá${params.fullName ? `, ${escapeHtml(params.fullName)}` : ''},</p>
     <p style="margin:0 0 12px;line-height:1.5;">A senha da sua conta Stockpyrou foi alterada com sucesso.</p>
     <p style="margin:0;line-height:1.5;font-size:13px;color:#6b7280;">Se não foi você, entre em contato com o administrador imediatamente.</p>`,
  );
  const text = `A senha da sua conta Stockpyrou foi alterada. Se não foi você, contate o administrador.`;
  return { subject, html, text };
}

export function welcomeEmailHtml(params: {
  fullName: string;
  email: string;
  loginUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = 'Bem-vindo ao Stockpyrou';
  const html = layout(
    'Conta criada',
    `<p style="margin:0 0 12px;line-height:1.5;">Olá${params.fullName ? `, ${escapeHtml(params.fullName)}` : ''},</p>
     <p style="margin:0 0 12px;line-height:1.5;">Sua conta foi criada no Stockpyrou.</p>
     <p style="margin:0 0 8px;line-height:1.5;"><strong>E-mail:</strong> ${escapeHtml(params.email)}</p>
     <p style="margin:0 0 16px;line-height:1.5;">A senha inicial foi definida pelo administrador. Use-a no primeiro acesso e altere-a nas configurações se desejar.</p>
     <p style="margin:0;"><a href="${escapeAttr(params.loginUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Acessar o sistema</a></p>`,
  );
  const text = `Bem-vindo ao Stockpyrou.\nE-mail: ${params.email}\nAcesse: ${params.loginUrl}\nA senha foi definida pelo administrador.`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
