import type { Env } from '@/env';

/**
 * Sending email, when there is somewhere to send it from.
 *
 * WORKS BEFORE THE DOMAIN EXISTS. Without `RESEND_API_KEY` this reports
 * `false` and sends nothing, and every caller is written to carry on: an
 * account is still created, a reset token is still issued. The alternative —
 * refusing to register anybody until DNS is configured — would make the whole
 * feature untestable until the last piece arrives, which is exactly backwards.
 *
 * NEVER THROWS, NEVER BLOCKS. A provider outage must not fail a signup that has
 * already succeeded in the database; the user can ask for another link. Callers
 * hand this to `ctx.waitUntil` where they can.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: log the address or the token. A Worker's
 * logs are a second copy of everything they touch, and a reset token in a log
 * line is a live key sitting somewhere nobody is guarding.
 */
export type MailResult = { sent: boolean; reason?: 'not_configured' | 'failed' };

async function send(env: Env, to: string, subject: string, text: string, html: string): Promise<MailResult> {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  if (!key || !from) return { sent: false, reason: 'not_configured' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    return res.ok ? { sent: true } : { sent: false, reason: 'failed' };
  } catch {
    return { sent: false, reason: 'failed' };
  }
}

/**
 * The link people click. A deep link into the app rather than a web page,
 * because there is no web app — the app is the only thing that can complete it.
 */
function verifyLink(env: Env, token: string): string {
  const base = env.APP_LINK_BASE ?? 'ourtvtime://verify-email';
  return `${base}?token=${encodeURIComponent(token)}`;
}

function resetLink(env: Env, token: string): string {
  const base = env.APP_RESET_LINK_BASE ?? 'ourtvtime://reset-password';
  return `${base}?token=${encodeURIComponent(token)}`;
}

/** Plain text alongside HTML on purpose: some clients show one, some the other,
 *  and a mail with only HTML is more likely to be scored as spam. */
export async function sendVerificationEmail(env: Env, to: string, token: string): Promise<MailResult> {
  const link = verifyLink(env, token);
  return send(
    env,
    to,
    'Confirm your OpenTV email',
    `Confirm your email address to finish setting up OpenTV.\n\n${link}\n\nThis link expires in 24 hours. If you did not create an OpenTV account, ignore this message — nothing will happen.`,
    `<p>Confirm your email address to finish setting up OpenTV.</p>
     <p><a href="${link}">Confirm my email</a></p>
     <p>This link expires in 24 hours. If you did not create an OpenTV account, ignore this message — nothing will happen.</p>`,
  );
}

export async function sendResetEmail(env: Env, to: string, token: string): Promise<MailResult> {
  const link = resetLink(env, token);
  return send(
    env,
    to,
    'Reset your OpenTV password',
    `Someone asked to reset the password for this OpenTV account.\n\n${link}\n\nThis link expires in one hour. If it was not you, ignore this message — your password has not changed.`,
    `<p>Someone asked to reset the password for this OpenTV account.</p>
     <p><a href="${link}">Choose a new password</a></p>
     <p>This link expires in one hour. If it was not you, ignore this message — your password has not changed.</p>`,
  );
}
