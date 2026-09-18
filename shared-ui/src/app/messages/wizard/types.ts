export interface GeneratedImage {
  sessionId: string;
  /** Storage object path — what the outbox and message history record. */
  path: string;
  /** Short-lived signed URL; kept in memory for the preview only, never persisted or logged. */
  previewUrl: string;
}

export interface MessageDraft {
  text: string;
  imageEnabled: boolean;
  image: GeneratedImage | null;
}

export const EMPTY_DRAFT: MessageDraft = { text: '', imageEnabled: false, image: null };

export const MAX_MESSAGE_CHARS = 4096;

/** The image only goes out if the toggle is on and one was actually generated. */
export function draftImage(draft: MessageDraft): GeneratedImage | null {
  return draft.imageEnabled ? draft.image : null;
}

export function isDraftComplete(draft: MessageDraft): boolean {
  if (draft.imageEnabled && !draft.image) return false;
  return draft.text.trim().length > 0 || draftImage(draft) !== null;
}
