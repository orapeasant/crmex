import { describe, it, expect } from 'vitest';
import { initialConfirmationState, acknowledgeReview, confirmSend, canSend } from './confirmationGate.js';

describe('confirmationGate (SAF-01, SAF-04)', () => {
  it('SAF-01: starts in REVIEW with the recipient count attached for prominent display', () => {
    const s = initialConfirmationState(340);
    expect(s.step).toBe('REVIEW');
    expect(s.recipientCount).toBe(340);
  });

  it('SAF-04: a single tap (confirmSend without a prior acknowledgeReview) cannot reach SENDING', () => {
    const s = initialConfirmationState(340);
    expect(() => confirmSend(s)).toThrow('CONFIRMATION_NOT_READY');
  });

  it('SAF-04: two distinct taps are required and in order', () => {
    let s = initialConfirmationState(340);
    expect(canSend(s)).toBe(false);
    s = acknowledgeReview(s);
    expect(canSend(s)).toBe(true);
    s = confirmSend(s);
    expect(s.step).toBe('SENDING');
  });

  it('acknowledging review twice is a no-op, not a fast-path to send', () => {
    let s = initialConfirmationState(10);
    s = acknowledgeReview(s);
    s = acknowledgeReview(s); // second call while already READY_TO_SEND
    expect(s.step).toBe('READY_TO_SEND');
  });
});
