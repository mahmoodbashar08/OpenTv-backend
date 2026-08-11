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
/**
 * `opentv://`, not the old `ourtvtime://`. Safe to switch outright because
 * email sign-in ships in 1.3.0 and 1.3.0 is unreleased — no build in anyone's
 * hands can receive one of these messages. The app still registers the old
 * scheme so anything sent during testing keeps working.
 */
function verifyLink(env: Env, token: string): string {
  const base = env.APP_LINK_BASE ?? 'opentv://verify-email';
  return `${base}?token=${encodeURIComponent(token)}`;
}

function resetLink(env: Env, token: string): string {
  const base = env.APP_RESET_LINK_BASE ?? 'opentv://reset-password';
  return `${base}?token=${encodeURIComponent(token)}`;
}

/**
 * The one email layout, in the app's own colours.
 *
 * TABLES AND INLINE STYLES, deliberately. Outlook renders through Word, which
 * ignores a stylesheet, most of flexbox, and a background on a `div` — the
 * things that make this look like 2005 are the things that make it survive.
 *
 * DARK, BUT NOT ONLY DARK. `bgcolor` paints the shell for clients that drop
 * CSS, and a light-mode reader still sees light text on the dark card rather
 * than white on white. `color-scheme` stops iOS Mail inverting it a second time.
 *
 * THE LINK IS ALSO PRINTED AS TEXT. A deep link into an app is exactly the
 * shape a corporate scanner rewrites or a client refuses to make clickable, and
 * a button nobody can press is a dead end with no way round it.
 */
function layout(
  heading: string,
  body: string,
  cta: string,
  link: string,
  footnote: string,
  code?: string,
): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="color-scheme" content="dark light" /></head>
<body style="margin:0;padding:0;background:#0d0d0f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0d0d0f" style="background:#0d0d0f;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
      <tr><td align="center" style="padding-bottom:20px;font:800 20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#ffd400;letter-spacing:.04em;">OPENTV</td></tr>
      <tr><td bgcolor="#16161a" style="background:#16161a;border-radius:14px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#e9e9ee;line-height:1.3;">${heading}</p>
        <p style="margin:0 0 26px;font-size:15px;color:#a7a7ae;line-height:1.6;">${body}</p>
        ${code
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
               <tr><td bgcolor="#0d0d0f" align="center" style="background:#0d0d0f;border-radius:12px;padding:18px 12px;">
                 <div style="font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8a8a92;letter-spacing:.08em;text-transform:uppercase;">Or enter this code</div>
                 <div style="font:700 34px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ffd400;letter-spacing:.22em;padding-top:8px;">${code}</div>
               </td></tr>
             </table>`
          : ''}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="#ffd400" style="background:#ffd400;border-radius:10px;">
            <a href="${link}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#000000;text-decoration:none;">${cta}</a>
          </td>
        </tr></table>
        <p style="margin:24px 0 0;font-size:13px;color:#6b6b72;line-height:1.6;">${footnote}</p>
        <p style="margin:14px 0 0;font-size:12px;color:#6b6b72;line-height:1.6;word-break:break-all;">Or paste this into your browser:<br /><span style="color:#8a8a92;">${link}</span></p>
      </td></tr>
      <tr><td align="center" style="padding-top:20px;font:400 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#6b6b72;line-height:1.6;">
        Your library and watch history stay on your phone.<br />
        <a href="https://theopentv.com" style="color:#6b6b72;text-decoration:underline;">theopentv.com</a> &nbsp;·&nbsp; Insightfy LLC
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Plain text alongside HTML on purpose: some clients show one, some the other,
 *  and a mail with only HTML is more likely to be scored as spam. */
/**
 * A LINK AND A CODE, because the link only works on the device holding the
 * email. Reading it on a phone while signing in on a tablet or a simulator
 * leaves nothing to tap; the code can be carried across the room. The plain
 * text carries both for the same reason.
 */
export async function sendVerificationEmail(
  env: Env,
  to: string,
  token: string,
  code?: string,
): Promise<MailResult> {
  const link = verifyLink(env, token);
  const spoken = code ? `\n\nOr enter this code in the app: ${code}` : '';
  return send(
    env,
    to,
    'Confirm your OpenTV email',
    `Confirm your email address to finish setting up OpenTV.\n\n${link}${spoken}\n\nThis expires in 24 hours. If you did not create an OpenTV account, ignore this message — nothing will happen.`,
    layout(
      'Confirm your email',
      code
        ? 'Tap the button on the phone OpenTV is installed on, or type the code below into the app on any device.'
        : 'One tap and your OpenTV account is ready. Open this on the phone you installed OpenTV on — the link opens the app.',
      'Confirm my email',
      link,
      'This expires in 24 hours. If you did not create an OpenTV account, ignore this message — nothing will happen.',
      code,
    ),
  );
}

export async function sendResetEmail(env: Env, to: string, token: string): Promise<MailResult> {
  const link = resetLink(env, token);
  return send(
    env,
    to,
    'Reset your OpenTV password',
    `Someone asked to reset the password for this OpenTV account.\n\n${link}\n\nThis link expires in one hour. If it was not you, ignore this message — your password has not changed.`,
    layout(
      'Reset your password',
      'Someone asked to reset the password for this OpenTV account. Open this on the phone you installed OpenTV on.',
      'Choose a new password',
      link,
      'This link expires in one hour. If it was not you, ignore this message — your password has not changed, and no further action is needed.',
    ),
  );
}
