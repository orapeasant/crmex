// Readable messages for errors the firm-scoped tables raise (RLS, triggers,
// constraints), core-server error codes, and codes shared-ui throws itself.

function codeOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function describeDataError(err: unknown): string {
  const code = codeOf(err);
  const message = messageOf(err);
  switch (code) {
    case '23505':
      if (/phone/i.test(message)) return 'Another client in this firm already has this phone number.';
      if (/matter_number/i.test(message)) return 'Another matter in this firm already uses this matter number.';
      if (/matter_clients|pkey/i.test(message)) return 'That client is already linked to this matter.';
      return 'This would create a duplicate of an existing record.';
    case '42501':
      return "You don't have permission to do that in this firm.";
    case '23514':
      if (/assignee/i.test(message)) return 'The assignee must be a member of this firm.';
      if (/send_jobs transition/i.test(message)) return 'This message has already moved on (sent, cancelled or picked up by your phone).';
      return 'Some of the values are not allowed.';
    case '23503':
      return 'A linked record no longer exists in this firm. Refresh and try again.';
    case 'PGRST116':
      return 'That record was not found. It may have been deleted.';
    case 'NOT_PERMITTED':
      return "You don't have permission to do that in this firm, or the record no longer exists.";
    case 'QUOTA_EXCEEDED':
      return "Your firm has reached today's usage limit. Try again tomorrow.";
    case 'NOT_A_MEMBER':
      return "You're no longer a member of this firm.";
    case 'ORG_REQUIRED':
      return 'Choose a firm first.';
    case 'LAST_OWNER':
      return 'A firm needs at least one owner. Make someone else an owner first.';
    case 'HTTP_404':
      return "The server doesn't support this yet (core-server may need updating). Try again later.";
    case 'SENDER_BUSY':
      return message;
  }
  switch (message) {
    case 'EMPTY_BATCH':
      return 'Choose at least one recipient.';
    case 'EMPTY_MESSAGE':
      return 'Write a message or add an image first.';
    case 'NO_SENDABLE_RECIPIENTS':
      return 'None of the selected clients can receive messages (opted out or no phone number).';
    case 'BATCH_TOO_LARGE':
      return 'That is more recipients than one message may go to. Split it into smaller groups.';
    case 'CONTACTS_PERMISSION_DENIED':
      return 'Contacts permission was denied. Allow it in the phone settings to import contacts.';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return "Couldn't reach the server. Check your connection and try again.";
  return message;
}
