import EventEmitter from "events";
import type { Socket } from "net";
import buffer from "buffer";
import createFrame from "./utils/createFrame.js";
import type { ExtendedPayloadLengthSize } from "./utils/ExtendedPayloadLengthSize.js";
import isControlFrame from "./utils/isControlFrame.js";

import parseFinAndOpcode from "./utils/parseFinAndOpcode.js";
import parseMaskAndPayloadLength from "./utils/parseMaskAnyPayloadLength.js";
import Opcode from "./utils/Opcode.js";
import { Duplex, Readable } from "stream";
import { createHash } from "crypto";
import parseHeaders from "./utils/parseHeaders.js";

const DEFAULT_MAX_MESSAGE_SIZE = 1024**2;
const DEFAULT_CLOSE_TIMEOUT = 3000;
const MAX_CONTROL_FRAME_PAYLOAD_SIZE = 125;
const MAX_EXTENDED_PAYLOAD_LENGTH_SIZE = 8;
const MASKING_KEY_SIZE = 4;
const CLOSE_FRAME_CODE_SIZE = 2;
// const FramePart = Object.freeze({
//     FIN_AND_OPCODE:0,
//     MASK_AND_PAYLOAD_LENGTH:1,
//     EXTENDED_PAYLOAD_LENGTH:2,
//     PAYLOAD:3,
//     MASKING_KEY:4,
// });

const MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PROTOCOL_VERSION = "13";

enum FramePart {
    FIN_AND_OPCODE = 0,
    MASK_AND_PAYLOAD_LENGTH = 1,
    EXTENDED_PAYLOAD_LENGTH = 2,
    MASKING_KEY = 3,
    PAYLOAD = 4,
}

export enum ReadyState {
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
}

declare interface WebSocket {
    on(event: "message", listener: (websocketMessage: WebSocketMessage) => void): this;
    on(event: "close", listener: (code?:number, reason?:string) => void): this;
    on(event: "error", listener:(error:Error) => void): this;
    on(event: "pong", listener:() => void): this;
    on(event: "timeout", listener:() => void): this;
    on(event: string, listener: Function): this;
}

class WebSocket extends EventEmitter{

    #maxMessageSize:number;
    #closeTimeout:number;
    #socket:Socket;
    #readyState:ReadyState = ReadyState.CONNECTING;
    #payload?:Buffer;
    #messageSize:number;
    #extendedPayloadLengthBuffer:Buffer;

    #isFinished:boolean;
    #rsv:boolean[];
    #opcode:Opcode;
    #isMasked:boolean;
    #payloadLength:bigint;
    #extendedPayloadLengthSize:ExtendedPayloadLengthSize;
    #maskingKey:Buffer;

    #bufferedSize:number;
    #framePart:number = FramePart.FIN_AND_OPCODE;

