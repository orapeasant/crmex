// Pure state machine behind the send-confirmation UI (crmex.md §12,
// SAF-01/SAF-04). "A confirmation step that shows 'this will message 340
// people' is the cheapest guard against an accidental mass send" — and
// SAF-04 requires that a mass send "cannot happen by a single mistaken
// tap." This module makes that a structural property: two distinct,
// different actions are required, not two calls to the same handler.
export type ConfirmationStep = 'REVIEW' | 'READY_TO_SEND' | 'SENDING';

export interface ConfirmationState {
  step: ConfirmationStep;
  recipientCount: number;
}

export function initialConfirmationState(recipientCount: number): ConfirmationState {
  return { step: 'REVIEW', recipientCount };
}

/** First tap: "I've reviewed the recipient list." Does not send anything. */
export function acknowledgeReview(state: ConfirmationState): ConfirmationState {
  if (state.step !== 'REVIEW') return state;
  return { ...state, step: 'READY_TO_SEND' };
}

/** Second, distinct tap: only valid after acknowledgeReview() has already
 * fired. This is what SAF-04 requires — a single tap on "Send" alone can
 * never reach the SENDING state. */
export function confirmSend(state: ConfirmationState): ConfirmationState {
  if (state.step !== 'READY_TO_SEND') {
    throw new Error('CONFIRMATION_NOT_READY');
  }
  return { ...state, step: 'SENDING' };
}

export function canSend(state: ConfirmationState): boolean {
  return state.step === 'READY_TO_SEND';
}
