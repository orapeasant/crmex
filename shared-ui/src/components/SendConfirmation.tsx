import { useState } from 'react';
import {
  initialConfirmationState,
  acknowledgeReview,
  confirmSend,
  canSend,
  type ConfirmationState,
} from '../send/confirmationGate.js';

export interface SendConfirmationProps {
  recipients: { jid: string; displayName: string }[];
  onConfirmed: () => void;
  onCancel: () => void;
}

/**
 * crmex.md §12 / SAF-01 / SAF-04. Two structurally distinct actions are
 * required before anything sends: "Review recipients" then a separate
 * "Confirm send to N people" — see confirmationGate.ts for why this can't
 * collapse into one tap.
 */
export function SendConfirmation({ recipients, onConfirmed, onCancel }: SendConfirmationProps) {
  const [state, setState] = useState<ConfirmationState>(() => initialConfirmationState(recipients.length));

  return (
    <div data-testid="send-confirmation">
      <h2 data-testid="recipient-count">This will message {state.recipientCount} {state.recipientCount === 1 ? 'person' : 'people'}</h2>
      <ul>
        {recipients.map((r) => (
          <li key={r.jid}>{r.displayName}</li>
        ))}
      </ul>

      {state.step === 'REVIEW' && (
        <button data-testid="btn-review" onClick={() => setState((s) => acknowledgeReview(s))}>
          I've reviewed this list
        </button>
      )}

      {state.step !== 'REVIEW' && (
        <button
          data-testid="btn-confirm-send"
          disabled={!canSend(state)}
          onClick={() => {
            setState((s) => confirmSend(s));
            onConfirmed();
          }}
        >
          Confirm send to {state.recipientCount}
        </button>
      )}

      <button data-testid="btn-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
