import { randomInt } from "crypto";
import {  Transform, TransformCallback } from "stream";
import type { Frame } from "./Frame.js";
import isControlFrame from "./utils/isControlFrame.js";

declare interface Sender extends Transform{
    write(frame:Frame, callback?:(err?:Error|null) => void):boolean;
    write(frame:Frame, encoding?:string, callback?:(err?:Error|null) => void):boolean;
}

const MAX_CONTROL_FRAME_PAYLOAD_SIZE = 125;

class Sender extends Transform{

    constructor(){
        super({writableObjectMode:true});
    }

    override _transform({isFinished , rsv, opcode, isMasked, payload}: Frame, encoding: BufferEncoding, callback: TransformCallback): void {
        
        if(isControlFrame(opcode)){
            if(!isFinished){
                callback(new Error("Control frame must not be fragmented"));
                return;
            }else if(payload && payload.byteLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
                callback(new Error("Control frame payload size must not exceed "+MAX_CONTROL_FRAME_PAYLOAD_SIZE));
                return;
            }
        }

        let payloadSize = 0;
        if(payload){
            payloadSize = payload.byteLength;
        }
        let payloadLength = 0;
        let headerSize = 2;
        let offset = 0;

        if(payloadSize > 65535){
            payloadLength = 127;
            headerSize += 8;
        }else if(payloadSize > 125){
            payloadLength = 126;
            headerSize += 2;
        }else{
            payloadLength = payloadSize;
        }

        if(isMasked){
            headerSize += 4;
        }

        const frame:Buffer = Buffer.allocUnsafe(headerSize + payloadSize);
        //first byte need to be equal to clear up origin data because it is allocUnsafe
        if(isFinished){
            frame[offset] = 0b10000000;
        }

        if(rsv[0]){
            frame[offset] |= 0b01000000;
        }
        if(rsv[1]){
            frame[offset] |= 0b00100000;
        }
        if(rsv[2]){
            frame[offset] |= 0b00010000;
        }
        frame[offset] |= opcode;
        offset += 1;
        //same as first byte
        if(isMasked){
            frame[offset] = 0b10000000;
        }
        frame[offset] |= payloadLength;
        offset += 1;
        //rest of bytes would be all covered with new data
        if(payloadLength === 127){
            frame.writeBigUint64BE(BigInt(payloadSize), offset);
            offset += 8;
        }else if(payloadLength === 126){
            frame.writeUInt16BE(payloadSize, offset);
            offset += 2;
        }

        const maskingKey:Buffer = Buffer.from([randomInt(255), randomInt(255), randomInt(255), randomInt(255)]);
        if(isMasked){
            for(let key of maskingKey){
                frame[offset] = key;
                offset++;
            }
        }

        payload?.forEach((value:number, index:number) => {
            if(isMasked){
                frame[offset + index] = maskingKey[index % 4] ^ value;
            }else{
                frame[offset + index] = value;
            }
        });
        
        this.push(frame)
        callback();
    }

}

export default Sender;