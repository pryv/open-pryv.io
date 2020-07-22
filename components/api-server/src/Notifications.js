// @flow

const EventEmitter = require('events');

// Notifications class distributes notifications inside the current process and
// via NATS server to the other api-server processes. Notifications are also
// sent to the axon PUB socket; this is mostly used by the tests. 
// 
class Notifications extends EventEmitter {
  axonSocket: EventEmitter; 
  
  // Construct a notifications instance. Normally called by the application 
  // start; one per process. 
  // 
  constructor(axonSocket: EventEmitter) {
    super();
    
    if (axonSocket == null)
      throw new Error('AF: axonSocket cannot be null');
    
    this.axonSocket = axonSocket;
  }
  
  serverReady() {
    this.dispatch('server-ready');
  }
  accountChanged(userName: string) {
    this.dispatch('account-changed', userName);
  }
  accessesChanged(userName: string) {
    this.dispatch('accesses-changed', userName);
  }
  followedSlicesChanged(userName: string) {
    this.dispatch('followed-slices-changed', userName);
  }
  streamsChanged(userName: string) {
    this.dispatch('streams-changed', userName);
  }
  eventsChanged(userName: string) {
    this.dispatch('events-changed', userName);
  }
  
  // Send the given `msg` to both internal and external listeners. This is an 
  // internal API, you probably want to use one of the other methods here. 
  //
  dispatch(msg: string, ...msgParts: Array<mixed>) {
    // Send the message to all listeners in-process
    this.emit(msg, ...msgParts);
    
    // And to all listeners on the axon PUB socket
    this.axonSocket.emit(msg, ...msgParts);
  }
}

module.exports = Notifications;

