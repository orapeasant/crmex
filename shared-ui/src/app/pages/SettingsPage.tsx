import { useEffect, useState } from 'react';
import { toCountryCode } from '../../contacts/regionResolver.js';
import type { CountryCode } from '../../types.js';
import type { WhatsAppState } from '../platform.js';
import { useApp, useFirm } from '../context.js';
import { useMessaging } from '../messages/MessagingProvider.js';
import { loadRegionOverride, saveRegionOverride } from '../ui/region.js';
import { ChevronRightIcon } from '../ui/icons.js';

const COMMON_REGIONS: { code: CountryCode; label: string }[] = [
  { code: 'SG', label: 'Singapore (+65)' },
  { code: 'MY', label: 'Malaysia (+60)' },
  { code: 'CN', label: 'China (+86)' },
  { code: 'IN', label: 'India (+91)' },
  { code: 'US', label: 'United States (+1)' },
  { code: 'GB', label: 'United Kingdom (+44)' },
  { code: 'AU', label: 'Australia (+61)' },
];

const WA_LABEL: Record<WhatsAppState, { text: string; badge: string }> = {
  ready: { text: 'Linked', badge: 'badge badge--success' },
  qr: { text: 'Waiting for scan', badge: 'badge badge--warning' },
  connecting: { text: 'Connecting', badge: 'badge badge--neutral' },
  'logged-out': { text: 'Not linked', badge: 'badge badge--danger' },
};

export function SettingsPage({ onLinkWhatsApp, onOpenFirm }: { onLinkWhatsApp: () => void; onOpenFirm: () => void }) {
  const { platform } = useApp();
  const firm = useFirm();
  const messaging = useMessaging();
  const [region, setRegion] = useState<CountryCode | ''>('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadRegionOverride(platform.preferences).then((r) => setRegion(r ?? ''));
  }, [platform]);

  async function changeRegion(value: string) {
    const code = value ? toCountryCode(value) : null;
    setRegion(code ?? '');
    await saveRegionOverride(platform.preferences, code);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  return (
    <main className="content stack">
      <section className="stack" style={{ gap: 8 }}>
        <div className="field__label">Firm</div>
        <div className="card list-card">
          <button className="list-item list-item--button" onClick={onOpenFirm}>
            <div>
              <div>Firm &amp; members</div>
              <div className="faint">{firm.activeOrg ? `${firm.activeOrg.name} · members, roles and invitations` : 'Members, roles and invitations'}</div>
            </div>
            <ChevronRightIcon size={18} />
          </button>
        </div>
      </section>

      {messaging.whatsApp && (
        <section className="stack" style={{ gap: 8 }}>
          <div className="field__label">WhatsApp</div>
          <div className="card list-card">
            <button className="list-item list-item--button" onClick={onLinkWhatsApp}>
              <div>
                <div>Linked device</div>
                <div className="faint">Link or change the WhatsApp account used for sending</div>
              </div>
              <span className={WA_LABEL[messaging.whatsApp.state].badge}>{WA_LABEL[messaging.whatsApp.state].text}</span>
            </button>
          </div>
        </section>
      )}

      <section className="stack" style={{ gap: 8 }}>
        <div className="field__label">Phone numbers</div>
        <div className="card stack">
          <label className="field">
            <span>Default country for phone numbers</span>
            <span className="faint">Used for numbers entered or imported without a country code. Automatic uses your SIM card, then your device's language settings.</span>
            <select className="input" value={region} onChange={(e) => changeRegion(e.target.value)}>
              <option value="">Automatic</option>
              {COMMON_REGIONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {saved && (
            <span className="badge badge--success" style={{ alignSelf: 'flex-start' }}>
              Saved
            </span>
          )}
        </div>
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <div className="field__label">About</div>
        <div className="card list-card">
          <div className="list-item">
            <span>Version</span>
            <span className="muted">{platform.appVersion}</span>
          </div>
        </div>
      </section>
    </main>
  );
}
