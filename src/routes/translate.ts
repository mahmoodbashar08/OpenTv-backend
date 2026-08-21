import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { sourceLangOf, isTranslateTarget } from '@/pure';

/**
 * Translating a comment, on demand, into the reader's own language.
 *
 * SIX LANGUAGES SHIPPED AND NO WAY TO READ ACROSS THEM is the gap this closes.
 * A comment written in Arabic is invisible to a French reader today, which
 * makes the six locales a translation of the CHROME and not of the community.
 *
 * WHY IT IS ALLOWED TO EXIST AT ALL. The comment is already stored on this
 * server, so running the model here sends it nowhere new. Google Translate or
 * DeepL would mean every comment anybody ever taps leaves for a third party —
 * for a project whose whole argument is that your words stay where you put
 * them, that is not a pricing decision, it is a design one.
 *
 * ON DEMAND, NEVER IN BULK. Pre-translating the archive into six languages is
 * fifty thousand calls for text nobody may ever read in another language. A tap
 * means somebody wanted this one.
 *
 * AND CACHED FOR EVER, which is what makes the cost bounded rather than
 * per-scroll: a comment is translated once per language and every later reader
 * gets the stored row. See migration 0023.
 */

export const translate = new Hono<App>();

/** Cloudflare's multilingual translation model. See AiTranslationInput. */
const MODEL = '@cf/meta/m2m100-1.2b';

/**
 * Long comments are truncated rather than refused.
 *
 * The alternative is an error on the one comment somebody most wanted to read,
 * and a 2,000-character comment translated to its first 2,000 characters is
 * still the thing they asked for. The app shows the original underneath.
 */
const MAX_CHARS = 2000;

translate.post('/comments/:id/translate', requireAuth, async (c) => {
  // ABSENT BINDING IS A 404, not a 500. Every capability on this Worker is
  // optional, so a deployment without Workers AI simply does not have this
  // feature — the app reads the code and never shows the row again.
  if (!c.env.AI) return fail(c, 404, 'unavailable', 'Translation is not enabled.');

  const id = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const lang = (body as Record<string, unknown>)?.lang;
  if (!isTranslateTarget(lang)) {
    return fail(c, 400, 'invalid_body', 'lang must be one of the app languages.');
  }

  // THE CACHE FIRST, and it answers most requests: a busy thread is the same
  // handful of comments read by many people in the same few languages.
  const hit = await c.env.DB.prepare('SELECT text, source_lang FROM comment_translations WHERE comment_id = ? AND lang = ?')
    .bind(id, lang)
    .first<{ text: string; source_lang: string | null }>();
  if (hit) return c.json({ text: hit.text, source_lang: hit.source_lang, cached: true });

  /*
   * DELETED AND HIDDEN COMMENTS ARE NOT TRANSLATED, and the filter is the same
   * `deleted_at IS NULL AND hidden_at IS NULL` every thread read uses. A comment
   * removed by moderation must not be readable through a second route — without
   * this line the translation endpoint is a way to read exactly what was taken
   * down, in any language you like.
   */
  const row = await c.env.DB.prepare(
    'SELECT body, lang FROM comments WHERE id = ? AND deleted_at IS NULL AND hidden_at IS NULL',
  )
    .bind(id)
    .first<{ body: string; lang: string | null }>();
  if (!row) return fail(c, 404, 'not_found', 'No such comment.');

  /*
   * THE TEXT DECIDES WHEN IT CAN. See `sourceLangOf`: the stored `lang` is the
   * writer's INTERFACE language, not the language they typed in, and trusting
   * it made every Arabic comment written on an English phone answer `same` --
   * the Translate button doing nothing for exactly the comments that needed it.
   */
  const source = sourceLangOf(row.lang, row.body);
  // ALREADY IN THAT LANGUAGE: answer without spending a call. The app hides the
  // row when it can tell, but it cannot always tell, and this is where the
  // question is actually answerable.
  if (source === lang) return c.json({ text: row.body, source_lang: source, cached: false, same: true });

  let text: string;
  try {
    const out = (await c.env.AI.run(MODEL, {
      text: row.body.slice(0, MAX_CHARS),
      source_lang: source,
      target_lang: lang,
    })) as { translated_text?: string };
    if (!out.translated_text) throw new Error('empty');
    text = out.translated_text;
  } catch {
    // A model that is down or rate-limited must not look like a missing
    // comment: the app retries this, and shows the original meanwhile.
    return fail(c, 503, 'translate_failed', 'Could not translate right now.');
  }

  // INSERT OR IGNORE: two readers can ask for the same comment in the same
  // language at once, and the loser of that race must not 500 over a primary
  // key. Both get the same text either way.
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO comment_translations (comment_id, lang, text, source_lang, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, lang, text, source, Date.now())
    .run();

  return c.json({ text, source_lang: source, cached: false });
});
