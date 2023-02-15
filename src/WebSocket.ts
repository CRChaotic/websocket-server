import EventEmitter from "events";
import type { Socket } from "net";
import Opcode from "./utils/Opcode.js";
import { createHash } from "crypto";
import parseHeaders from "./utils/parseHeaders.js";
import Sender from "./Sender.js";
import Receiver from "./Reciever.js";
import type { Frame, Header } from "./Frame.js";
import { isReservedCode, Code } from "./utils/Code.js";
import { constants } from "buffer";
import WebSocketError from "./WebSocketError.js";
import type { Duplex } from "stream";

const DEFAULT_MAX_MESSAGE_SIZE = 1024**2*100;
const MAX_CONTROL_FRAME_PAYLOAD_SIZE = 125;
const MASKING_KEY_SIZE = 4;
const CLOSE_FRAME_CODE_SIZE = 2;

const MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VERSION = "13";
const ZERO_LENGTH_BUFFER = Buffer.alloc(0);

export enum State {
    CONNECTING = 0,
    OPEN = 1,
    CLOSING = 2,
    CLOSED = 3
}

export type WebSocketMessage = {
    data:Buffer;
    type:Opcode.TEXT|Opcode.BINARY;
}

export type WebSocketOptions = {
    maxMessageSize?:number;
    closeTimeout?:number;
    subprotocol?:string;
}

type SendFrameOptions = {
    isFinished?:boolean; 
    rsv?:[boolean, boolean, boolean]; 
    isMasked?:boolean;
    payload?:Buffer;
}

declare interface WebSocket {
    on(event: "message", listener: (message: Buffer, type:Opcode.TEXT|Opcode.BINARY) => void): this;
    on(event: "close", listener: (code?:number, reason?:string) => void): this;
    on(event: "error", listener:(error:Error) => void): this;
    on(event: "pong", listener:(payload?:Buffer) => void): this;
    on(event: "ping", listener:(payload?:Buffer) => void): this;
    on(event:"subprotocols", listener:(subprotocols:string[]) => void): this;
    on(event: string, listener: Function): this;
}

const parseCloseFramePayload = (payload:Buffer) =>{

    const code = payload.readUIntBE(0, CLOSE_FRAME_CODE_SIZE);
    const reason = payload.toString("utf8", CLOSE_FRAME_CODE_SIZE);

    return {code, reason};
};

const createCloseFramePayload = (code:number, reason:string = "") => {

    const reasonLength = Buffer.byteLength(reason);
    const payload = Buffer.allocUnsafe(CLOSE_FRAME_CODE_SIZE + reasonLength);
    payload.writeUIntBE(code, 0, CLOSE_FRAME_CODE_SIZE);
    payload.write(reason, CLOSE_FRAME_CODE_SIZE, "utf8");
    
    return payload;
};

class WebSocket extends EventEmitter {

    #state:State;
    #sender:Sender;
    #receiver:Receiver;
    #framePayloads:Buffer[];
    #messageType:Opcode.TEXT|Opcode.BINARY|-1;
    #code:number;
    #reason:string;
    #bufferedPayloadSize:number;

    #subprotocol:string;
    #socket:Duplex;
    #closeTimeout:number;
    #closeTimer?:NodeJS.Timer;
    #maxMessageSize:number;

