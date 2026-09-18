import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useMessaging } from '../messages/MessagingProvider.js';
import { CheckIcon } from '../ui/icons.js';
import { describeError } from '../ui/util.js';

export function LinkWhatsAppPage() {
  const { whatsApp, relink } = useMessaging();
  const state = whatsApp?.state ?? 'connecting';
  const qr = whatsApp?.qr ?? null;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!qr) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(qr, { margin: 1, width: 560, errorCorrectionLevel: 'M' })
      .then((url) => !cancelled && setQrDataUrl(url))
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [qr]);

  async function startRelink() {
    setConfirmUnlink(false);
    setError(null);
    try {
      await relink();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <main className="content stack">
      <p className="muted">Leagentex sends messages as a linked device of the WhatsApp account on your main phone.</p>

      {state === 'ready' && (
        <section className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="avatar" style={{ width: 56, height: 56, background: 'var(--success)' }}>
            <CheckIcon size={28} />
          </span>
          <div>
            <div className="card__title">WhatsApp is linked</div>
            <div className="card__subtitle">This device can send messages from your WhatsApp account.</div>
          </div>
          {confirmUnlink ? (
            <div className="stack" style={{ width: '100%' }}>
              <div className="alert alert--warning">This unlinks the current account. You'll need to scan a new QR code before sending again.</div>
              <div className="row">
                <button className="btn btn--secondary" style={{ flex: 1 }} onClick={() => setConfirmUnlink(false)}>
                  Cancel
                </button>
                <button className="btn btn--danger" style={{ flex: 1 }} onClick={startRelink}>
                  Unlink
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn--secondary" onClick={() => setConfirmUnlink(true)}>
              Link a different phone
            </button>
          )}
        </section>
      )}

      {state === 'qr' && (
        <section className="card stack">
          <div className="qr">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="WhatsApp pairing QR code" style={{ width: '100%', maxWidth: 280, aspectRatio: '1', imageRendering: 'pixelated' }} />
            ) : (
              <span className="spinner" />
            )}
          </div>
          <ol className="muted" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>Open WhatsApp on your main phone.</li>
            <li>
              Tap <strong>Settings</strong> (or the ⋮ menu) → <strong>Linked devices</strong>.
            </li>
            <li>
              Tap <strong>Link a device</strong> and point the camera at this code.
            </li>
          </ol>
          <p className="faint">The code refreshes automatically every few seconds.</p>
        </section>
      )}

      {state === 'connecting' && (
        <section className="card row" style={{ justifyContent: 'center', padding: 32 }}>
          <span className="spinner" /> <span className="muted">Connecting to WhatsApp…</span>
        </section>
      )}

      {state === 'logged-out' && (
        <section className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div>
            <div className="card__title">Not linked</div>
            <div className="card__subtitle">This device was logged out of WhatsApp. Generate a QR code to link it again.</div>
          </div>
          <button className="btn btn--primary" onClick={startRelink}>
            Generate QR code
          </button>
        </section>
      )}

      {error && <div className="alert alert--error">{error}</div>}
    </main>
  );
}
