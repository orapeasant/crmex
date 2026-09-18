// WA-01: "QR reaches the UI and renders — the bug in the original design
// was that it never did." Renders a real scannable QR image (via the
// `qrcode` library, generating a data: URL) from the raw string emitted by
// Baileys' connection.update, not just the raw text.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export type WhatsAppConnState = 'idle' | 'qr' | 'connecting' | 'ready' | 'logged-out';

export interface QrPairingProps {
  state: WhatsAppConnState;
  qrString: string | null;
}

export function QrPairing({ state, qrString }: QrPairingProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!qrString) {
      setDataUrl(null);
      return;
    }
    QRCode.toDataURL(qrString, { margin: 1, width: 260 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [qrString]);

  if (state === 'ready') {
    return <div data-testid="wa-status-ready">WhatsApp connected</div>;
  }

  if (state === 'logged-out') {
    return <div data-testid="wa-status-logged-out">Logged out from WhatsApp — scan a new QR code to reconnect.</div>;
  }

  if (!qrString) {
    return <div data-testid="wa-status-waiting">Waiting for QR code…</div>;
  }

  if (error) {
    return <div data-testid="wa-qr-error">Could not render QR code: {error}</div>;
  }

  return (
    <div data-testid="wa-qr-container">
      <p>Scan this code with WhatsApp on your phone (Linked devices → Link a device):</p>
      {dataUrl && <img data-testid="wa-qr-image" src={dataUrl} alt="WhatsApp pairing QR code" width={260} height={260} />}
    </div>
  );
}
