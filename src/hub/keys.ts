import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * The hub's machine key file: one bearer secret per machine, written by the
 * operator and kept outside every repository. A key identifies exactly one
 * machine — the first one that registers under it — and never speaks for
 * another afterwards.
 *
 * The hub only ever reads this file. It never creates one, and neither the
 * secrets nor the file's contents appear in logs or in any error.
 */

/** The shortest secret worth issuing: long enough to be unguessable. */
export const MIN_KEY_LENGTH = 16;

const hubKeyEntrySchema = z.object({
  /** The bearer secret a machine sends. Never logged, never echoed. */
  key: z.string().min(MIN_KEY_LENGTH),
  /** The operator's name for this key's machine; the hub reports it when present. */
  name: z.string().min(1).optional(),
});

const hubKeyFileSchema = z.object({
  machines: z.array(hubKeyEntrySchema).min(1),
});

export type HubKeyEntry = z.infer<typeof hubKeyEntrySchema>;
export type HubKeyFile = z.infer<typeof hubKeyFileSchema>;

/** What the hub knows of a key once one matches: never the secret itself. */
export interface HubKeyIdentity {
  /** Digest of the secret, so a machine can bind to this key without storing it. */
  readonly fingerprint: string;
  /** The operator's label for the machine, when the entry has one. */
  readonly name: string | undefined;
}

/** Digest of a machine key: what the store binds to, never the secret. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Issue paths and messages only — a Zod message never carries the input value. */
function issueLines(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const where = issue.path.map((part) => String(part)).join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Reads the key file, or throws naming the file and the problem. The failure
 * comes before any socket is bound, and carries no secret: the file is an
 * input, never something Concord creates.
 */
export function readHubKeyFile(path: string): HubKeyFile {
  if (!existsSync(path)) {
    throw new Error(`Hub key file ${path} is missing.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Hub key file ${path} is not valid JSON.`);
  }
  const parsed = hubKeyFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Hub key file ${path} is not valid: ${issueLines(parsed.error.issues)}`);
  }
  const seen = new Map<string, number>();
  for (const [index, entry] of parsed.data.machines.entries()) {
    const fingerprint = keyFingerprint(entry.key);
    const earlier = seen.get(fingerprint);
    if (earlier !== undefined) {
      throw new Error(
        `Hub key file ${path} lists one key twice (entries ${String(earlier)} and ${String(index)}).`,
      );
    }
    seen.set(fingerprint, index);
  }
  return parsed.data;
}

/**
 * The key identity this bearer speaks for, or undefined when no entry matches.
 * Every entry is compared, so which entry matched is not told by timing.
 */
export function authenticate(keys: HubKeyFile, bearer: string): HubKeyIdentity | undefined {
  const presented = Buffer.from(keyFingerprint(bearer), 'utf8');
  let matched: HubKeyIdentity | undefined;
  for (const entry of keys.machines) {
    const known = Buffer.from(keyFingerprint(entry.key), 'utf8');
    if (presented.length === known.length && timingSafeEqual(presented, known)) {
      matched = { fingerprint: known.toString('utf8'), name: entry.name };
    }
  }
  return matched;
}
