
// @flow

import type { MessageSink } from './message_sink';

type User = { username: string };

// Translation from Notifications bus messages ('events-changed') to socket.IO
// messages ('eventsChanged') happens here. Translated messages are sent to 
// the sink registered while constructing this class. 
//
class ChangeNotifier {
  sink: MessageSink; 
  
  // Constructs a change notifier; messages flow from `source` (Notifications 
  // bus) to the `sink`. 
  // 
  constructor(sink: MessageSink) {
    this.sink = sink; 
  }
  
  // Listens to messages that are of interest to us and forward them to 
  // #extractAndDeliver.
  //
  listenTo(source: EventEmitter) {
    const messageMap = [
      ['accesses-changed', 'accessesChanged'],
      ['events-changed', 'eventsChanged'],
      ['streams-changed', 'streamsChanged'],
    ];
    
    for (const [from, to] of messageMap) {
      source.on(from, 
        (user) => this.extractAndDeliver(to, user));
    }
  }
  
  // Extracts information from the user object and #delivers the message. 
  // 
  extractAndDeliver(message: string, user: User) {
    const userName = user.username;
    const sink = this.sink; 
    
    sink.deliver(userName, message);
  }
}
module.exports = ChangeNotifier;
