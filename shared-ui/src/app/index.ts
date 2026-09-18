// The shared CRMEX app. A shell (Android, browser) renders <CrmexApp> with its
// PlatformServices implementation and imports './styles.css' once.
export { CrmexApp, type CrmexAppProps } from './CrmexApp.js';
export type { DirectMessaging, KeyValueStore, PlatformServices, WhatsAppState, WhatsAppStatus } from './platform.js';
export { CrmexProviders, useCrmexSession, type CrmexSession, type CrmexSessionOptions } from './session.js';
export { useApp, useFirm, useActiveFirm, type AppContextValue, type FirmContextValue } from './context.js';
export { useMessaging, type MessagingContextValue } from './messages/MessagingProvider.js';
export { usePendingInvite, type PendingInvite } from './firm/invites.js';
export { shareLink } from './firm/FirmSettingsPage.js';
export * from './data.js';
export { JOB_STATUS, SKIP_REASON_LABELS, STATUS_BADGE } from './messages/status.js';
export { EMPTY_DRAFT, MAX_MESSAGE_CHARS, draftImage, isDraftComplete, type GeneratedImage, type MessageDraft } from './messages/wizard/types.js';
export { resolveAppRegion, useRegion, loadRegionOverride, saveRegionOverride } from './ui/region.js';
export { initialsFor, profileFromUser, type UserProfile } from './ui/Avatar.js';
export { describeError, formatDate, formatDateTime, todayIsoDate } from './ui/util.js';
