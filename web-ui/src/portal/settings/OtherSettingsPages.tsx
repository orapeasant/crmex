import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CreditCard, LogOut } from 'lucide-react';
import { getCountries } from 'libphonenumber-js';
import { loadRegionOverride, saveRegionOverride, toCountryCode, useActiveFirm, useApp, type CountryCode } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Fact, PageBody, PageHeader, Section, StatusBadge } from '../components/common';
import { Field, NONE, SimpleSelect } from '../components/form';
import { useUsage } from '../lib/queries';

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return null;
  }
})();

export function AccountPage() {
  const { user, profile, platform, signOut } = useApp();
  const provider = (user.app_metadata?.provider as string | undefined) ?? 'email';
  const [region, setRegion] = useState<string>(NONE);
  const [autoRegion, setAutoRegion] = useState<CountryCode | null>(null);

  useEffect(() => {
    loadRegionOverride(platform.preferences).then((r) => setRegion(r ?? NONE));
    platform.resolveRegion(null).then(setAutoRegion);
  }, [platform]);

  const options = getCountries()
    .map((c) => ({ value: c as string, label: `${regionNames?.of(c) ?? c} (${c})` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <>
      <PageHeader title="Account" description="Your profile and preferences on this browser" />
      <PageBody className="max-w-4xl">
        <Section title="Profile">
          <div className="flex items-center gap-4">
            <span className="flex size-14 items-center justify-center rounded-full bg-teal-700 text-lg font-semibold text-white">{profile.initials}</span>
            <dl className="grid flex-1 gap-4 sm:grid-cols-2">
              <Fact label="Name">{profile.fullName}</Fact>
              <Fact label="Email">{profile.email}</Fact>
              <Fact label="Signed in with">
                <span className="capitalize">{provider}</span>
              </Fact>
              <Fact label="Member since">{user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</Fact>
            </dl>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Your name and email come from your Google account. Change them there.</p>
        </Section>
        <Section title="Phone numbers">
          <Field id="region" label="Default country for phone numbers" hint={`Used for numbers typed without a country code. Automatic uses your browser language${autoRegion ? ` (${regionNames?.of(autoRegion) ?? autoRegion})` : ''}.`} className="max-w-md">
            <SimpleSelect
              id="region"
              value={region}
              onChange={async (v) => {
                setRegion(v);
                await saveRegionOverride(platform.preferences, v === NONE ? null : toCountryCode(v));
                toast.success('Default country saved');
              }}
              options={[{ value: NONE, label: 'Automatic' }, ...options]}
            />
          </Field>
        </Section>
        <Section title="Session">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Logging out clears this browser's Leagentex data for your account.</p>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => void signOut()}>
              <LogOut /> Log out
            </Button>
          </div>
        </Section>
      </PageBody>
    </>
  );
}

export function BillingPage() {
  const { activeOrg } = useActiveFirm();
  return (
    <>
      <PageHeader title="Billing" description={`Plan for ${activeOrg.name}`} />
      <PageBody className="max-w-4xl">
        <Section title="Current plan" actions={<StatusBadge tone="success">Active</StatusBadge>}>
          <div className="text-2xl font-semibold capitalize">{activeOrg.plan || 'Free'}</div>
          <p className="mt-1 text-sm text-muted-foreground">Includes AI message drafting, image generation within the daily limit, and WhatsApp sending from each member's linked phone.</p>
        </Section>
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-6 py-10 text-center">
          <CreditCard className="size-6 text-muted-foreground" />
          <div className="font-medium">No payment method needed</div>
          <p className="text-sm text-muted-foreground">Paid plans aren't available yet. You won't be charged.</p>
        </div>
      </PageBody>
    </>
  );
}

export function UsagePage() {
  const { activeOrg } = useActiveFirm();
  const usage = useUsage();
  const v = (n: number | undefined) => (usage.data ? n : '—');
  const stats = [
    { label: 'Messages sent today', value: v(usage.data?.sentToday) },
    { label: 'Sent, last 30 days', value: v(usage.data?.sent30d) },
    { label: 'Failed, last 30 days', value: v(usage.data?.failed30d) },
    { label: 'Images, last 30 days', value: v(usage.data?.images30d) },
  ];
  return (
    <>
      <PageHeader title="Usage" description={`Your own activity in ${activeOrg.name}`} />
      <PageBody className="max-w-5xl">
        {usage.isError && <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-800 dark:text-red-300">Couldn't load usage.</div>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border bg-card p-5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</div>
              <div className="mt-2 text-3xl font-semibold tabular-nums">{s.value}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Image generation has a daily limit set by the service. Messages are sent from your own WhatsApp account.</p>
      </PageBody>
    </>
  );
}
