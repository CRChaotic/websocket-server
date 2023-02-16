import { constants } from "buffer";
import { Readable, Transform, TransformCallback } from "stream";
import type { Frame, Header } from "./Frame.js";
import { Code, isReservedCode } from "./utils/Code.js";
import isControlFrame from "./utils/isControlFrame.js";
import Opcode from "./utils/Opcode.js";
import parseFinAndOpcode2 from "./utils/parseFinAndOpcode.js";
import parseMaskAndPayloadLength from "./utils/parseMaskAnyPayloadLength.js";

import WebSocketError from "./WebSocketError.js";

enum FramePart {
    FIN_AND_OPCODE = 0,
    MASK_AND_PAYLOAD_LENGTH = 1,
    EXTENDED_PAYLOAD_LENGTH = 2,
    MASKING_KEY = 3,
    PAYLOAD = 4,
}
const MAX_CONTROL_FRAME_PAYLOAD_SIZE = 125;
const DEFAULT_MAX_FRAME_SIZE = 1024**2;

type ReceiverOptions = {
    mustBeMasked?:boolean;
    maxFrameSize?:number;
}

declare interface Receiver{
    on(event: "header", listener: (header:Header) => void): this;
    on(event: "data", listener:(frame:Frame) => void): this;
    on(event: "error", listener:(error:WebSocketError) => void): this;
    on(event: "close", listener:() => void): this;
    on(event: string, listener: Function): this;
}

class Receiver extends Transform{

    #mustBeMasked:boolean;

    #framePart = FramePart.FIN_AND_OPCODE;
    #extendedPayloadLength = Buffer.alloc(8);
    #bufferedSize = 0;
    #maxFrameSize:number;

    #isFinished = true;
    #rsv:[boolean, boolean, boolean] = [false, false, false];
    #opcode:number = 0;
    #isMasked = false;
    #maskingKey = Buffer.alloc(4);
    #extendedPayloadLengthSize = 0;
    #payloadLength = 0;
    #payload:Buffer|null = null;

    constructor({mustBeMasked = true, maxFrameSize = DEFAULT_MAX_FRAME_SIZE}:ReceiverOptions = {}){
        super({readableObjectMode:true});
        if(maxFrameSize < MAX_CONTROL_FRAME_PAYLOAD_SIZE || maxFrameSize > constants.MAX_LENGTH){
            throw new Error(`Max frame size must be between ${MAX_CONTROL_FRAME_PAYLOAD_SIZE} and ${constants.MAX_LENGTH} bytes`);
        }
        this.#mustBeMasked = mustBeMasked;
        //Max frame size is 1MB
        this.#maxFrameSize = maxFrameSize;
    }

