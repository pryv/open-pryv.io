// @flow

// A consumer for our kind of notification messages. 
// 
export interface MessageSink {
  deliver(userName: string, message: string | {}): void; 
}
