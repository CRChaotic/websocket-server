import { constants } from "buffer";
import { Transform, TransformCallback } from "stream";
import type { Frame, Header } from "./Frame.js";
import isControlFrame from "./utils/isControlFrame.js";
import parseFinAndOpcode2 from "./utils/parseFinAndOpcode.js";
import parseMaskAndPayloadLength from "./utils/parseMaskAnyPayloadLength.js";
import { StatusCode } from "./utils/StatusCode.js";
import WebSocketError from "./WebSocketError.js";

enum FramePart {
    FIN_AND_OPCODE = 0,
    MASK_AND_PAYLOAD_LENGTH = 1,
    EXTENDED_PAYLOAD_LENGTH = 2,
    MASKING_KEY = 3,
    PAYLOAD = 4,
}
const MAX_CONTROL_FRAME_PAYLOAD_SIZE = 125;

type ReceiverOptions = {
    mustBeMasked?:boolean;
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

    #isFinished = true;
    #rsv:[boolean, boolean, boolean] = [false, false, false];
    #opcode:number = 0;
    #isMasked = false;
    #maskingKey = Buffer.alloc(4);
    #extendedPayloadLengthSize = 0;
    #payloadLength = 0;
    #payload:Buffer|null = null;

    constructor(options:ReceiverOptions = {}){
        super({readableObjectMode:true});

        this.#mustBeMasked = options.mustBeMasked??true;
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
                        this.destroy(new WebSocketError(StatusCode.PROTOCOL_ERROR, "Control frame must not be fragmented"));
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
                        this.destroy(new WebSocketError(
                            StatusCode.PROTOCOL_ERROR,
                            "Exceeded max control frame payload size "+MAX_CONTROL_FRAME_PAYLOAD_SIZE
                        ));
                        return;
                    }
                    if(this.#mustBeMasked && !this.#isMasked){
                        this.destroy(new Error("Frame must be masked"));
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
                    this.emit("header", {
                        isFinished:this.#isFinished,
                        rsv:this.#rsv,
                        opcode:this.#opcode,
                        isMasked:this.#isMasked,
                        payloadLength:this.#payloadLength
                    });
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
                            if(this.#extendedPayloadLength.readBigUInt64BE(0) > constants.MAX_LENGTH){
                                this.destroy(new WebSocketError(StatusCode.MESSAGE_TOO_LARGE, "Exceeded max payload size"));
                                return;
                            }

                            this.#payloadLength = Number(this.#extendedPayloadLength.readBigUInt64BE(0));
                        }

                        if(this.#isMasked){
                            this.#framePart = FramePart.MASKING_KEY;
                            break;
                        }

                        this.#framePart = FramePart.PAYLOAD;
                        this.emit("header", {
                            isFinished:this.#isFinished,
                            rsv:this.#rsv,
                            opcode:this.#opcode,
                            isMasked:this.#isMasked,
                            payloadLength:this.#payloadLength
                        });
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
                        this.emit("header", {
                            isFinished:this.#isFinished,
                            rsv:this.#rsv,
                            opcode:this.#opcode,
                            isMasked:this.#isMasked,
                            payloadLength:this.#payloadLength
                        });

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
                        this.#bufferedSize = 0;
                        this.#framePart = FramePart.FIN_AND_OPCODE;
                        this.push({
                            isFinished:this.#isFinished,
                            rsv:this.#rsv,
                            opcode:this.#opcode,
                            isMasked:this.#isMasked,
                            payloadLength:this.#payloadLength,
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