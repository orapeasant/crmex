import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { Copy, LogOut, Mail, MoreHorizontal, Trash2, UserPlus } from 'lucide-react';
import { describeError, formatDate, useActiveFirm, useApp, type CreatedInvitation, type OrgInvitation, type OrgMember, type OrgRole } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog, ErrorState, Initials, PageBody, PageHeader, Spinner, StatusBadge, TableSkeleton } from '../components/common';
import { Field, FormError, SimpleSelect } from '../components/form';
import { useInvitations, useMembers } from '../lib/queries';

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const ROLE_HELP: Record<OrgRole, string> = { owner: 'Billing, firm deletion, manages admins', admin: 'Invites and removes members', member: 'Works with clients, matters and tasks' };

export function FirmSettingsPage() {
  const { api, user } = useApp();
  const firm = useActiveFirm();
  const { orgId, role, canManage } = firm;
  const qc = useQueryClient();
  const members = useMembers();
  const invitations = useInvitations(canManage);
  const [inviting, setInviting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OrgInvitation | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadMembers = () => qc.invalidateQueries({ queryKey: ['org', orgId, 'members'] });
  const reloadInvites = () => qc.invalidateQueries({ queryKey: ['org', orgId, 'invitations'] });

  function canRemove(m: OrgMember) {
    if (m.userId === user.id) return true;
    if (role === 'owner') return true;
    return role === 'admin' && m.role === 'member';
  }

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const leaving = removeTarget?.userId === user.id;

  return (
    <>
      <PageHeader
        title="Firm & members"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {firm.activeOrg.name}
            <StatusBadge>Your role: {ROLE_LABEL[role]}</StatusBadge>
            <StatusBadge tone="brand">Plan: {firm.activeOrg.plan}</StatusBadge>
          </span>
        }
        actions={
          canManage && (
            <Button onClick={() => setInviting(true)}>
              <UserPlus /> Invite member
            </Button>
          )
        }
      />
      <PageBody>
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Members</h2>
          {members.isLoading && <TableSkeleton rows={3} />}
          {members.isError && <ErrorState error={members.error} onRetry={() => void members.refetch()} title="Couldn't load members" />}
          {members.data && (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs uppercase">Name</TableHead>
                    <TableHead className="hidden text-xs uppercase md:table-cell">Email</TableHead>
                    <TableHead className="w-40 text-xs uppercase">Role</TableHead>
                    <TableHead className="hidden w-36 text-xs uppercase lg:table-cell">Joined</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.data.map((m) => {
                    const name = m.displayName || m.email || 'Member';
                    const showMenu = role === 'owner' || canRemove(m);
                    return (
                      <TableRow key={m.userId}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Initials name={name} />
                            <span className="font-medium">
                              {name}
                              {m.userId === user.id && <span className="font-normal text-muted-foreground"> (you)</span>}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">{m.email ?? '—'}</TableCell>
                        <TableCell>
                          <StatusBadge tone={m.role === 'owner' ? 'brand' : m.role === 'admin' ? 'info' : 'neutral'}>{ROLE_LABEL[m.role]}</StatusBadge>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">{m.joinedAt ? formatDate(m.joinedAt) : '—'}</TableCell>
                        <TableCell>
                          {showMenu && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${name}`} disabled={busy}>
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-64">
                                {role === 'owner' && (
                                  <>
                                    <DropdownMenuLabel className="text-xs text-muted-foreground">Role</DropdownMenuLabel>
                                    <DropdownMenuRadioGroup
                                      value={m.role}
                                      onValueChange={(r) =>
                                        r !== m.role &&
                                        void run(async () => {
                                          await api.changeMemberRole(orgId, m.userId, r as OrgRole);
                                          await reloadMembers();
                                          if (m.userId === user.id) await firm.refresh();
                                        }, `${name} is now ${ROLE_LABEL[r as OrgRole].toLowerCase()}`)
                                      }
                                    >
                                      {(['owner', 'admin', 'member'] as OrgRole[]).map((r) => (
                                        <DropdownMenuRadioItem key={r} value={r} className="items-start">
                                          <div>
                                            <div>{ROLE_LABEL[r]}</div>
                                            <div className="text-xs text-muted-foreground">{ROLE_HELP[r]}</div>
                                          </div>
                                        </DropdownMenuRadioItem>
                                      ))}
                                    </DropdownMenuRadioGroup>
                                    {canRemove(m) && <DropdownMenuSeparator />}
                                  </>
                                )}
                                {canRemove(m) && (
                                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setRemoveTarget(m)}>
                                    {m.userId === user.id ? <LogOut /> : <Trash2 />}
                                    {m.userId === user.id ? 'Leave firm' : 'Remove from firm'}
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can invite or remove members.</p>}
        </section>

        {canManage && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Pending invitations</h2>
            {invitations.isLoading && <TableSkeleton rows={2} />}
            {invitations.isError && <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} title="Couldn't load invitations" />}
            {invitations.data && (
              <div className="overflow-hidden rounded-lg border bg-card">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="text-xs uppercase">Invitation</TableHead>
                      <TableHead className="w-32 text-xs uppercase">Role</TableHead>
                      <TableHead className="hidden w-36 text-xs uppercase md:table-cell">Created</TableHead>
                      <TableHead className="w-36 text-xs uppercase">Expires</TableHead>
                      <TableHead className="w-24">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.data.length === 0 && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                          No pending invitations.
                        </TableCell>
                      </TableRow>
                    )}
                    {invitations.data.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-medium">{inv.email ?? <span className="text-muted-foreground">Link / QR invitation</span>}</TableCell>
                        <TableCell>
                          <StatusBadge>{ROLE_LABEL[inv.role]}</StatusBadge>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(inv.createdAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(inv.expiresAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setRevokeTarget(inv)}>
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        )}
      </PageBody>

      <InviteDialog
        open={inviting}
        onOpenChange={(o) => {
          setInviting(o);
          if (!o) void reloadInvites();
        }}
        canInviteAdmin={canManage}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={leaving ? `Leave ${firm.activeOrg.name}?` : `Remove ${removeTarget?.displayName || removeTarget?.email || 'member'}?`}
        description={leaving ? "You'll lose access to this firm's clients, matters, tasks and messages. You'll need a new invitation to rejoin." : 'They lose access to this firm immediately. Records they created stay with the firm.'}
        confirmLabel={leaving ? 'Leave firm' : 'Remove'}
        destructive
        busy={busy}
        onConfirm={async () => {
          if (!removeTarget) return;
          const ok = await run(async () => {
            await api.removeMember(orgId, removeTarget.userId);
            if (leaving) await firm.refresh();
            else await reloadMembers();
          }, leaving ? 'You left the firm' : 'Member removed');
          if (ok) setRemoveTarget(null);
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title="Revoke invitation?"
        description="The code or link stops working immediately."
        confirmLabel="Revoke"
        destructive
        busy={busy}
        onConfirm={async () => {
          if (!revokeTarget) return;
          const ok = await run(async () => {
            await api.revokeInvitation(orgId, revokeTarget.id);
            await reloadInvites();
          }, 'Invitation revoked');
          if (ok) setRevokeTarget(null);
        }}
      />
    </>
  );
}

function InviteDialog({ open, onOpenChange, canInviteAdmin }: { open: boolean; onOpenChange: (o: boolean) => void; canInviteAdmin: boolean }) {
  const { api, openUrl } = useApp();
  const { orgId, activeOrg } = useActiveFirm();
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setCreated(null);
    setQr(null);
    setEmail('');
    setRole('member');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!created) return;
    let cancelled = false;
    QRCode.toDataURL(created.inviteUrl, { margin: 1, width: 480, errorCorrectionLevel: 'M' })
      .then((url) => !cancelled && setQr(url))
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [created]);

  const trimmed = email.trim();
  const emailValid = trimmed === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  // The token is shown only now; it is never logged or stored by this page.
  const webLink = created ? `${window.location.origin}/invite/${encodeURIComponent(created.token)}` : '';
  const message = created
    ? `You're invited to join ${activeOrg.name} on Leagentex.\n\nOn a computer, open: ${webLink}\nOn your phone with Leagentex installed, open: ${created.inviteUrl}\n\nThe invitation can be used once and expires in 7 days.`
    : '';

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValid) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await api.createInvitation(orgId, { role, ...(trimmed ? { email: trimmed } : {}) }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        {!created ? (
          <form onSubmit={createInvite} className="flex flex-col gap-5" noValidate>
            <DialogHeader>
              <DialogTitle>Invite a colleague</DialogTitle>
              <DialogDescription>They join {activeOrg.name} with the role you choose.</DialogDescription>
            </DialogHeader>
            <Field id="invite-role" label="Role" hint={ROLE_HELP[role]}>
              <SimpleSelect id="invite-role" value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, ...(canInviteAdmin ? [{ value: 'admin' as const, label: 'Admin' }] : [])]} />
            </Field>
            <Field id="invite-email" label="Email (optional)" error={!emailValid ? 'Enter a valid email address.' : null} hint="If set, only an account with this verified email can accept.">
              <Input id="invite-email" type="email" placeholder="colleague@firm.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <FormError error={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !emailValid}>
                {busy && <Spinner />} Create invitation
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invitation ready</DialogTitle>
              <DialogDescription>
                {ROLE_LABEL[created.invitation.role]}
                {created.invitation.email ? ` · for ${created.invitation.email}` : ''} · single use, expires in 7 days
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-4">
              <div className="flex size-40 shrink-0 items-center justify-center rounded-md border bg-white dark:bg-slate-800 p-2">{qr ? <img src={qr} alt="Invitation QR code for the Leagentex phone app" className="size-full" /> : <Spinner />}</div>
              <div className="flex min-w-0 flex-col gap-2 text-sm">
                <p className="text-muted-foreground">Scan in the Leagentex phone app, or share a link:</p>
                <Button variant="outline" size="sm" className="justify-start" onClick={() => void copy(webLink, 'Web link')}>
                  <Copy /> Copy web link
                </Button>
                <Button variant="outline" size="sm" className="justify-start" onClick={() => void copy(created.inviteUrl, 'App link')}>
                  <Copy /> Copy phone app link
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  onClick={() => openUrl(`mailto:${encodeURIComponent(created.invitation.email ?? '')}?subject=${encodeURIComponent(`Join ${activeOrg.name} on Leagentex`)}&body=${encodeURIComponent(message)}`)}
                >
                  <Mail /> Email invitation
                </Button>
              </div>
            </div>
            <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">This code is shown only now. Share it before closing.</div>
            <FormError error={error} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
