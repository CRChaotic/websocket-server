import { randomInt } from "crypto";
import type Opcode from "./Opcode.js";


type CreateFrameOptions = {
    isFinished?:boolean;
    rsv1?:boolean;
    rsv2?:boolean;
    rsv3?:boolean;
    opcode:Opcode;
    isMasked?:boolean;
    payloadData?:Buffer; 
}

function createFrame({isFinished = true, rsv1, rsv2, rsv3, opcode, isMasked = false, payloadData}:CreateFrameOptions):Buffer{

    let payloadSize = 0;
    if(payloadData){
        payloadSize = payloadData.byteLength;
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

    const frame:Buffer = Buffer.alloc(headerSize + payloadSize);

    if(isFinished){
        frame[offset] |= 0b10000000;
    }
    if(rsv1){
        frame[offset] |= 0b01000000;
    }
    if(rsv2){
        frame[offset] |= 0b00100000;
    }
    if(rsv3){
        frame[offset] |= 0b00010000;
    }
    frame[offset] |= opcode;
    offset += 1;

    if(isMasked){
        frame[offset] |= 0b10000000;
    }
    frame[offset] |= payloadLength;
    offset += 1;

    if(payloadLength === 127){
        frame.writeBigUint64BE(BigInt(payloadSize), offset);
        offset += 8;
    }else if(payloadLength === 126){
        frame.writeUInt16BE(payloadSize, offset);
        offset += 2;
    }

    const maskingKey:number[] = [];
    if(isMasked){
        let aKey;
        while(maskingKey.length < 4){
            aKey = randomInt(255);
            maskingKey.push(aKey);
            frame[offset] = aKey;
            offset++;
        }
    }

    payloadData?.forEach((value:number, index:number) => {
        if(maskingKey.length === 4){
            frame[offset + index] = maskingKey[index % 4] ^ value;
        }else{
            frame[offset + index] = value;
        }
    });

    return frame;
}

export default createFrame;