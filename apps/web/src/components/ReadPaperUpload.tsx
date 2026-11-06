import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useToast } from './Toast';

const LS_URL = 'aldine.readpaper_url';
const LS_KEY = 'aldine.readpaper_apikey';
const LS_WS  = 'aldine.readpaper_workspace';

function readConfig() {
  try {
    return {
      url: localStorage.getItem(LS_URL) || '',
      apiKey: localStorage.getItem(LS_KEY) || '',
      workspace: localStorage.getItem(LS_WS) || '',
    };
  } catch {
    return { url: '', apiKey: '', workspace: '' };
  }
}

function saveConfig(url: string, apiKey: string, workspace: string) {
  try {
    localStorage.setItem(LS_URL, url.trim());
    localStorage.setItem(LS_KEY, apiKey.trim());
    localStorage.setItem(LS_WS, workspace.trim());
  } catch { /* private window */ }
}

export function hasReadPaperConfig(): boolean {
  try { return !!localStorage.getItem(LS_URL); } catch { return false; }
}

/** Config dialog: lets the user set the read_paper URL and API key. */
function ConfigModal({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const cfg = readConfig();
  const [url, setUrl] = useState(cfg.url);
  const [apiKey, setApiKey] = useState(cfg.apiKey);
  const [workspace, setWorkspace] = useState(cfg.workspace);

  const save = () => {
    saveConfig(url, apiKey, workspace);
    onSaved();
  };

  return (
    <Modal onClose={onClose} label="Connect read_paper" width={440} testId="readpaper-config">
      <h2 style={{ marginBottom: 4 }}>Connect read_paper</h2>
      <p className="modal__sub" style={{ marginBottom: 16 }}>
        Compiled PDFs are sent to your read_paper instance. Set an upload API key with
        <code style={{ marginLeft: 4 }}>READPAPER_UPLOAD_API_KEY</code> in read_paper's env.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field__label" htmlFor="rp-url">read_paper URL</label>
        <input
          id="rp-url"
          className="input"
          placeholder="https://papers.example.com"
          value={url}
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
        />
        <label className="field__label" htmlFor="rp-key">Upload API key</label>
        <input
          id="rp-key"
          className="input"
          type="password"
          placeholder="READPAPER_UPLOAD_API_KEY value"
          value={apiKey}
          autoComplete="new-password"
          onChange={(e) => setApiKey(e.target.value)}
        />
        <label className="field__label" htmlFor="rp-ws">Workspace name <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
        <input
          id="rp-ws"
          className="input"
          placeholder="My papers"
          value={workspace}
          autoComplete="off"
          onChange={(e) => setWorkspace(e.target.value)}
        />
      </div>
      <div className="modal__row" style={{ marginTop: 20 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={!url.trim() || !apiKey.trim()} data-testid="readpaper-save">
          Save
        </button>
      </div>
    </Modal>
  );
}

/** Sends the PDF at ``pdfUrl`` to read_paper and shows a toast. Called from the PDF toolbar. */
export async function sendToReadPaper(
  pdfUrl: string,
  projectName: string,
  toast: (msg: string, kind?: 'ok' | 'error') => void,
): Promise<void> {
  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) return;

  const filename = `${(projectName || 'document').replace(/[\\/:*?"<>|]/g, '-')}.pdf`;

  let pdfBlob: Blob;
  try {
    const res = await fetch(pdfUrl);
    if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);
    pdfBlob = await res.blob();
  } catch (err: any) {
    toast(`Could not fetch the PDF: ${err.message}`, 'error');
    return;
  }

  const form = new FormData();
  form.append('files', pdfBlob, filename);
  if (cfg.workspace) form.append('workspace_name', cfg.workspace);
  form.append('on_conflict', 'replace');

  try {
    const base = cfg.url.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/batch-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error('No result returned');
    if (result.status === 'failed') throw new Error(result.error || 'Upload failed');
    const label = result.status === 'created' ? 'Sent to read_paper' : 'Updated in read_paper';
    toast(label, 'ok');
  } catch (err: any) {
    toast(`read_paper upload failed: ${err.message}`, 'error');
  }
}

/** The upload button that lives in the PDF pane toolbar.
 *
 * Shows a config modal on first use (or when settings need changing), then
 * fetches the compiled PDF and POSTs it to the configured read_paper instance.
 */
export default function ReadPaperUploadButton({ pdfUrl, projectName }: {
  pdfUrl: string | null;
  projectName: string;
}) {
  const toast = useToast();
  const [configOpen, setConfigOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const pendingRef = useRef(false);

  // After config is saved, trigger the pending upload if any.
  const onConfigSaved = () => {
    setConfigOpen(false);
    if (pendingRef.current && pdfUrl) {
      pendingRef.current = false;
      doUpload(pdfUrl);
    }
  };

  const doUpload = async (url: string) => {
    setUploading(true);
    try {
      await sendToReadPaper(url, projectName, toast);
    } finally {
      setUploading(false);
    }
  };

  const handleClick = () => {
    if (!pdfUrl || uploading) return;
    if (!hasReadPaperConfig()) {
      pendingRef.current = true;
      setConfigOpen(true);
      return;
    }
    doUpload(pdfUrl);
  };

  return (
    <>
      <button
        className="btn btn--ghost btn--small"
        onClick={handleClick}
        disabled={!pdfUrl || uploading}
        title={hasReadPaperConfig() ? 'Send PDF to read_paper' : 'Configure read_paper connection'}
        data-testid="readpaper-upload"
        aria-label={uploading ? 'Sending to read_paper…' : 'Send to read_paper'}
      >
        {uploading ? 'Sending…' : 'Send to read_paper'}
      </button>
      {configOpen && <ConfigModal onClose={() => { setConfigOpen(false); pendingRef.current = false; }} onSaved={onConfigSaved} />}
    </>
  );
}
