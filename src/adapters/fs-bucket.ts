/**
 * R2, spoken by a directory on disk.
 *
 * Pictures and avatars are the only things this server stores as bytes, and on
 * Cloudflare they live in R2. A self-hosted instance has a filesystem instead,
 * which is enough: the app never lists a bucket, never copies between keys and
 * never asks for a presigned URL — it puts an object under a key and later gets
 * it back. That was three methods; it is four now, for the reason below.
 *
 * NO MinIO, NO S3, deliberately. The reference self-hosted tracker in this
 * space needs Postgres, Redis, MinIO and five DNS records; the whole reason
 * OpenTV can be one container is that it never needed any of them. Adding an
 * object store to get an object store back would throw that away.
 *
 * FOUR NOW, NOT THREE. `head` arrived with cloud backup: the app asks "is
 * there one, how big, and whose" before offering to restore, and that question
 * is a head, not a get — nobody downloads a library to find out it exists.
 * Without it `GET /v1/backup/info` threw on every self-hosted instance, the app
 * read the failure as "no backup on this account", and a library that had
 * uploaded perfectly could never be found again. Written, and never restorable,
 * is the worst state a backup can be in.
 *
 * KEYS CONTAIN SLASHES — `comments/c_abc.jpg` — so they become directories, and
 * a key is refused if it tries to climb out of the root. Nothing in the app
 * builds a key from user input today, but "today" is how directory traversal
 * always arrives.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

type PutOptions = { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };

export function fsBucket(root: string): R2Bucket {
  mkdirSync(root, { recursive: true });
  const base = resolve(root);

  /** The file for a key, or null if the key points outside the bucket. */
  const fileFor = (key: string): string | null => {
    const full = resolve(join(base, key));
    return full === base || full.startsWith(base + sep) ? full : null;
  };
  /* The content type is R2 metadata, not a file attribute, so it is kept
     beside the object rather than guessed from the extension later — a GIF
     served as `application/octet-stream` downloads instead of animating. */
  const metaFor = (file: string) => `${file}.type`;
  /* R2 keeps arbitrary string pairs on an object; a filesystem does not, so
     they ride in a sidecar of their own. The backup's row counts live here —
     `head` is the only thing that reads them, and it is what decides whether
     the app offers a restore at all. */
  const customFor = (file: string) => `${file}.meta.json`;

  return {
    async put(key: string, value: ArrayBuffer | ArrayBufferView, opts?: PutOptions) {
      const file = fileFor(key);
      if (file == null) throw new Error(`Refusing to write outside the bucket: ${key}`);
      mkdirSync(dirname(file), { recursive: true });
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
      writeFileSync(file, bytes);
      const type = opts?.httpMetadata?.contentType;
      if (type) writeFileSync(metaFor(file), type, 'utf8');
      const custom = opts?.customMetadata;
      if (custom) writeFileSync(customFor(file), JSON.stringify(custom), 'utf8');
      return {
        key,
        size: bytes.byteLength,
        etag: createHash('md5').update(bytes).digest('hex'),
      } as never;
    },

    async get(key: string) {
      const file = fileFor(key);
      // A miss is null, exactly as R2 answers it — every caller here treats
      // that as a 404, and throwing instead would turn a missing picture into
      // a 500.
      if (file == null || !existsSync(file)) return null;
      const body = readFileSync(file);
      const typeFile = metaFor(file);
      const contentType = existsSync(typeFile) ? readFileSync(typeFile, 'utf8') : undefined;
      return { body, httpMetadata: { contentType } } as never;
    },

    /** Is it there, how big, when, and what was recorded with it. */
    async head(key: string) {
      const file = fileFor(key);
      if (file == null || !existsSync(file)) return null;
      const st = statSync(file);
      const customFile = customFor(file);
      let customMetadata: Record<string, string> | undefined;
      if (existsSync(customFile)) {
        try {
          customMetadata = JSON.parse(readFileSync(customFile, 'utf8')) as Record<string, string>;
        } catch {
          // A sidecar we cannot read must not hide the object it describes.
        }
      }
      const typeFile = metaFor(file);
      const contentType = existsSync(typeFile) ? readFileSync(typeFile, 'utf8') : undefined;
      return {
        key,
        size: st.size,
        uploaded: st.mtime,
        httpMetadata: { contentType },
        customMetadata,
      } as never;
    },

    async delete(key: string) {
      const file = fileFor(key);
      if (file == null || !existsSync(file)) return;
      // `rm` rather than unlink so a missing file is not an error: deleting
      // something twice is what a retry looks like.
      const { rmSync } = await import('node:fs');
      rmSync(file, { force: true });
      rmSync(metaFor(file), { force: true });
      rmSync(customFor(file), { force: true });
    },
  } as unknown as R2Bucket;
}
