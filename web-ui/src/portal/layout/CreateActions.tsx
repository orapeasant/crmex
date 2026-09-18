// "+ New" / Edit dialogs reachable from anywhere in the portal (top bar, detail pages, command palette).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ClientRow, MatterRow, TaskRow } from 'shared-ui';
import { ClientFormDialog } from '../clients/ClientFormDialog';
import { MatterFormDialog } from '../matters/MatterFormDialog';
import { TaskFormDialog } from '../tasks/TaskFormDialog';

type Open = { kind: 'client'; existing?: ClientRow } | { kind: 'matter'; existing?: MatterRow } | { kind: 'task'; existing?: TaskRow; matterId?: string } | null;

interface CreateActions {
  newClient: () => void;
  editClient: (c: ClientRow) => void;
  newMatter: () => void;
  editMatter: (m: MatterRow) => void;
  newTask: (opts?: { matterId?: string }) => void;
  editTask: (t: TaskRow) => void;
}

const Ctx = createContext<CreateActions | null>(null);

export function useCreateActions(): CreateActions {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCreateActions outside CreateActionsProvider');
  return v;
}

export function CreateActionsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open>(null);
  const close = useCallback((o: boolean) => !o && setOpen(null), []);

  const actions = useMemo<CreateActions>(
    () => ({
      newClient: () => setOpen({ kind: 'client' }),
      editClient: (existing) => setOpen({ kind: 'client', existing }),
      newMatter: () => setOpen({ kind: 'matter' }),
      editMatter: (existing) => setOpen({ kind: 'matter', existing }),
      newTask: (opts) => setOpen({ kind: 'task', matterId: opts?.matterId }),
      editTask: (existing) => setOpen({ kind: 'task', existing }),
    }),
    [],
  );

  return (
    <Ctx.Provider value={actions}>
      {children}
      <ClientFormDialog open={open?.kind === 'client'} onOpenChange={close} existing={open?.kind === 'client' ? open.existing : null} />
      <MatterFormDialog open={open?.kind === 'matter'} onOpenChange={close} existing={open?.kind === 'matter' ? open.existing : null} />
      <TaskFormDialog open={open?.kind === 'task'} onOpenChange={close} existing={open?.kind === 'task' ? open.existing : null} matterId={open?.kind === 'task' ? open.matterId : undefined} />
    </Ctx.Provider>
  );
}
