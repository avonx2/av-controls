import packageJson from '../../package.json';

import { type Message } from '../messages';

/**
 * The protocol version this build speaks. Single source of truth for the
 * version that gets stamped onto every {@link Envelope}.
 */
export const PROTOCOL_VERSION: string = packageJson.version;

/**
 * Stable discriminator on every envelope. Lets a transport that shares a
 * channel with unrelated traffic (e.g. a window receiving postMessages from
 * youtube/oauth/the mixer) reliably pick out av-controls frames. This tag must
 * never change.
 */
export const ENVELOPE_TYPE = 'av-controls-envelope' as const;

/**
 * The outermost, transport-agnostic frame. This is the ONE shape that must
 * never break: any peer — present or future — can always parse
 * `{ type, protocol }` before deciding how to interpret `message`. Transports
 * may wrap this with their own routing fields (e.g. a websocket panelId), but
 * they must not replace it.
 */
export interface Envelope {
  type: typeof ENVELOPE_TYPE;
  protocol: string;
  message: Message;
}

/**
 * Stamp a message with a protocol version. Defaults to this build's
 * {@link PROTOCOL_VERSION}; a relay (the broker) passes an explicit version so
 * it forwards the originating peer's version rather than its own.
 */
export function wrap(message: Message, protocol: string = PROTOCOL_VERSION): Envelope {
  return { type: ENVELOPE_TYPE, protocol, message };
}

/**
 * Narrow an unknown value to an {@link Envelope}.
 */
export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object'
    && value !== null
    && (value as Envelope).type === ENVELOPE_TYPE
    && typeof (value as Envelope).protocol === 'string'
    && typeof (value as Envelope).message === 'object'
    && (value as Envelope).message !== null
  );
}

function majorOf(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? -1 : major;
}

/**
 * Compatibility check between a peer's protocol version and ours. Same major
 * version is considered compatible (additive minor/patch changes only). This
 * is the seam a future host uses to decide whether it can speak to a peer
 * directly or needs to load a different controller version.
 */
export function isCompatible(peerVersion: string): boolean {
  const peerMajor = majorOf(peerVersion);
  return peerMajor >= 0 && peerMajor === majorOf(PROTOCOL_VERSION);
}
