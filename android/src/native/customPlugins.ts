import { registerPlugin } from '@capacitor/core';

export interface BackgroundEngineApi {
  start(): Promise<{ notificationsGranted?: boolean } | void>;
  stop(): Promise<void>;
}
export const BackgroundEngine = registerPlugin<BackgroundEngineApi>('BackgroundEngine');

export interface BatteryWhitelistApi {
  isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
}
export const BatteryWhitelist = registerPlugin<BatteryWhitelistApi>('BatteryWhitelist');

export interface MediaSaveApi {
  saveImage(opts: { base64Data: string; filename?: string }): Promise<{ saved: boolean }>;
}
export const MediaSave = registerPlugin<MediaSaveApi>('MediaSave');
