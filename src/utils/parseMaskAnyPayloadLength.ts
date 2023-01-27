import type { ExtendedPayloadLengthSize } from "./ExtendedPayloadLengthSize.js";

function parseMaskAndPayloadLength(byte:number){

    const isMasked = (byte & 0b10000000) === 128;
    const payloadLength =  byte & 0b01111111;
    let extendedPayloadLengthSize:ExtendedPayloadLengthSize = 0;

    if(payloadLength === 127){
        extendedPayloadLengthSize = 8;
    }else if(payloadLength === 126){
        extendedPayloadLengthSize = 2;
    }

    return {isMasked, payloadLength, extendedPayloadLengthSize};
}

export default parseMaskAndPayloadLength;