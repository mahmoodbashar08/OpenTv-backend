/**
 * Remembering what a target is called, from the write that mentions it.
 *
 * See `migrations/0037_title_names.sql` for why this exists at all. The rules
 * it has to keep are short:
 *
 *   - NEVER FAIL THE WRITE. A rating that succeeded must not turn into a 500
 *     because a name could not be filed. Every failure here is swallowed.
 *   - FIRST WRITER WINS, so one doctored request cannot rename a title for
 *     everybody who comes after.
 *   - NOT A USER-FACING STRING. It labels rows in the admin dashboard and is
 *     served to nobody, which is what makes "trim it and move on" enough
 *     validation.
 */
import type { D1Database } from '@cloudflare/workers-types';

/** Long enough for any real title, short enough that a megabyte cannot be
 *  parked here by sending one. */
const MAX = 200;

export async function rememberTitleName(
  db: D1Database,
  source: string,
  key: string,
  name: unknown,
): Promise<void> {
  if (typeof name !== 'string') return;
  const trimmed = name.trim().slice(0, MAX);
  if (trimmed === '') return;
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO title_names (target_source, target_key, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(source, key, trimmed, new Date().toISOString())
      .run();
  } catch {
    // The write this rode along with has already succeeded. A name is a
    // convenience for one dashboard; losing it is not worth a failed request.
  }
}
