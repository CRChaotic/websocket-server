# websocket-server
A simple websocket server

## enum: `Opcode`
+ CONTINUATION = 0x0
+ TEXT= 0x1
+ BINARY = 0x2
+ CLOSE = 0x8
+ PING = 0x9
+ PONG = 0xa

## enum: `State`
+ CONNECTING = 0,
+ OPEN = 1,
+ CLOSING = 2,
+ CLOSED = 3

## Class: `WebSocketServer`
### Extends: [EventEmitter](https://nodejs.org/dist/latest-v19.x/docs/api/events.html#class-eventemitter)

### Event: `listening`
The is listening is emitted when the websocket server started listening to connection
### Event: `connection`
The connection event is emitted once websocket opening handshake get started
+ websocket:[WebSocket](#classwebsocket)

### Constructor: `new WebSocketServer`(options)
+ options: `Object`
    + port: `number` The port to which websocket server listen
    + key: [Buffer](https://nodejs.org/dist/latest-v19.x/docs/api/buffer.html#class-buffer) Private key
    + cert: [Buffer](https://nodejs.org/dist/latest-v19.x/docs/api/buffer.html#class-buffer) Cert chain
    + allowOrigin?: `string[]` Those origins are allowed to connect to websocket server, if it doesn't provide, allow all origins
    + path?: `string` This http path is allowed to connect to websocket server
    + maxConnections?: `number` The maximum size of connections
    + authorizer?: [Authorizer]() Authenticating connections 
    + maxMessageSize?: `number` The maximum size of a message
    + maxFrameSize?: `number` The maximum size of a frame 
    + handleSubprotocols?: `(subprotocols:string[]) => string` choosing a websocket subprotocol when a new connection is finishing opening handshake

## Class: `WebSocket`
### Extends: [EventEmitter](https://nodejs.org/dist/latest-v19.x/docs/api/stream.html#class-streamtransform)

### Event: `open`
The open event is emitted when websocket opening handshake is finished

### Event: `message`
The message event is emitted when all fragmented frames is received
+ message:[Buffer](https://nodejs.org/dist/latest-v19.x/docs/api/buffer.html#class-buffer)
+ type:[Opcode.TEXT | Opcode.BINARY](#enum-opcode) 

### Event: `ping`
The ping event is emitted when received a ping frame
+ payload:[Buffer](https://nodejs.org/dist/latest-v19.x/docs/api/buffer.html#class-buffer)

### Event: `pong`
The pong event is emitted when received a pong frame
+ payload:[Buffer](https://nodejs.org/dist/latest-v19.x/docs/api/buffer.html#class-buffer)

### Event: `error`
The error event is emitted when send a frame which violated websocket protocol
+ error:[Error](https://nodejs.org/dist/latest-v19.x/docs/api/errors.html#class-error)

### Event: `close`
The close event is emitted  when finished closing handshake or underlying connection is lost

### Property: `state`: [State](#enum-state)
WebSocket current state, cannot send any frame if it is not in OPEN state 

### Property: `subprotocol`: `string`
WebSocket current subprotocol

### Static Method: `getVersion`()
Return supported websocket version 13
+ Return: `string`

### Method: `send`(message: [Buffer](), type: [Opcode.TEXT|Opcode.BINARY](#enum-opcode), options)
Send a message to a connection
+ Return: [Promise\<void>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)
+ options?: `Object`
    + isMasked?: `boolean`
    + rsv?: `[boolean, boolean, boolean]`

### Method: `close`(message: [Buffer](), type: [Opcode.TEXT|Opcode.BINARY](#enum-opcode), options)
Send a close frame to a connection
+ Return: [Promise\<void>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)
+ options?: `Object`
    + isMasked?: `boolean`
    + rsv?: `[boolean, boolean, boolean]`

### Method: `ping`(options)
Send a ping frame to a connection
+ Return: [Promise\<void>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)
+ options?: `Object`
    + payload?: [Buffer]()
    + isMasked?: `boolean`
    + rsv?: `[boolean, boolean, boolean]`

### Method: `pong`(options)
Send a pong frame to a connection
+ Return: [Promise\<void>](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)
+ options?: `Object`
    + payload?: [Buffer]()
    + isMasked?: `boolean`
    + rsv?: `[boolean, boolean, boolean]`


