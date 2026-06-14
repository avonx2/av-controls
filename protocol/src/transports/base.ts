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

  getBufferedAmount(): number {
    return 0;
  }
  
  /**
   * Register a listener for incoming messages
   */
  abstract addListener(listener: (message: Message) => void): () => void;
}