    constructor(socket:Socket, {maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE, closeTimeout = DEFAULT_CLOSE_TIMEOUT}:WebSocketOptions = {}){
        super();
        this.#socket = socket;

        if(maxMessageSize < MAX_CONTROL_FRAME_PAYLOAD_SIZE){
            throw new RangeError("Max payload buffer size should be "+MAX_CONTROL_FRAME_PAYLOAD_SIZE+" bytes at least for working with control frame properly");
        }else if(maxMessageSize > buffer.constants.MAX_LENGTH){
            throw new RangeError("Max payload buffer size should be less than " + buffer.constants.MAX_LENGTH + " bytes");
        }

        this.#isFinished = true;
        this.#rsv = [false, false, false];
        this.#opcode = Opcode.CLOSE;
        this.#isMasked = false;
        this.#payloadLength = -1n;
        this.#extendedPayloadLengthSize = 0;
        this.#maskingKey = Buffer.alloc(MASKING_KEY_SIZE);

        this.#messageSize = 0;
        this.#maxMessageSize = maxMessageSize;
        this.#extendedPayloadLengthBuffer = Buffer.alloc(MAX_EXTENDED_PAYLOAD_LENGTH_SIZE);

  
        this.#closeTimeout = closeTimeout;
        this.#bufferedSize = 0;

        socket.on("data", this.#handleData.bind(this));
        socket.on("error", (err) => this.emit("error", err));
        socket.on("close", () => {
            if(this.#readyState !== ReadyState.CLOSED){
                this.emit("close", 1006, "");
            }else if(this.#payload && this.#payload.byteLength >= 2){
                const code = this.#payload.readUInt16BE(0);
                const reason =this.#payload.toString("utf-8", CLOSE_FRAME_CODE_SIZE);
                this.emit("close", code, reason);
            }else{
                this.emit("close", 1005, "");
            }
        });
        socket.on("timeout", () => this.emit("timeout"));

        this.#readyState = ReadyState.OPEN;
    }

    get readyState(){
        return this.#readyState;
    }

    #handleData(data:Buffer){

        let offset = 0;
        // let framePart = this.#framePart;
        // console.log("data:",data);
        let byte = data[offset];

        while(byte != null){

            switch(this.#framePart){
                case FramePart.FIN_AND_OPCODE:

                    const {isFinished, opcode} = parseFinAndOpcode(byte);

                    this.#isFinished = isFinished;
                    console.log("isFinished:", isFinished);
                    switch(opcode){
                        case Opcode.CLOSE:
                            if(this.#readyState === ReadyState.OPEN){
                                //"recieved close frame"
                                this.#readyState = ReadyState.CLOSING;
                            }else if(this.#readyState === ReadyState.CLOSING){
                                //"recieved close frame response"
                                this.#readyState = ReadyState.CLOSED;
                            }
                        case Opcode.PING:
                        case Opcode.PONG:
                        case Opcode.TEXT:
                        case Opcode.BINARY:
                            this.#opcode = opcode;
                            break;
                        case Opcode.CONTINUATION:
                            break;
                        default:
                            this.close(1008);
                            return;
                    }

                    this.#setNextFramePart(FramePart.MASK_AND_PAYLOAD_LENGTH);
                    // framePart = FramePart.MASK_AND_PAYLOAD_LENGTH;

                    break;
                case FramePart.MASK_AND_PAYLOAD_LENGTH:
                    const {isMasked, payloadLength, extendedPayloadLengthSize} = parseMaskAndPayloadLength(byte);
                    this.#isMasked = isMasked;
                    this.#payloadLength = BigInt(payloadLength);
                    this.#extendedPayloadLengthSize = extendedPayloadLengthSize;
                    // this.#bufferedSize = 0;

                    //send close frame when payload length exceeded max control frame payload size
                    if(this.#opcode != null && isControlFrame(this.#opcode) && this.#payloadLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
                        this.close(1009);
                        return;
                    }
                    console.log("isMasked:", isMasked);
                    console.log("payloadLength:", this.#payloadLength);
                    console.log("extended payload length size:", extendedPayloadLengthSize);
                    if(this.#extendedPayloadLengthSize > 0){
                        this.#setNextFramePart(FramePart.EXTENDED_PAYLOAD_LENGTH);
                        // framePart = FramePart.EXTENDED_PAYLOAD_LENGTH;
                    }else {
                        this.#payload = Buffer.allocUnsafe(Number(this.#payloadLength));
                        if(this.#isMasked){
                            this.#setNextFramePart(FramePart.MASKING_KEY);
                            // framePart = FramePart.MASKING_KEY;
                        }else{
                            this.#setNextFramePart(FramePart.PAYLOAD);
                            // framePart = FramePart.PAYLOAD;
                            //process 0 length payload or control frame
                        }
                    }
                    break;
                case FramePart.EXTENDED_PAYLOAD_LENGTH:
                    if(this.#bufferedSize < this.#extendedPayloadLengthSize){ 
                        this.#extendedPayloadLengthBuffer[this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                    }

                    if(this.#bufferedSize === this.#extendedPayloadLengthSize){

                        if(this.#extendedPayloadLengthSize === 2){
                            this.#payloadLength = BigInt(this.#extendedPayloadLengthBuffer.readUInt16BE(0));
                        }else {
                            //length of extendedPayloadLengthBuffer is 8
                            const extendedPayloadLength = this.#extendedPayloadLengthBuffer.readBigUInt64BE(0);
                            // if(!Number.isSafeInteger(extendedPayloadLength)){
                            //     this.close(1009, "Frame payload size should be less than or equal to" + Number.MAX_SAFE_INTEGER);
                            //     return;
                            // }
                            this.#payloadLength = extendedPayloadLength;
                        }
                        //TO DO make sure bigInt payloadLength could be safely transformed
                        this.#payload = Buffer.allocUnsafe(Number(this.#payloadLength));
                        // framePart = this.#isMasked ? FramePart.MASKING_KEY:FramePart.PAYLOAD;
                        this.#setNextFramePart(this.#isMasked ? FramePart.MASKING_KEY:FramePart.PAYLOAD);
                    }

                    break;
                case FramePart.MASKING_KEY:
                    if(this.#bufferedSize < MASKING_KEY_SIZE){
                        this.#maskingKey[this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                    }
                    
                    if(this.#bufferedSize === MASKING_KEY_SIZE){
                        // framePart = FramePart.PAYLOAD;
                        this.#setNextFramePart(FramePart.PAYLOAD);

                        console.log("maskingKey:", this.#maskingKey);
                        //process 0 length payload or control frame
                    }

                    break;
                case FramePart.PAYLOAD:
                    //keep buffering when payload is not enough
                    if(this.#bufferedSize < this.#payloadLength){
       
                        //unmask payload
                        if(this.#isMasked){
                            byte = byte ^ this.#maskingKey[this.#bufferedSize % this.#maskingKey.byteLength];
                        }

                        this.#payload![this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                        // this.#messageSize++;                       
                    }

                    break;
            }

            //a frame is completely proccessed
            if(this.#framePart === FramePart.PAYLOAD && BigInt(this.#bufferedSize) === this.#payloadLength){
                this.finishFrame();
                this.#setNextFramePart(FramePart.FIN_AND_OPCODE);
                // framePart = FramePart.FIN_AND_OPCODE;
            }

            // this.#framePart = framePart;
            offset++;
            byte = data[offset];
        }

        //take a break to do other tasks
        //TO FIX maybe better
        this.#socket.pause();
        setImmediate(() => this.#socket.resume());
    }

    // #getNextMaskingKey(){
    //     return this.#maskingKey[this.#bufferedSize%this.#maskingKey.length];
    // }

    #setNextFramePart(framePart:FramePart){
        this.#framePart = framePart;
        this.#bufferedSize = 0;
    }

    protected finishFrame(){
        console.log("finish frame");
        switch(this.#opcode){
            case Opcode.PING:
                this.pong(this.#payload);
                break;
            case Opcode.PONG:
                this.emit("pong");
                break;
            case Opcode.CLOSE:
                if(this.#readyState === ReadyState.CLOSING){//close frame
                    if(this.#payload && this.#payload.byteLength >= CLOSE_FRAME_CODE_SIZE){
                        const code = this.#payload.readUInt16BE(0);
                        const reason = this.#payload.toString("utf-8", CLOSE_FRAME_CODE_SIZE);
                        this.close(code, reason);
                    }else{
                        console.log("here");
                        this.close();
                    }
                }else if(this.#readyState === ReadyState.CLOSED){//response close frame
                    this.#socket.destroy();
                }
                break;
            case Opcode.TEXT:
            case Opcode.BINARY:
                this.emit("message", {
                    data:this.#payload, 
                    opcode:this.#opcode, 
                });
                // this.#messageSize = 0;
                break;
        }
    }

    send(data:Buffer|string){
        return new Promise<void>((resolve, reject) => {
            if(this.#readyState !== ReadyState.OPEN){
                reject(new Error("Cannot send data when readyState is not OPEN"));
                return;
            }

            let opcode:Opcode.TEXT|Opcode.BINARY = Opcode.TEXT;
            if(Buffer.isBuffer(data)){
                opcode = Opcode.BINARY;
            }

            const frame = createFrame({payloadData:Buffer.from(data), opcode});
            this.#socket.write(frame, (err) => {
                if(err){
                    reject(err);
                }else{
                    resolve();
                }
            });
        });
    }

    close(code?:number, reason?:string){
        if(this.#readyState !== ReadyState.OPEN && this.#readyState !== ReadyState.CLOSING){
            return;
        }

        const socket = this.#socket;
        let reasonByteLength = 0;
        if(code != null && reason != null){
            reasonByteLength = Buffer.byteLength(reason);
            if(reasonByteLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE){
                this.emit("error", new Error(
                    "close websocket fail, "+
                    "length of reason is "+ reasonByteLength +" bytes, "+
                    "it must be less than "+(MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE)+" bytes"
                ));
                return;
            }
        }
        const payload:Buffer = Buffer.alloc(CLOSE_FRAME_CODE_SIZE + reasonByteLength);

        if(code != null){
            payload.writeUInt16BE(code, 0);
        }
        if(reason != null){
            payload.write(reason, CLOSE_FRAME_CODE_SIZE);
        }

        const frame = createFrame({payloadData:payload, opcode:Opcode.CLOSE});

        //hasn't recieved close frame from endpoint and send close frame
        //if not receiving close frame response for a period of time then closing the socket anyway
        if(this.#readyState === ReadyState.OPEN){
            socket.write(frame, (err) => {
                this.#readyState = ReadyState.CLOSING;
                setTimeout(() => {
                    if(this.#readyState !== ReadyState.CLOSED){
                        socket.destroy(err);
                        console.log("timeout close");
                    }else{
                        console.log("has close");
                    }
                }, this.#closeTimeout);
            });
        }else{
        //has recieved close frame from endpoint, sending close frame response and directly closing socket
            socket.write(frame, (err) => {
                this.#readyState = ReadyState.CLOSED;
                socket.destroy(err);
            });
        }
    }

    setTimeout(millieseconds:number){
        this.#socket.setTimeout(millieseconds);
    }

    ping(){
        if(this.#readyState !== ReadyState.OPEN){
            return;
        }

        const frame = createFrame({opcode:Opcode.PING});
        this.#socket.write(frame);
    }

    protected pong(payload?:Buffer){
        if(this.#readyState !== ReadyState.OPEN && this.#opcode !== Opcode.PING){
            return;
        }

        let frame:Buffer; 
        if(payload != null){
            frame = createFrame({payloadData:payload, opcode:Opcode.PONG});
        }else{
            frame = createFrame({opcode:Opcode.PONG});
        }
        this.#socket.write(frame);
    }
}

export default WebSocket;


type Frame = {
    fin:boolean;
    rsv:[boolean,boolean,boolean];
    opcode:Opcode;
    payloadData:Buffer;
}
//TO DO piplable
export class WebSocket2 extends EventEmitter{

    #socket:Socket;
    #maxMessageSize:number;
    #messageSize:number;
    #frames:Frame[];
    #subprotocol:string;
    #type:Opcode.BINARY | Opcode.TEXT;

    #readyState:ReadyState;

    #isFinished:boolean;
    #rsv:[boolean, boolean, boolean];
    #opcode:number;
    #isMasked:boolean;
    #payloadLength:number;
    #extendedPayloadLength:Buffer;
    #extendedPayloadLengthSize:ExtendedPayloadLengthSize;
    #maskingKey:Buffer;
    #payloadData:Buffer;
    
    #bufferedSize:number;
    #framePart:number = FramePart.FIN_AND_OPCODE;

    constructor(key:string, version:string, socket:Socket, {maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE, closeTimeout = DEFAULT_CLOSE_TIMEOUT, subprotocols = []}:WebSocketOptions & {subprotocols?:string[]} = {}){
        super();
        this.#socket = socket;

        if(!(maxMessageSize >= MAX_CONTROL_FRAME_PAYLOAD_SIZE && maxMessageSize <= buffer.constants.MAX_LENGTH)){
            throw new RangeError(
                "Max message size should be greater than or equal to "+MAX_CONTROL_FRAME_PAYLOAD_SIZE+
                " and less than or equal to "+buffer.constants.MAX_LENGTH
            );
        }

        this.#subprotocol = "";

        this.#readyState = ReadyState.CONNECTING;
        this.#finishOpeningHandshake(key, version, (err) => {
            if(err){
                this.#readyState = ReadyState.CLOSED;
                this.emit("error");
            }else{
                this.#readyState = ReadyState.OPEN;
                this.emit("open");
            }
        });


        this.#isFinished = true;
        this.#rsv = [false, false, false];
        this.#opcode = Opcode.CLOSE;
        this.#isMasked = false;
        this.#payloadLength = 0;
        this.#extendedPayloadLengthSize = 0;
        this.#extendedPayloadLength = Buffer.alloc(MAX_EXTENDED_PAYLOAD_LENGTH_SIZE);
        this.#maskingKey = Buffer.alloc(MASKING_KEY_SIZE);
        this.#payloadData = Buffer.alloc(0);
        this.#bufferedSize = 0;

        this.#frames = [];
        this.#type = Opcode.TEXT;
        this.#messageSize = 0;
        this.#maxMessageSize = maxMessageSize;
        this.on("message", () => {
            this.#maxMessageSize = 0;
        });

        socket.on("data", this.#handleData.bind(this));
        socket.on("error", (err) => this.emit("error", err));
        socket.on("close", () => {
            if(this.#readyState !== ReadyState.CLOSED){
                this.emit("close", 1006, "");
            }else if(this.#payloadData.byteLength >= CLOSE_FRAME_CODE_SIZE){
                const code = this.#payloadData.readUInt16BE(0);
                const reason =this.#payloadData.toString("utf-8", CLOSE_FRAME_CODE_SIZE);
                this.emit("close", code, reason);
            }else{
                this.emit("close", 1005, "");
            }
        });
        socket.on("timeout", () => this.emit("timeout"));

    }

    get readyState(){
        return this.#readyState;
    }

    #finishOpeningHandshake(key:string, version:string, callback?:(err?:Error) => void){

        if(version !== PROTOCOL_VERSION){
            const openingHandshakeResponse = parseHeaders(426, "Upgrade Required", {
                "connection":"upgrade",
                "upgrade":"websocket",
                "sec-websocket-version":PROTOCOL_VERSION
            });

            this.#socket.write(openingHandshakeResponse, (error) => {
                this.#socket.destroy(error);
                if(callback){
                    callback(new Error("Websocket socket version "+version+"is not supported"));
                }
            });
        }else{

            const webSocketAccept = createHash("sha1").update(key + MAGIC_STRING).digest("base64");
            const openingHandshakeResponse = parseHeaders(101, "Switching Protocols", {
                "connection": "upgrade",
                "upgrade": "websocket",
                "sec-websocket-accept":webSocketAccept
            });

            // console.log({handshakeResponse});
            this.#socket.write(openingHandshakeResponse, (error) => {
                if(error){
                    this.#socket.destroy(error);
                }
                
                if(callback){
                    callback(error && new Error("Websocket socket opening failed"));
                }
            });
        }
        
    }

    #handleData(data:Buffer){
  
        // console.log("data:",data);
        for(let byte of data){
            switch(this.#framePart){
                case FramePart.FIN_AND_OPCODE:

                    const {isFinished, opcode, rsv} = parseFinAndOpcode(byte);
                    this.#isFinished = isFinished;
                    this.#rsv = rsv;
                    this.#opcode = opcode;

                    console.log("isFinished:", isFinished);
                    switch(this.#opcode){
                        case Opcode.TEXT:
                            this.#type = Opcode.TEXT;
                            break;
                        case Opcode.BINARY:
                            this.#type = Opcode.BINARY;
                            break;
                        case Opcode.CONTINUATION:
                            break;
                        case Opcode.CLOSE:
                            console.log("close frame", this.#readyState);
                            if(this.#readyState === ReadyState.OPEN){
                                //"recieved close frame"
                                this.#readyState = ReadyState.CLOSING;
                            }else if(this.#readyState === ReadyState.CLOSING){
                                //"recieved close frame response"
                                console.log("recieved close response frame");
                                this.#readyState = ReadyState.CLOSED;
                            }
                        case Opcode.PING:
                        case Opcode.PONG:
                            break;
                        default:
                            this.close(1008);
                            return;
                    }

                    //control frame should not be fragmented
                    if(isControlFrame(this.#opcode) && !this.#isFinished){
                        this.close(1009);
                        return;
                    }

                    this.#setFramePart(FramePart.MASK_AND_PAYLOAD_LENGTH);

                    break;
                case FramePart.MASK_AND_PAYLOAD_LENGTH:
                    const {isMasked, payloadLength, extendedPayloadLengthSize} = parseMaskAndPayloadLength(byte);
                    this.#isMasked = isMasked;
                    this.#extendedPayloadLengthSize = extendedPayloadLengthSize;
                    this.#setPayloadLength(payloadLength);

                    //exceed max control frame payload data size
                    if(isControlFrame(this.#opcode) && this.#payloadLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
                        this.close(1009);
                        return;
                    }
                    console.log("isMasked:", isMasked);
                    console.log("payloadLength:", this.#payloadLength);
                    console.log("extended payloadData length size:", extendedPayloadLengthSize);
                    if(this.#extendedPayloadLengthSize > 0){
                        this.#setFramePart(FramePart.EXTENDED_PAYLOAD_LENGTH);
                    }else {

                        if(this.#isMasked){
                            this.#setFramePart(FramePart.MASKING_KEY);
                        }else if(this.#payloadLength > 0){
                            this.#setFramePart(FramePart.PAYLOAD);
                            //process 0 length payloadData or control frame
                        }else{
                            this.#finishFrame();
                            this.#setFramePart(FramePart.FIN_AND_OPCODE);
                        }
                    }
                    break;
                case FramePart.EXTENDED_PAYLOAD_LENGTH:
                    if(this.#bufferedSize < this.#extendedPayloadLengthSize){ 
                        this.#extendedPayloadLength[this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                    }

                    if(this.#bufferedSize === this.#extendedPayloadLengthSize){

                        if(this.#extendedPayloadLengthSize === 2){
                            this.#setPayloadLength(this.#extendedPayloadLength.readUInt16BE(0))
                        }else{
                            //size of extendedPayloadLength is 8
                            this.#setPayloadLength(this.#extendedPayloadLength.readBigUInt64BE(0))
                        }

                        if(this.#isMasked){
                            this.#setFramePart(FramePart.MASKING_KEY);
                        }else if(this.#payloadLength > 0){
                            this.#setFramePart(FramePart.PAYLOAD);
                            //process 0 length payloadData or control frame
                        }else{
                            this.#finishFrame();
                            this.#setFramePart(FramePart.FIN_AND_OPCODE);
                        }
                    }

                    break;
                case FramePart.MASKING_KEY:
                    if(this.#bufferedSize < MASKING_KEY_SIZE){
                        this.#maskingKey[this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                    }
                    
                    if(this.#bufferedSize === MASKING_KEY_SIZE){
                        console.log("maskingKey:", this.#maskingKey);

                        if(this.#payloadLength > 0){
                            this.#setFramePart(FramePart.PAYLOAD);
                            //process 0 length payloadData or control frame
                        }else{
                            this.#finishFrame();
                            this.#setFramePart(FramePart.FIN_AND_OPCODE);
                        }
                    }

                    break;
                case FramePart.PAYLOAD:
                    if(this.#bufferedSize < this.#payloadLength){
                        //unmask payloadData
                        if(this.#isMasked){
                            byte = byte ^ this.#maskingKey[this.#bufferedSize % this.#maskingKey.byteLength];
                        }
    
                        this.#payloadData[this.#bufferedSize] = byte;
                        this.#bufferedSize++;                     
                    }
                    
                    if(this.#bufferedSize === this.#payloadLength){
                        this.#finishFrame();
                        this.#setFramePart(FramePart.FIN_AND_OPCODE);
                    }
                    break;
            }
            
        }

        this.#socket.pause();
        setImmediate(() => this.#socket.resume());
    }

    #finishFrame(){
        switch(this.#opcode){
            case Opcode.PING:
                // this.pong(this.#payloadData);
                this.emit("ping", this.#payloadData);
                break;
            case Opcode.PONG:
                this.emit("pong", this.#payloadData);
                break;
            case Opcode.CLOSE:
                if(this.#readyState === ReadyState.CLOSING){//close frame
                    if(this.#payloadData.byteLength >= 2){
                        const code = this.#payloadData.readUInt16BE(0);
                        const reason = this.#payloadData.toString("utf-8", CLOSE_FRAME_CODE_SIZE);
                        this.close(code, reason);
                    }else{
                        console.log("here");
                        this.close();
                    }
                }else if(this.#readyState === ReadyState.CLOSED){//close response frame
                    this.#socket.destroy();
                }
                console.log("close handshake finished");
                break;
            case Opcode.CONTINUATION:
            case Opcode.TEXT:
            case Opcode.BINARY:
                this.#frames.push({
                    fin:this.#isFinished,
                    rsv:this.#rsv,
                    opcode:this.#opcode,
                    payloadData:this.#payloadData
                });

                if(this.#isFinished){
                    console.log("amount of frame:",this.#frames.length);
                    let start = performance.now();
                    this.emit("message", {
                        data:Buffer.concat(this.#frames.map((frame:Frame) => frame.payloadData)), 
                        type:this.#type, 
                    });
                    this.#frames = [];
                    console.log(performance.now()-start,"ms");
                }
                break;
        }
    }

    #setFramePart(framePart:FramePart){
        this.#framePart = framePart;
        this.#bufferedSize = 0;
    }

    #setPayloadLength(payloadLength:bigint|number){
        if(payloadLength < 0 || payloadLength > buffer.constants.MAX_LENGTH || !Number.isSafeInteger(payloadLength)){
            //throw range error
        }

        this.#payloadLength = Number(payloadLength);
        this.#payloadData = Buffer.allocUnsafe(this.#payloadLength);
    }

    send(data:Buffer|string){
        return new Promise<void>((resolve, reject) => {
            if(this.#readyState !== ReadyState.OPEN){
                reject(new Error("Cannot send data when readyState is not OPEN"));
                return;
            }

            let opcode:Opcode.TEXT|Opcode.BINARY = Opcode.TEXT;
            if(Buffer.isBuffer(data)){
                opcode = Opcode.BINARY;
            }

            const frame = createFrame({payloadData:Buffer.from(data), opcode});
            this.#socket.write(frame, (err) => {
                if(err){
                    reject(err);
                }else{
                    resolve();
                }
            });
        });
    }

    close(code?:number, reason?:string){
        if(this.#readyState !== ReadyState.OPEN && this.#readyState !== ReadyState.CLOSING){
            return;
        }

        let reasonByteLength = 0;
        if(code != null && reason != null){
            reasonByteLength = Buffer.byteLength(reason);
            if(reasonByteLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE){
                this.emit("error", new Error(
                    "close websocket fail, "+
                    "length of reason is "+ reasonByteLength +" bytes, "+
                    "it must be less than "+(MAX_CONTROL_FRAME_PAYLOAD_SIZE - CLOSE_FRAME_CODE_SIZE)+" bytes"
                ));
                return;
            }
        }
        const payloadData:Buffer = Buffer.alloc(CLOSE_FRAME_CODE_SIZE + reasonByteLength);

        if(code != null){
            payloadData.writeUInt16BE(code, 0);
        }
        if(reason != null){
            payloadData.write(reason, CLOSE_FRAME_CODE_SIZE);
        }

        const frame = createFrame({payloadData, opcode:Opcode.CLOSE});

        //hasn't recieved close frame from endpoint and send close frame
        if(this.#readyState === ReadyState.OPEN){
            this.#readyState = ReadyState.CLOSING;
            this.#socket.end(frame, () => {
                console.log("send close frame");

                setTimeout(() => {
                    if(this.#readyState !== ReadyState.CLOSED){
                        this.#readyState = ReadyState.CLOSED;
                        this.#socket.destroy(new Error("close timeout"));
                    }else{
                        console.log("has closed");
                    }
                }, 5000);
            });
        }else{
        //has recieved close frame from endpoint, sending close frame response and directly closing socket
            this.#readyState = ReadyState.CLOSED;
            this.#socket.end(frame, () => {
                console.log("send close response frame");
                this.#socket.destroy();
            });
        }

    }

    ping(payloadData?:Buffer){
        if(this.#readyState !== ReadyState.OPEN){
            this.emit("error", new Error("cannot send ping frame when ready state is not OPEN"));
            return;
        }

        let frame:Buffer; 
        if(payloadData != null){
            frame = createFrame({payloadData, opcode:Opcode.PONG});
        }else{
            frame = createFrame({opcode:Opcode.PONG});
        }
        this.#socket.write(frame);
    }

    pong(payloadData?:Buffer){
        if(this.#readyState !== ReadyState.OPEN && this.#opcode !== Opcode.PING){
            this.emit("error", new Error("cannot send pong frame before recieved ping frame or after closing state"));
            return;
        }

        let frame:Buffer; 
        if(payloadData != null){
            frame = createFrame({payloadData, opcode:Opcode.PONG});
        }else{
            frame = createFrame({opcode:Opcode.PONG});
        }
        this.#socket.write(frame);
    }
}