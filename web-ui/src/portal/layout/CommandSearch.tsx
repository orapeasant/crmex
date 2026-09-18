import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Briefcase, ListChecks, MessageSquare, Plus, User } from 'lucide-react';
import { clientKindLabel, filterClients } from 'shared-ui';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { useCreateActions } from './CreateActions';
import { useClients, useMatters } from '../lib/queries';

/** Ctrl/Cmd+K: clients by name/phone/email and matters by number/title, in the active firm only. */
export function CommandSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const create = useCreateActions();
  const [query, setQuery] = useState('');
  const clients = useClients();
  const matters = useMatters();

  const q = query.trim();
  const clientHits = useMemo(() => (q ? filterClients(clients.data ?? [], { query: q }).slice(0, 8) : []), [clients.data, q]);
  const matterHits = useMemo(() => {
    if (!q) return [];
    const lower = q.toLowerCase();
    return (matters.data ?? []).filter((m) => m.matter_number.toLowerCase().includes(lower) || m.title.toLowerCase().includes(lower)).slice(0, 8);
  }, [matters.data, q]);

  function go(fn: () => void) {
    onOpenChange(false);
    setQuery('');
    fn();
  }

  return (
    <CommandDialog shouldFilter={false} open={open} onOpenChange={(o) => (onOpenChange(o), !o && setQuery(''))} title="Search" description="Search clients and matters in this firm">
      {/* Filtering is done here (shared filterClients), not by cmdk's fuzzy matcher. */}
      <CommandInput placeholder="Search clients by name, phone or email; matters by number or title…" value={query} onValueChange={setQuery} />
      <CommandList>
        {q && <CommandEmpty>{clients.isLoading || matters.isLoading ? 'Searching…' : 'No clients or matters match.'}</CommandEmpty>}
        {clientHits.length > 0 && (
          <CommandGroup heading="Clients">
            {clientHits.map((c) => (
              <CommandItem key={c.id} value={`client-${c.id}`} onSelect={() => go(() => navigate(`/clients/${c.id}`))}>
                <User />
                <span className="flex-1 truncate">{c.display_name}</span>
                <span className="truncate text-xs text-muted-foreground">{c.phone_e164 ?? c.email ?? clientKindLabel(c.kind)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {matterHits.length > 0 && (
          <CommandGroup heading="Matters">
            {matterHits.map((m) => (
              <CommandItem key={m.id} value={`matter-${m.id}`} onSelect={() => go(() => navigate(`/matters/${m.id}`))}>
                <Briefcase />
                <span className="flex-1 truncate">{m.title}</span>
                <span className="font-mono text-xs text-muted-foreground">{m.matter_number}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!q && (
          <>
            <CommandGroup heading="Go to">
              <CommandItem value="go-clients" onSelect={() => go(() => navigate('/clients'))}>
                <User /> Clients
              </CommandItem>
              <CommandItem value="go-matters" onSelect={() => go(() => navigate('/matters'))}>
                <Briefcase /> Matters
              </CommandItem>
              <CommandItem value="go-tasks" onSelect={() => go(() => navigate('/tasks'))}>
                <ListChecks /> Tasks
              </CommandItem>
              <CommandItem value="go-messages" onSelect={() => go(() => navigate('/messages'))}>
                <MessageSquare /> Messages
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Create">
              <CommandItem value="new-client" onSelect={() => go(create.newClient)}>
                <Plus /> New client
              </CommandItem>
              <CommandItem value="new-matter" onSelect={() => go(create.newMatter)}>
                <Plus /> New matter
              </CommandItem>
              <CommandItem value="new-task" onSelect={() => go(() => create.newTask())}>
                <Plus /> New task
              </CommandItem>
              <CommandItem value="new-message" onSelect={() => go(() => navigate('/messages/new'))}>
                <Plus /> New message
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
