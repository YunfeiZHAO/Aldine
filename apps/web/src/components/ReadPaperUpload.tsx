import { useRef, useState } from 'react';
import Modal from './Modal';
import { useToast } from './Toast';

const LS_URL = 'aldine.readpaper_url';
const LS_EMAIL = 'aldine.readpaper_email';
const LS_WS  = 'aldine.readpaper_workspace';
let session: { url: string; token: string } | null = null;

function pdfFilename(name: string): string {
  const filename = name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'document';
  return /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
}

function readConfig() {
  try {
    return {
      url: localStorage.getItem(LS_URL) || '',
      email: localStorage.getItem(LS_EMAIL) || '',
      workspace: localStorage.getItem(LS_WS) || '',
    };
  } catch {
    return { url: '', email: '', workspace: '' };
  }
}

function saveConfig(url: string, email: string, workspace: string) {
  try {
    localStorage.setItem(LS_URL, url);
    localStorage.setItem(LS_EMAIL, email);
    localStorage.setItem(LS_WS, workspace.trim());
    localStorage.removeItem('aldine.readpaper_apikey');
  } catch { /* private window */ }
}

export function hasReadPaperConfig(): boolean {
  return !!session;
}

function ConfigModal({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const cfg = readConfig();
  const [url, setUrl] = useState(cfg.url);
  const [email, setEmail] = useState(cfg.email);
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState(cfg.workspace);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const connect = async () => {
    setBusy(true);
    try {
      const base = url.trim().replace(/\/+$/, '');
      const parsed = new URL(base);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Enter an HTTP or HTTPS Reader URL');
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || body.error || `Sign-in failed: HTTP ${res.status}`);
      if (typeof body.token !== 'string' || !body.token) throw new Error('Reader returned no session token');
      session = { url: base, token: body.token };
      saveConfig(base, email.trim(), workspace);
      setPassword('');
      onSaved();
    } catch (err: any) {
      toast(`read_paper sign-in failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Connect read_paper" width={440} testId="readpaper-config">
      <h2 style={{ marginBottom: 4 }}>Connect read_paper</h2>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) void connect(); }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field__label" htmlFor="rp-url">read_paper URL</label>
        <input id="rp-url" className="input" type="url" placeholder="https://papers.example.com" value={url} autoComplete="off" required disabled={busy} onChange={(event) => setUrl(event.target.value)} />
        <label className="field__label" htmlFor="rp-email">Email</label>
        <input id="rp-email" className="input" type="email" value={email} autoComplete="username" required disabled={busy} onChange={(event) => setEmail(event.target.value)} />
        <label className="field__label" htmlFor="rp-password">Password</label>
        <input id="rp-password" className="input" type="password" value={password} autoComplete="current-password" required disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        <label className="field__label" htmlFor="rp-ws">Workspace name <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
        <input
          id="rp-ws"
          className="input"
          placeholder="My papers"
          value={workspace}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setWorkspace(e.target.value)}
        />
      </div>
      <div className="modal__row" style={{ marginTop: 20 }}>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" type="submit" disabled={busy || !url.trim() || !email.trim() || !password} data-testid="readpaper-save">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
      </form>
    </Modal>
  );
}

export async function sendToReadPaper(
  pdfUrl: string,
  filename: string,
  toast: (msg: string, kind?: 'ok' | 'error') => void,
): Promise<'sent' | 'failed' | 'reconnect'> {
  const conn = session;
  if (!conn) return 'reconnect';
  let pdfBlob: Blob;
  try {
    const res = await fetch(pdfUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pdfBlob = await res.blob();
  } catch (err: any) {
    toast(`Could not fetch the PDF: ${err.message}`, 'error');
    return 'failed';
  }
  const form = new FormData();
  form.append('files', pdfBlob, pdfFilename(filename));
  const cfg = readConfig();
  if (cfg.workspace) form.append('workspace_name', cfg.workspace);
  form.append('on_conflict', 'replace');
  try {
    const res = await fetch(`${conn.url}/api/batch-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}` },
      body: form,
    });
    if (res.status === 401) {
      session = null;
      toast('Reader session expired. Sign in to read_paper again.', 'error');
      return 'reconnect';
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    const result = body.results?.[0];
    if (!result) throw new Error('No result returned');
    if (result.status === 'failed') throw new Error(result.error || 'Upload failed');
    if (result.status === 'created') {
      toast('Sent to read_paper', 'ok');
    } else if (result.status === 'replaced') {
      toast('Updated in read_paper', 'ok');
    } else if (result.status === 'already_exists') {
      toast('Already in read_paper', 'ok');
    } else {
      throw new Error(`Unexpected upload status: ${result.status}`);
    }
    return 'sent';
  } catch (err: any) {
    toast(`read_paper upload failed: ${err.message}`, 'error');
    return 'failed';
  }
}

export default function ReadPaperUploadButton({ pdfUrl, projectName }: {
  pdfUrl: string | null;
  projectName: string;
}) {
  const toast = useToast();
  const [configOpen, setConfigOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [filename, setFilename] = useState(() => pdfFilename(projectName));
  const [uploading, setUploading] = useState(false);
  const pendingRef = useRef<{ url: string; filename: string } | null>(null);

  const onConfigSaved = () => {
    setConfigOpen(false);
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      void doUpload(pending.url, pending.filename);
    }
  };

  const doUpload = async (url: string, name: string) => {
    setUploading(true);
    try {
      if (await sendToReadPaper(url, name, toast) === 'reconnect') {
        pendingRef.current = { url, filename: name };
        setConfigOpen(true);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleClick = () => {
    if (!pdfUrl || uploading) return;
    setSendOpen(true);
  };

  return (
    <>
      <button
        className="btn btn--ghost btn--small"
        onClick={handleClick}
        disabled={!pdfUrl || uploading}
        title="Send PDF to read_paper"
        data-testid="readpaper-upload"
        aria-label={uploading ? 'Sending to read_paper…' : 'Send to read_paper'}
      >
        {uploading ? 'Sending…' : 'Send to read_paper'}
      </button>
      <button
        className="btn btn--ghost btn--small"
        onClick={() => setConfigOpen(true)}
        disabled={uploading}
        data-testid="readpaper-settings"
        title="Configure read_paper connection"
      >
        Connection
      </button>
      {sendOpen && (
        <Modal onClose={() => setSendOpen(false)} label="Send to read_paper" testId="readpaper-send">
          <h2 style={{ marginBottom: 12 }}>Send to read_paper</h2>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!pdfUrl || uploading || !filename.trim()) return;
            setSendOpen(false);
            void doUpload(pdfUrl, filename);
          }}>
            <label className="field__label" htmlFor="rp-filename">Filename</label>
            <input
              id="rp-filename"
              className="input"
              value={filename}
              required
              autoComplete="off"
              data-testid="readpaper-filename"
              onChange={(event) => setFilename(event.target.value)}
            />
            <p style={{ marginTop: 8, opacity: 0.7 }}>
              The .pdf extension is added if needed. A file with the same name in the destination will be replaced.
            </p>
            <div className="modal__row" style={{ marginTop: 20 }}>
              <button className="btn" type="button" onClick={() => setSendOpen(false)}>Cancel</button>
              <button className="btn btn--primary" type="submit" disabled={!pdfUrl || uploading || !filename.trim()} data-testid="readpaper-send-confirm">
                Send to read_paper
              </button>
            </div>
          </form>
        </Modal>
      )}
      {configOpen && <ConfigModal onClose={() => { setConfigOpen(false); pendingRef.current = null; }} onSaved={onConfigSaved} />}
    </>
  );
}
