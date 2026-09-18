import type { Route } from './nav.js';
import { ClientsList } from '../clients/ClientsList.js';
import { ClientDetail } from '../clients/ClientDetail.js';
import { ClientForm } from '../clients/ClientForm.js';
import { ImportContacts } from '../clients/ImportContacts.js';
import { MattersList } from '../matters/MattersList.js';
import { MatterDetail } from '../matters/MatterDetail.js';
import { MatterForm } from '../matters/MatterForm.js';
import { TasksList } from '../tasks/TasksList.js';
import { TaskForm } from '../tasks/TaskForm.js';
import { MessagesTab } from '../messages/MessagesTab.js';
import { BatchDetail } from '../messages/BatchDetail.js';

export function RouteView({ route, active, onWizardFocus, onLinkWhatsApp }: { route: Route; active: boolean; onWizardFocus: (focus: boolean) => void; onLinkWhatsApp: () => void }) {
  switch (route.name) {
    case 'clients':
      return <ClientsList />;
    case 'client':
      return <ClientDetail id={route.id} />;
    case 'client-form':
      return <ClientForm id={route.id} />;
    case 'client-import':
      return <ImportContacts />;
    case 'matters':
      return <MattersList />;
    case 'matter':
      return <MatterDetail id={route.id} />;
    case 'matter-form':
      return <MatterForm id={route.id} />;
    case 'tasks':
      return <TasksList />;
    case 'task-form':
      return <TaskForm id={route.id} matterId={route.matterId} />;
    case 'messages':
      return <MessagesTab active={active} onWizardFocus={onWizardFocus} onLinkWhatsApp={onLinkWhatsApp} />;
    case 'batch':
      return <BatchDetail batchId={route.batchId} />;
  }
}
