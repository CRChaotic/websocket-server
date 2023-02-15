import { randomInt } from "crypto";
import { Transform, TransformCallback } from "stream";
import type { Frame } from "./Frame.js";
import isControlFrame from "./utils/isControlFrame.js";

declare interface Sender extends Transform{
    write(frame:Omit<Frame, "payloadLength">, callback?:(err?:Error|null) => void):boolean;
    write(frame:Omit<Frame, "payloadLength">, encoding?:string, callback?:(err?:Error|null) => void):boolean;
    end(frame:Omit<Frame, "payloadLength">, callback?:() => void): this;
    end(callback?:() => void): this;
    on(event: "data", listener:(frame:Frame) => void): this;
    on(event: "error", listener:(error:Error) => void): this;
    on(event: "close", listener:() => void): this;
    on(event: string, listener: Function): this;
}

const MAX_CONTROL_FRAME_PAYLOAD_SIZE = 125;

class Sender extends Transform{

    constructor(){
        super({writableObjectMode:true, allowHalfOpen:false});
    }

    override _transform(
        {isFinished, rsv, opcode, isMasked, payload}: Omit<Frame, "payloadLength">, 
        encoding: BufferEncoding, 
        callback: TransformCallback
    ): void {
        if(isControlFrame(opcode)){
            if(!isFinished){
                callback(new Error("Control frame must not be fragmented"));
                return;
            }else if(payload.byteLength > MAX_CONTROL_FRAME_PAYLOAD_SIZE){
                callback(new Error("Control frame payload size must not exceed "+MAX_CONTROL_FRAME_PAYLOAD_SIZE));
                return;
            }
        }

        let payloadSize = payload.byteLength;
        // if(payload){
        //     payloadSize = payload.byteLength;
        // }
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

        const header:Buffer = Buffer.alloc(headerSize);

        if(isFinished){
            header[offset] |= 0b10000000;
        }
        if(rsv[0]){
            header[offset] |= 0b01000000;
        }
        if(rsv[1]){
            header[offset] |= 0b00100000;
        }
        if(rsv[2]){
            header[offset] |= 0b00010000;
        }
        header[offset] |= opcode;
        offset += 1;
   
        if(isMasked){
            header[offset] |= 0b10000000;
        }
        header[offset] |= payloadLength;
        offset += 1;

        if(payloadLength === 127){
            header.writeBigUint64BE(BigInt(payloadSize), offset);
            offset += 8;
        }else if(payloadLength === 126){
            header.writeUInt16BE(payloadSize, offset);
            offset += 2;
        }

        const maskingKey:Buffer = Buffer.from([randomInt(255), randomInt(255), randomInt(255), randomInt(255)]);
        if(isMasked){
            for(let key of maskingKey){
                header[offset] = key;
                offset++;
            }
            payload.forEach((value:number, index:number) => {
                payload[index] = maskingKey[index % 4] ^ value;
            });
        }

        this.push(header);
        this.push(payload);
        // this.push(Buffer.concat([header, payload]));
        callback();
    }

}

export default Sender;