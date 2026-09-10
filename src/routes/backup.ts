import { Hono, type Context } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { plusOn } from '@/pure';

/**
 * The library, kept somewhere that is not the phone.
 *
 * WHY THIS EXISTS, GIVEN THE WHOLE APP IS BUILT NOT TO NEED IT. The phone's
 * SQLite database is still the source of truth and nothing here changes that.
 * But a decade of watch history that exists on exactly one device is one
 * dropped phone away from gone, and iCloud and Google Drive each solve that for
 * half the users and neither solves it for somebody moving between the two.
 * This is the third destination, and it is the only one that crosses.
 *
 * WHAT IS ACTUALLY STORED: one object per profile, overwritten in place — the
 * same TV Time-format ZIP `exporter.ts` builds, byte for byte, the same one
 * iCloud and Drive already hold. No new format, no server-side parsing, and no
 * watch-history TABLE: this server still cannot answer "what did they watch",
 * because the answer is a ZIP it never opens.
 *
 * ⚠️ STORED AS SENT, NOT ENCRYPTED BY US. The bytes travel over TLS and sit in
 * R2 at rest, but a copy of somebody's library is on this server, readable by
 * whoever holds the R2 credentials — which is a real change from "your library
 * never leaves your phone" and must be said plainly wherever it is offered.
 * That is why the whole feature is opt-in and off by default, why the settings
 * row says it in those words, and why `DELETE` below exists and is not gated on
 * anything. If this is ever encrypted on the device, only the phone changes:
 * this route already treats the body as opaque.
 *
 * PLUS GATES WRITING, NEVER READING. Uploading needs a subscription; getting
 * the copy back and deleting it do not. A backup that becomes unreachable when
 * a card expires is not a backup, it is a hostage — and the one promise this
 * project cannot break is that a user's own history is theirs.
 */

export const backup = new Hono<App>();

/** One object per profile, overwritten in place, so nobody can fill a bucket
 *  by pressing backup twice. Derived from the session, never from input. */
const keyFor = (profileId: string): string => `backups/${profileId}.zip`;

/**
 * Generous next to what a real library measures. The heaviest genuine export
 * seen is 194 KB compressed — these are CSVs, not images — so this is a guard
 * against something having gone wrong, not a budget anybody spends.
 */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

/** The counts the welcome screen greets somebody with, carried beside the ZIP
 *  rather than inside it so a phone can ask "what is up there" without
 *  downloading a library to find out. Base64 because a handle is not ASCII. */
type BackupInfo = {
  username?: string | null;
  shows?: number | null;
  episodes?: number | null;
  movies?: number | null;
};

/**
 * UTF-8 THROUGH BASE64, NOT `atob` ALONE. `atob` yields one character per
 * BYTE, so a handle written in Arabic — or any name outside Latin-1 — comes
 * back as mojibake if the result is parsed as a string. The phone encodes
 * UTF-8 before base64 (`stringToB64` in `backup.ts`), so this has to decode it
 * the same way round.
 */
function decodeUtf8B64(raw: string): string {
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function readInfoHeader(raw: string | undefined): BackupInfo {
  if (!raw) return {};
  try {
    const json = JSON.parse(decodeUtf8B64(raw)) as unknown;
    if (!json || typeof json !== 'object') return {};
    const o = json as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
    return {
      // Capped rather than validated: this is redisplayed to its own owner and
      // to nobody else, so the only thing worth defending against is size.
      username: typeof o.username === 'string' ? o.username.slice(0, 64) : null,
      shows: num(o.shows),
      episodes: num(o.episodes),
      movies: num(o.movies),
    };
  } catch {
    // A malformed header must not fail an upload that is otherwise fine. The
    // ZIP is the backup; this is a label on it.
    return {};
  }
}

/** R2 custom metadata is a string map, so the counts go out and come back as
 *  strings. Kept in one place so the two directions cannot drift. */
const toMetadata = (i: BackupInfo): Record<string, string> => {
  const out: Record<string, string> = {};
  if (i.username) out.username = i.username;
  if (i.shows != null) out.shows = String(i.shows);
  if (i.episodes != null) out.episodes = String(i.episodes);
  if (i.movies != null) out.movies = String(i.movies);
  return out;
};

const fromMetadata = (m: Record<string, string> | undefined): BackupInfo => {
  const n = (v: string | undefined): number | null => (v == null || v === '' ? null : Number(v));
  return {
    username: m?.username ?? null,
    shows: n(m?.shows),
    episodes: n(m?.episodes),
    movies: n(m?.movies),
  };
};

/** Both ways Plus can be true — the webhook's flag, or a hand-granted date. */
async function isPlus(c: Context<App>): Promise<boolean> {
  const row = await c.env.DB.prepare(
    'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(c.get('profileId'))
    .first<{ is_plus: number | null; plus_until: string | null }>();
  return row ? plusOn(row, new Date().toISOString()) : false;
}

// ── write ────────────────────────────────────────────────────────────────────

backup.put('/backup', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Cloud backup is not configured.');
  if (!(await isPlus(c)))
    return fail(c, 402, 'plus_required', 'Cloud backup needs OpenTV Plus.');

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return fail(c, 400, 'invalid_body', 'Empty backup.');
  if (body.byteLength > MAX_BACKUP_BYTES)
    return fail(c, 413, 'too_large', 'That backup is larger than this server accepts.');

  const info = readInfoHeader(c.req.header('X-OpenTV-Backup-Info'));
  await bucket.put(keyFor(c.get('profileId')), body, {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: toMetadata(info),
  });

  return c.json({ ok: true, size: body.byteLength, updatedAt: new Date().toISOString() });
});

// ── read ─────────────────────────────────────────────────────────────────────

/**
 * What is up there, without downloading it — the question the welcome screen
 * asks on a fresh install, where the answer decides whether a "restore your
 * library" button appears at all.
 */
backup.get('/backup/info', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return c.json({ exists: false });

  const head = await bucket.head(keyFor(c.get('profileId')));
  if (!head) return c.json({ exists: false });

  return c.json({
    exists: true,
    size: head.size,
    updatedAt: head.uploaded?.toISOString?.() ?? null,
    ...fromMetadata(head.customMetadata),
  });
});

/** The ZIP itself. Not Plus-gated — see the header. */
backup.get('/backup', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Cloud backup is not configured.');

  const object = await bucket.get(keyFor(c.get('profileId')));
  if (!object) return fail(c, 404, 'not_found', 'There is no backup for this account.');

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/zip',
      // Never cached: a backup that answers with last week's copy is worse
      // than one that answers with nothing.
      'Cache-Control': 'no-store',
    },
  });
});

// ── delete ───────────────────────────────────────────────────────────────────

/**
 * Take it back off the server. Deliberately ungated and deliberately
 * unconfirmed here — the phone asks; this obeys. Idempotent, so a second press
 * after a dropped connection is not an error.
 */
backup.delete('/backup', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return c.json({ ok: true });
  await bucket.delete(keyFor(c.get('profileId')));
  return c.json({ ok: true });
});