    override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {

        let byte = 0;
        let offset = 0;

        while(offset < chunk.byteLength){
            byte = chunk[offset];

            switch(this.#framePart){
                case FramePart.FIN_AND_OPCODE:
                    const {isFinished, rsv, opcode} = parseFinAndOpcode2(byte);
                    this.#isFinished = isFinished;
                    this.#rsv = rsv;
                    this.#opcode = opcode;
                    // console.log("isFinished:", this.#isFinished);
                    if(isControlFrame(this.#opcode) && !this.#isFinished){
                        callback(new WebSocketError(Code.PROTOCOL_ERROR, "Control frame must not be fragmented"));
                        return;
                    }

                    this.#framePart = FramePart.MASK_AND_PAYLOAD_LENGTH;
                    break;
                case FramePart.MASK_AND_PAYLOAD_LENGTH:
                    const {isMasked, payloadLength, extendedPayloadLengthSize} = parseMaskAndPayloadLength(byte);
                    this.#isMasked = isMasked;
                    this.#payloadLength = payloadLength;
                    this.#extendedPayloadLengthSize = extendedPayloadLengthSize;

                    if(isControlFrame(this.#opcode) && this.#payloadLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
                        callback(new WebSocketError(
                            Code.PROTOCOL_ERROR,
                            "Control frame payload size exceeds "+MAX_CONTROL_FRAME_PAYLOAD_SIZE
                        ));
                        return;
                    }
                    if(this.#mustBeMasked && !this.#isMasked){
                        callback(new Error("Frame must be masked"));
                        return;
                    }

                    // console.log("isMasked:", this.#isMasked);
                    // console.log("payloadLength:", this.#payloadLength);
                    // console.log("extended payload length size:", this.#extendedPayloadLengthSize);

                    if(this.#extendedPayloadLengthSize > 0){
                        this.#framePart = FramePart.EXTENDED_PAYLOAD_LENGTH;
                        break;
                    }
                    if(this.#isMasked){
                        this.#framePart = FramePart.MASKING_KEY;
                        break;
                    }

                    this.#framePart = FramePart.PAYLOAD;
                    if(this.#payloadLength === 0){
                        continue;
                    }
                    
                    break;
                case FramePart.EXTENDED_PAYLOAD_LENGTH:
                    if(this.#bufferedSize < this.#extendedPayloadLengthSize){ 
                        this.#extendedPayloadLength[this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                    }

                    if(this.#bufferedSize === this.#extendedPayloadLengthSize){
                        this.#bufferedSize = 0;

                        if(this.#extendedPayloadLengthSize === 2){
                            this.#payloadLength = this.#extendedPayloadLength.readUInt16BE(0);
                        }else if(this.#extendedPayloadLengthSize === 8){
                            if(this.#extendedPayloadLength.readBigUInt64BE(0) > this.#maxFrameSize){
                                callback(new WebSocketError(Code.TOO_LARGE, "Frame payload exceeds max limit size"));
                                return;
                            }

                            this.#payloadLength = Number(this.#extendedPayloadLength.readBigUInt64BE(0));
                        }

                        if(this.#isMasked){
                            this.#framePart = FramePart.MASKING_KEY;
                            break;
                        }

                        this.#framePart = FramePart.PAYLOAD;
                        if(this.#payloadLength === 0){
                            continue;
                        }
                    }

                    break;
                case FramePart.MASKING_KEY:
                    if(this.#bufferedSize < this.#maskingKey.byteLength){
                        this.#maskingKey[this.#bufferedSize] = byte;
                        this.#bufferedSize++;
                    }
                    
                    if(this.#bufferedSize === this.#maskingKey.byteLength){
                        this.#bufferedSize = 0;

                        // console.log("maskingKey:", this.#maskingKey);
                        this.#framePart = FramePart.PAYLOAD;
                        if(this.#payloadLength === 0){
                            continue;
                        }
                    }

                    break;

                case FramePart.PAYLOAD:
                    if(this.#payload === null){
                        this.#payload = Buffer.allocUnsafe(this.#payloadLength);
                    }

                    if(this.#bufferedSize < this.#payloadLength){
                        //unmask payload
                        if(this.#isMasked){
                            byte = byte ^ this.#maskingKey[this.#bufferedSize % this.#maskingKey.byteLength];
                        }
    
                        this.#payload[this.#bufferedSize] = byte;
                        this.#bufferedSize++;                     
                    }

                    if(this.#bufferedSize === this.#payloadLength){

                        if(this.#opcode === Opcode.CLOSE && this.#payload.byteLength > 0){
                            if(this.#payload.byteLength === 1){
                                callback(new WebSocketError(Code.PROTOCOL_ERROR, "Close frame payload data is wrong"));
                                return;
                            }
                            
                            const code = this.#payload.readUIntBE(0, 2);
                            if(isReservedCode(code)){
                                callback(new WebSocketError(Code.PROTOCOL_ERROR, "Close frame is containing a reserved code"));
                                return;
                            }
                        }

                        this.#bufferedSize = 0;
                        this.#framePart = FramePart.FIN_AND_OPCODE;
                        this.push({
                            isFinished:this.#isFinished,
                            rsv:this.#rsv,
                            opcode:this.#opcode,
                            isMasked:this.#isMasked,
                            payload:this.#payload
                        });
                        this.#payload = null;
                        this.#payloadLength = 0;

                    }
                    break;
            }

            offset++;
        }

        callback();
    }

}

export default Receiver;