    constructor(key:string, socket:Duplex, {
        subprotocol = "",
        maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE,
        closeTimeout = 1000,
    }:WebSocketOptions = {}){
        if(maxMessageSize < MAX_CONTROL_FRAME_PAYLOAD_SIZE || MASKING_KEY_SIZE > constants.MAX_LENGTH){
            throw Error(`max mesage size must be between ${MAX_CONTROL_FRAME_PAYLOAD_SIZE} and ${constants.MAX_LENGTH}`);
        }

        super();
        this.#state = State.CONNECTING;
        this.#socket = socket;
        this.#subprotocol = subprotocol;
        this.#framePayloads = [];
        this.#messageType = -1;
        this.#code = Code.RESERVED_NO_STATUS;
        this.#reason = "";
        this.#closeTimeout = closeTimeout;
        this.#maxMessageSize = maxMessageSize;
        this.#bufferedPayloadSize = 0;

        this.#sender = new Sender();
        this.#receiver = new Receiver();
        this.#sender.pipe(this.#socket);
        this.#socket.pipe(this.#receiver);

        this.#sender.on("error", (err) => this.emit("error", err));
        this.#sender.on("close", () => this.#socket.end());
        this.#socket.on("error", () => this.emit("error", new Error("Underlying socket error")));
        this.#socket.on("close", () => {
            console.log("socket closed");
            //has not finished closing handshake yet
            if(this.#state !== State.CLOSED){
                this.#code = Code.RESERVED_ABNORMAL_CLOSE;
            }
            //clear up socket reference
            clearTimeout(this.#closeTimer);
            this.#state = State.CLOSED;
            this.emit("close", this.#code, this.#reason);
        });

        this.#receiver.on("close", () => console.log("receiver closed"));
        this.#receiver.on("header", this.#receiveHeader.bind(this));
        this.#receiver.on("data", this.#receiveFrame.bind(this));
        this.#receiver.on("error", (webSocketError) => {
            if(!this.#sender.writable){
                return;
            }
            //send last close frame
            this.close(webSocketError.code, webSocketError.reason)
            .catch(console.error);
        });

        this.#finishOpeningHandshake(key);
    }

    get state(){
        return this.#state;
    }

    get subprotocol(){
        return this.#subprotocol;
    }

    static getVersion(){
        return VERSION;
    }

    #finishOpeningHandshake(key:string){
        const webSocketAccept = createHash("sha1").update(key + MAGIC_STRING).digest("base64");
        const rawHeader:{[k:string]:string} = {
            "connection": "upgrade",
            "upgrade": "websocket",
            "sec-websocket-accept":webSocketAccept
        };

        if(this.#subprotocol !== ""){
            rawHeader["sec-websocket-protocol"] = this.#subprotocol;
        }
        
        const handshakeResponse =  parseHeaders(101, "Switching Protocols", rawHeader);
        this.#socket.write(handshakeResponse, (err) =>{
            if(!err){
                this.#state = State.OPEN;
                this.emit("open");
            }
        });
    }

    #finishClosingHandshake(code?:number, reason = "", options:{rsv?:[boolean, boolean, boolean], isMasked?:boolean}={}){

        let payload = ZERO_LENGTH_BUFFER;
        if(code != null){
            payload = createCloseFramePayload(code, reason);
        }

        this.#sender.end({
                isFinished:true, 
                rsv:options?.rsv??[false, false, false],
                opcode:Opcode.CLOSE,
                isMasked:options?.isMasked??false,
                payload
        }, () => this.#state = State.CLOSED);
    }

    #receiveHeader(header:Header){

         this.#bufferedPayloadSize += header.payloadLength;

         if(this.#bufferedPayloadSize > this.#maxMessageSize){
            this.#receiver.destroy(new WebSocketError(
                Code.MESSAGE_TOO_LARGE, 
                `Exceeds max message size`
            ));
         }
         if(header.isFinished){
            this.#bufferedPayloadSize = 0;
         }

    }

    #receiveFrame(frame:Frame){
        // console.log("frame:", frame);
        switch(frame.opcode){

            case Opcode.CLOSE:
                if(this.#state === State.OPEN){
                    this.#state = State.CLOSING;

                    if(frame.payload.byteLength > 0){
                        const {code, reason} = parseCloseFramePayload(frame.payload);
                        this.#code = code;
                        this.#reason = reason;
                        this.#finishClosingHandshake(code, reason);
                    }else{
                        this.#finishClosingHandshake();
                    }
                        
                }else if(this.#state ===  State.CLOSING){
                    this.#state =  State.CLOSED;
                }
                
                console.log("recieved close frame");
                break;
            case Opcode.PONG:
                this.emit("pong", frame.payload);
                break;
            case Opcode.PING:
                this.emit("ping", frame.payload);
                break;
            case Opcode.TEXT:
            case Opcode.BINARY:
                this.#messageType = frame.opcode;
                this.#framePayloads = [frame.payload];

                if(frame.isFinished){
                    this.emit("message", frame.payload, this.#messageType);
                    this.#messageType = -1;
                    this.#framePayloads = [];
                }

                break;
            case Opcode.CONTINUATION:
                //no message type continuation frame is disposed
                if(this.#messageType === -1){
                    return;
                }

                this.#framePayloads.push(frame.payload);
                if(frame.isFinished){
                    this.emit("message", Buffer.concat(this.#framePayloads), this.#messageType);
                    this.#framePayloads = [];
                    this.#messageType = -1;
                }
                break;
            default:
                //ignore unknown frame
        }

        //take a break
        this.#socket.pause();
        setImmediate(() =>  this.#socket.resume());
    }

    #sendFrame(
        opcode:number,
        {
            isFinished = true, 
            rsv = [false, false, false],
            isMasked = false,
            payload = ZERO_LENGTH_BUFFER,
        }:SendFrameOptions = {}
    ){
        return new Promise<void>((resolve, reject) => {
            if(this.#sender.closed){
                return reject(new Error("Cannot send frame when sender has closed"));
            }
    
            const frame = {
                isFinished, 
                rsv,
                opcode,
                isMasked,
                payload,
            };

            if(opcode === Opcode.CLOSE){
                this.#sender.end(frame, resolve);
            }else{
                this.#sender.write(frame, (err) => err ? reject(err):resolve());
            }
        });
    }

    async send(message:Buffer, type:Opcode.TEXT|Opcode.BINARY, options?:{isMasked?:boolean, rsv?:[boolean, boolean, boolean]}){
        if(this.#state !== State.OPEN){
            throw new Error("Cannot send message when state is not OPEN");
        }

        await this.#sendFrame(type, {...options, payload:message});
    }

    async close(code:number, reason = "", options?:{isMasked?:boolean, rsv?:[boolean, boolean, boolean]}){
        if(this.#state !== State.OPEN){
            throw new Error("Cannot send close frame when state is not OPEN");
        }

        if(code != null){
            const maxReasonLength = MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE;
            if(Buffer.byteLength(reason) > maxReasonLength){
                throw new Error("Length of reason must not be greater than " + maxReasonLength +"bytes");
            }
            if(isReservedCode(code)){
                throw new Error(`Code ${code} is a reserved code`);
            }

            const payload = createCloseFramePayload(code, reason);
            await this.#sendFrame(Opcode.CLOSE, {...options, payload});
        }else{
            await this.#sendFrame(Opcode.CLOSE, options);
        }
        //wait for response close frame
        this.#closeTimer = setTimeout(() => {
            if(!this.#socket.writable){
                return;
            }
            //time out and force close socket
            console.log("coerce to close socket");
            this.#socket.end();
        }, this.#closeTimeout);

        this.#state = State.CLOSING;
    }

    async ping(options?:{payload?:Buffer, isMasked?:boolean, rsv?:[boolean, boolean, boolean]}){
        if(this.#state !== State.OPEN){
            throw new Error("state is not OPEN cannot send pong frame");
        }
    
        await this.#sendFrame(Opcode.PING, options);
    }

    async pong(options?:{payload?:Buffer, isMasked?:boolean, rsv?:[boolean, boolean, boolean]}){
        if(this.#state !== State.OPEN){
            throw new Error("state is not OPEN cannot send pong frame");
        }

        await this.#sendFrame(Opcode.PONG, options);
    }
}

export default WebSocket;