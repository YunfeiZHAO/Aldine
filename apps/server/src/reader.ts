/**
 * Client for the read-paper reader service (batch-upload endpoint).
 * Auth is handled externally: the caller supplies a session JWT obtained from
 * the reader's /api/auth/login endpoint and stored per-user via
 * db().setConnection(userId, 'reader', { token, email, exp }).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ReaderConnection {
  token: string;
  email: string;
  exp: number; // unix seconds
}

export interface UploadResult {
  filename: string;
  status: 'created' | 'already_exists' | 'replaced' | 'failed';
  document_id?: number;
  error?: string;
}

/** Decode the exp claim from a JWT without verifying the signature. */
export function tokenExp(token: string): number {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { exp?: number };
    return payload.exp ?? 0;
  } catch {
    return 0;
  }
}

/** Returns true when the token has expired or expires within 5 minutes. */
export function tokenExpired(conn: ReaderConnection): boolean {
  return Date.now() / 1000 > conn.exp - 300;
}

export async function uploadPdf(
  readerUrl: string,
  token: string,
  filePath: string,
  opts: { workspaceName?: string; onConflict?: 'skip' | 'replace' } = {},
): Promise<UploadResult[]> {
  const form = new FormData();
  const fileData = fs.readFileSync(filePath);
  form.append('file', new Blob([fileData], { type: 'application/pdf' }), path.basename(filePath));
  if (opts.workspaceName) form.append('workspace_name', opts.workspaceName);
  if (opts.onConflict) form.append('on_conflict', opts.onConflict);

  const resp = await fetch(`${readerUrl.replace(/\/$/, '')}/api/batch-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!resp.ok) throw new Error(`Reader upload failed: ${resp.status} ${await resp.text()}`);
  const body = await resp.json() as { results: UploadResult[] };
  return body.results;
}
