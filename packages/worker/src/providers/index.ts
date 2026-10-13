/**
 * Provider selection. `events.provider` chooses the implementation; each provider
 * slots in here behind the same WebinarProvider interface, so the attendance
 * pipeline and reserve flow never branch on which platform a tenant uses.
 *
 * Live webinars: Teams, Google Meet, Zoom, ON24.
 * Recorded/on-demand video: Wistia, Vimeo (engagement → synthetic interval).
 */

import type { Env } from '../types';
import { MeetProvider } from './meet';
import { On24Provider } from './on24';
import { TeamsProvider } from './teams';
import type { WebinarProvider } from './types';
import { VimeoProvider } from './vimeo';
import { WistiaProvider } from './wistia';
import { ZoomProvider } from './zoom';

export type { WebinarProvider } from './types';

export function getWebinarProvider(
  env: Env,
  portalId: string,
  providerName: string | null | undefined,
): WebinarProvider | null {
  switch (providerName) {
    case 'teams':
      return new TeamsProvider(env, portalId);
    case 'meet':
      return new MeetProvider(env, portalId);
    case 'zoom':
      return new ZoomProvider(env, portalId);
    case 'on24':
      return new On24Provider(env, portalId);
    case 'wistia':
      return new WistiaProvider(env, portalId);
    case 'vimeo':
      return new VimeoProvider(env, portalId);
    default:
      return null;
  }
}
