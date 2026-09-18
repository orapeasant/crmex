import { useState } from 'react';
import { Plus } from 'lucide-react';
import { MATTER_CLIENT_ROLES, filterClients, type ClientRow, type MatterClientRole } from 'shared-ui';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Initials } from '../components/common';
import { Field, SimpleSelect } from '../components/form';

export function LinkClientDialog({ open, onOpenChange, clients, onLink }: { open: boolean; onOpenChange: (o: boolean) => void; clients: ClientRow[]; onLink: (clientId: string, role: MatterClientRole) => Promise<void> }) {
  const [role, setRole] = useState<MatterClientRole>('client');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = filterClients(clients, { query }).slice(0, 50);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a client</DialogTitle>
          <DialogDescription>Choose their role, then pick a client of this firm.</DialogDescription>
        </DialogHeader>
        <Field id="link-role" label="Role in this matter">
          <SimpleSelect id="link-role" value={role} onChange={setRole} options={MATTER_CLIENT_ROLES} />
        </Field>
        <Command shouldFilter={false} className="rounded-md border">
          <CommandInput placeholder="Search clients…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-72">
            <CommandEmpty>{clients.length === 0 ? 'Every client is already linked.' : 'No clients match.'}</CommandEmpty>
            {visible.map((c) => (
              <CommandItem
                key={c.id}
                value={c.id}
                disabled={busy}
                onSelect={async () => {
                  setBusy(true);
                  try {
                    await onLink(c.id, role);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Initials name={c.display_name} className="size-7" />
                <span className="flex-1 truncate">{c.display_name}</span>
                <span className="font-mono text-xs text-muted-foreground">{c.phone_e164 ?? ''}</span>
                <Plus className="text-muted-foreground" />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
