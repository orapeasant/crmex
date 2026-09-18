import { MATTER_STATUSES, type MatterStatus } from 'shared-ui';
import { StatusBadge } from '../components/common';

export function MatterStatusBadge({ status }: { status: MatterStatus }) {
  const label = MATTER_STATUSES.find((s) => s.value === status)?.label ?? status;
  return <StatusBadge tone={status === 'open' ? 'success' : status === 'pending' ? 'warning' : 'neutral'}>{label}</StatusBadge>;
}
