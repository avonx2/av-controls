import { type Message } from '../messages';

/**
 * Communication adapter interface for different transport methods
 */
export abstract class Sender {
  /**
   * Protocol version of the connected peer, captured from the envelope of
   * received messages. Null/undefined until known. Optional so lightweight
   * custom senders (e.g. relay shims) need not implement it. Transport-agnostic
   * read point for the version seam (e.g. ControllerClient.getPeerVersion).
   */
  public peerVersion?: string | null;

  /**
   * Send a message to the target
   */
  abstract send(message: Message): void;

  /**
   * Adopt the controller's client id, if the transport needs it (e.g. the
   * websocket transport tags its frames with it). Optional so transports that
   * don't multiplex per-client (window/postMessage, relay shims) can omit it;
   * callers invoke it via optional chaining.
   */
  setClientId?(clientId: string): void;

  getBufferedAmount(): number {
    return 0;
  }
  
  /**
   * Register a listener for incoming messages
   */
  abstract addListener(listener: (message: Message) => void): () => void;
}
