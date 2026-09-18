// Platform-specific half of contact reading (crmex.md §7.1, §7.2). The pure
// normalization logic lives in shared-ui/src/contacts/normalize.ts and is
// unit-tested there; this file only does the platform I/O: read the address
// book via @capacitor-community/contacts (v6+ API — checkPermissions() /
// requestPermissions() returning { contacts: 'granted' | 'denied' | 'prompt' },
// NOT the old getPermissions()/permission.granted shape the previous draft
// used) and hand raw contacts to normalizeContacts().
import { Contacts } from '@capacitor-community/contacts';
import { Device } from '@capacitor/device';
import { SimRegion } from './simRegionPlugin.js';
import { normalizeContacts, resolveDefaultRegion, toCountryCode, type ContactListResult, type CountryCode, type RawContact } from 'shared-ui';

export async function resolveRegion(userOverride: CountryCode | null): Promise<CountryCode> {
  let simRegion: CountryCode | null = null;
  try {
    const { region } = await SimRegion.getSimCountryIso();
    simRegion = toCountryCode(region);
  } catch {
    simRegion = null; // PHN-08: SIM region unavailable — fall through
  }

  let localeRegion: CountryCode | null = null;
  try {
    const { value } = await Device.getLanguageTag();
    // value looks like 'en-US' — take the region subtag if present.
    const parts = value.split('-');
    localeRegion = parts.length > 1 ? toCountryCode(parts[parts.length - 1]) : null;
  } catch {
    localeRegion = null;
  }

  return resolveDefaultRegion({ userOverride, simRegion, localeRegion });
}

export async function fetchLocalContacts(defaultRegion: CountryCode): Promise<ContactListResult> {
  let perm = await Contacts.checkPermissions();
  if (perm.contacts !== 'granted') {
    perm = await Contacts.requestPermissions();
    if (perm.contacts !== 'granted') {
      throw new Error('CONTACTS_PERMISSION_DENIED'); // CON-02
    }
  }

  const { contacts } = await Contacts.getContacts({
    projection: { name: true, phones: true },
  });

  const raw: RawContact[] = (contacts ?? []).map((c) => ({
    contactId: c.contactId,
    displayName: c.name?.display,
    phones: (c.phones ?? []).map((p) => p.number ?? '').filter(Boolean),
  }));

  return normalizeContacts(raw, defaultRegion);
}
