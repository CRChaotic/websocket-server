import EventEmitter from "events";
import type { Socket } from "net";
import Opcode from "./utils/Opcode.js";
import { createHash } from "crypto";
import parseHeaders from "./utils/parseHeaders.js";
import Sender from "./Sender.js";
import Receiver from "./Reciever.js";
import type { Frame, Header } from "./Frame.js";
import { isReservedStatusCode, StatusCode } from "./utils/StatusCode.js";
import { constants } from "buffer";
import WebSocketError from "./WebSocketError.js";

const DEFAULT_MAX_MESSAGE_SIZE = 1024**2*50;
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

    if(payload.byteLength === 0){
        return {};
    }

    const code = payload.readUInt16BE(0);
    const reason = payload.toString("utf8", 2);
    return {code, reason};
};

class WebSocket extends EventEmitter {

    #state:State;
    #sender:Sender;
    #receiver:Receiver;
    #framePayloads:Buffer[];
    #messageType:Opcode.TEXT|Opcode.BINARY|-1;
    #statusCode:number;
    #reason:string;
    #bufferedPayloadSize:number;

    #subprotocol:string;
    #socket:Socket;
    #closeTimeout:number;
    #maxMessageSize:number;

    constructor(key:string, socket:Socket, {
        subprotocol = "",
        maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE,
        closeTimeout = 5000,
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
        this.#statusCode = StatusCode.RESERVED_NO_STATUS;
        this.#reason = "";
        this.#closeTimeout = closeTimeout;
        this.#maxMessageSize = maxMessageSize;
        this.#bufferedPayloadSize = 0;

        this.#sender = new Sender();
        this.#receiver = new Receiver();
        this.#sender.pipe(this.#socket);
        this.#socket.pipe(this.#receiver);

        this.#socket.on("error", (err) => this.emit("error", err));
        this.#sender.on("error", (err) => {
            this.emit("error", err);
            console.error("socker error");
        });
        this.#socket.on("close", () => {
            console.log("socket closed");
            this.#receiver.destroy();
        });

        this.#receiver.on("header", this.#handleHeader.bind(this));
        this.#receiver.on("data", this.#handleFrame.bind(this));
        this.#receiver.on("error", (webSocketError) => {
            this.close(webSocketError.code, webSocketError.reason);
        });
        this.#receiver.on("close", () => {
            console.log("receiver closed");
            if(this.#state !== State.CLOSED){
                this.#statusCode = StatusCode.RESERVED_ABNORMAL_CLOSE;
            }
            this.#state = State.CLOSED;
            this.emit("close", this.#statusCode, this.#reason);
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
        this.#socket.write(handshakeResponse, (err) => {
            if(err){
                return;
            }

            this.#state = State.OPEN;
            this.emit("open");
        });
    }

    async #finishClosingHandshake(code?:number, reason = "", isMasked = false){
        return new Promise<void>(async (resolve, reject) => {
            if(this.#state !== State.CLOSING){
                reject(new Error("hasn't received close frame from the other endpoint, cannot finish closing handshake"));
                return;
            }
    
            try{
                await this.#sendCloseFrame(code, reason, isMasked);
                this.#state = State.CLOSED;
                resolve();
            }catch(err){
                reject(err);
            }
        })
        
    }

    #handleHeader(header:Header){
         // console.log(header);
         this.#bufferedPayloadSize += header.payloadLength;
         // console.log("message size:", bufferedPayloadSize);
         if(this.#bufferedPayloadSize > this.#maxMessageSize){
            this.#receiver.destroy(new WebSocketError(
                StatusCode.MESSAGE_TOO_LARGE, 
                `max message size must not exceed ${this.#maxMessageSize}`
            ));
         }
         if(header.isFinished){
            this.#bufferedPayloadSize = 0;
         }
    }

    async #handleFrame(frame:Frame){
        // console.log("frame:", frame);
        switch(frame.opcode){

            case Opcode.CLOSE:
                const {code, reason} = parseCloseFramePayload(frame.payload);

                if(this.#state === State.OPEN){
                    this.#state = State.CLOSING;
                   
                    if(code != null && isReservedStatusCode(code)){
                        await this.#finishClosingHandshake(StatusCode.PROTOCOL_ERROR);
                    }else{
                        await this.#finishClosingHandshake(code, reason);
                    }

                }else if(this.#state ===  State.CLOSING){
                    this.#state =  State.CLOSED;
                }

                if(code != null){
                    if(isReservedStatusCode(code)){
                        this.#statusCode = StatusCode.RESERVED_ABNORMAL_CLOSE;
                        this.#reason = "close frame is containning reserved status code";
                    }else{
                        this.#statusCode = code;
                        this.#reason = reason??"";
                    }
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
                this.#receiver.destroy(new WebSocketError(StatusCode.PROTOCOL_ERROR, "unknown frame"));
        }

        // this.#socket.pause();
        // setTimeout(() => this.#socket.resume());
    }

    async send(message:Buffer, type:Opcode.TEXT|Opcode.BINARY, isMasked = false){
        return new Promise<void>((resolve, reject) => {
            if(this.#state !== State.OPEN){
                return reject(new Error("state is not OPEN cannot send message"))
            }

            this.#sender.write({
                isFinished:true, 
                rsv:[false, false, false],
                opcode:type,
                isMasked:false,
                payloadLength:message.byteLength,
                payload:message
            }, (err) => err ? reject(err):resolve());

        });
    }

    async #sendCloseFrame(code?:number, reason = "", isMasked = false){
        return new Promise<void>((resolve, reject) => {
            const reasonLength = Buffer.byteLength(reason);
            if(reasonLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE){
                reject(new Error(
                    "length of reason must not be greater than "+
                    (MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE) + "bytes"
                ));
                return;
            }
    
            let payload:Buffer|null = null;
            if(code != null){
                payload = Buffer.allocUnsafe(CLOSE_FRAME_CODE_SIZE + reasonLength);
                payload.writeUIntBE(code, 0, CLOSE_FRAME_CODE_SIZE);
                payload.write(reason, CLOSE_FRAME_CODE_SIZE, "utf8");
            }
    
            this.#sender.end({
                isFinished:true, 
                rsv:[false, false, false],
                opcode:Opcode.CLOSE,
                isMasked,
                payloadLength:payload?.byteLength??0,
                payload:payload??ZERO_LENGTH_BUFFER
            },  resolve);
        });

    }

    async close(code?:number, reason = "", isMasked = false){
        return new Promise<void>(async (resolve, reject) => {
            if(this.#state !== State.OPEN){
                reject(new Error("state is not OPEN cannot send close frame"));
                return;
            }

            try{
                await this.#sendCloseFrame(code, reason, isMasked);
                this.#state = State.CLOSING;
                setTimeout(() => {
                    if(this.#state !== State.CLOSED){
                        this.#socket.destroy();
                    }
                }, this.#closeTimeout);

                resolve();
            }catch(err){
                reject(err);
            }
        });
    }

    ping(payload?:Buffer, isMasked = false){
        if(this.#state !== State.OPEN){
            return;
        }

        if(payload && payload.byteLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
            this.emit("error", new Error(
                "control frame and control frame payload must be less than "+
                MAX_CONTROL_FRAME_PAYLOAD_SIZE+" bytes"
            ));
            return;
        }

        this.#sender.write({
            isFinished:true, 
            rsv:[false, false, false],
            opcode:Opcode.PING,
            isMasked,
            payloadLength:payload?.byteLength??0,
            payload:payload??ZERO_LENGTH_BUFFER
        });
    }

    pong(payload?:Buffer, isMasked = false){
        if(this.#state !== State.OPEN){
            return;
        }

        if(payload && payload.byteLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
            this.emit("error", new Error(
                "control frame payload must be less than "+
                MAX_CONTROL_FRAME_PAYLOAD_SIZE+" bytes"
            ));
            return;
        }

        this.#sender.write({
            isFinished:true, 
            rsv:[false, false, false],
            opcode:Opcode.PONG,
            isMasked,
            payloadLength:payload?.byteLength??0,
            payload:payload??ZERO_LENGTH_BUFFER
        });
    }
}

export default WebSocket;