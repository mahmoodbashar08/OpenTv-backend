/**
 * Delivering a notification to a phone.
 *
 * The ROW is the record and this is the doorbell. Every notification is already
 * written by the handler that caused it, in the same batch; this reads the
 * recipient's devices and asks Expo to wake them. If it fails, the row is still
 * there and the app shows it on next open — which is why nothing here is
 * awaited by a request that a user is waiting on.
 *
 * WHY EXPO AND NOT APNs/FCM DIRECTLY. Two protocols, two credential formats and
 * a JWT signer inside a Worker, versus one POST. Expo's service is free and
 * sits in front of both. The cost is a third party between this server and the
 * user, which for "someone liked your comment" is the right trade; it would not
 * be for anything a person must receive.
 *
 * NO TITLES THAT LEAK. A push carries the actor's handle and the kind, never the
 * body of a comment: a lock screen is read by whoever is holding the phone, and
 * a spoiler-flagged reply must not arrive as its own spoiler.
 */
import type { Env } from '@/env';

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';

/** Expo rejects a batch of more than 100. */
const BATCH = 100;

export type PushKind = 'follow' | 'like' | 'reply' | 'comment' | 'shared_list_add' | 'shared_list_join';

type Message = {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  /**
   * ANDROID ONLY, AND IGNORED EVERYWHERE ELSE.
   *
   * Android 8 and later will not display a notification that does not belong to
   * a channel, so Expo drops anything unnamed into a fallback one called
   * "Miscellaneous". That works, and it is why this was not obviously broken —
   * but it puts "someone replied to you" in the same bucket as an episode
   * reminder, under a name nobody chose, which is what the user actually sees
   * when they go to silence one and not the other.
   *
   * The channel is CREATED BY THE APP (`registerForPush` in mobile/src/push.ts)
   * and only NAMED here. A channelId the phone has never created falls back to
   * Miscellaneous again, so the two must stay in step: this string and that one.
   *
   * iOS has no such concept and ignores the field.
   */
  channelId: 'community';
  /** What the app opens. Mirrors the in-app row's destination. */
  data: { kind: PushKind; subjectId: string | null; handle: string | null };
};

/**
 * The one line a phone shows. Deliberately not translated: the server does not
 * know the reader's language, and a wrong-language push is worse than a plain
 * one. The app's own list is translated and is where the detail lives.
 */
function line(kind: PushKind, who: string): { title: string; body: string } {
  switch (kind) {
    case 'follow':
      return { title: 'OpenTV', body: `${who} followed you` };
    case 'like':
      return { title: 'OpenTV', body: `${who} liked your comment` };
    case 'reply':
      return { title: 'OpenTV', body: `${who} replied to you` };
    case 'comment':
      return { title: 'OpenTV', body: `${who} commented` };
    // A shared list is the one thing here that asks the reader to DO something
    // -- go and look at what was suggested -- so its line names the act rather
    // than the object.
    case 'shared_list_add':
      return { title: 'OpenTV', body: `${who} added something to your shared list` };
    case 'shared_list_join':
      return { title: 'OpenTV', body: `${who} joined your shared list` };
  }
}

/** Live tokens for one profile. */
async function tokensFor(env: Env, profileId: string): Promise<{ token: string }[]> {
  const res = await env.DB.prepare(
    'SELECT token FROM push_tokens WHERE profile_id = ? AND disabled_at IS NULL',
  )
    .bind(profileId)
    .all<{ token: string }>();
  return res.results ?? [];
}

/**
 * Retire the tokens Expo says are gone.
 *
 * `DeviceNotRegistered` means the app was deleted or the token rotated. Left in
 * place it is a request per event forever, against a phone that will never
 * answer.
 */
async function disable(env: Env, tokens: string[], nowIso: string): Promise<void> {
  if (tokens.length === 0) return;
  const holes = tokens.map(() => '?').join(',');
  await env.DB.prepare(`UPDATE push_tokens SET disabled_at = ? WHERE token IN (${holes})`)
    .bind(nowIso, ...tokens)
    .run();
}

/**
 * Wake `recipientId`'s devices. Never throws.
 *
 * Call it WITHOUT awaiting from a request handler, or pass it to
 * `ctx.waitUntil` — a like that waits on Expo is a like that feels slow, and
 * the notification row has already been written by then either way.
 */
export async function sendPush(
  env: Env,
  recipientId: string,
  actorId: string,
  kind: PushKind,
  subjectId: string | null,
): Promise<void> {
  try {
    // Tokens first: the overwhelmingly common case is a recipient with none,
    // and looking up a name to address nobody is a query for nothing.
    const rows = await tokensFor(env, recipientId);
    if (rows.length === 0) return;

    // The handle is read here rather than threaded through every call site —
    // `requireAuth` puts only `profileId` on the context, so each handler would
    // otherwise repeat this query for a push that usually has no one to reach.
    const actor = await env.DB.prepare('SELECT handle, display_name FROM profiles WHERE id = ?')
      .bind(actorId)
      .first<{ handle: string; display_name: string | null }>();
    const who = actor?.display_name || actor?.handle || 'Someone';
    const handle = actor?.handle ?? null;

    const { title, body } = line(kind, who);
    const messages: Message[] = rows.map((r) => ({
      to: r.token,
      title,
      body,
      sound: 'default',
      channelId: 'community',
      data: { kind, subjectId, handle },
    }));

    const nowIso = new Date().toISOString();
    for (let i = 0; i < messages.length; i += BATCH) {
      const slice = messages.slice(i, i + BATCH);
      const res = await fetch(EXPO_SEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(slice),
      });
      if (!res.ok) continue;

      // Expo answers per message, in order, and reports a dead token as an
      // error rather than an HTTP failure.
      const json = (await res.json()) as { data?: { status?: string; details?: { error?: string } }[] };
      const dead = (json.data ?? [])
        .map((d, n) => (d?.details?.error === 'DeviceNotRegistered' ? slice[n]?.to : null))
        .filter((tk): tk is string => tk != null);
      await disable(env, dead, nowIso);
    }
  } catch {
    // The row is written and the app will show it. A doorbell that does not ring
    // is not a reason to fail the action that caused it.
  }
}
