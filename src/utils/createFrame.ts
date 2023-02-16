import type { Frame } from "../Frame.js";

type CreateFrameOptions = {
    isFinished?:boolean;
    rsv?:[boolean, boolean, boolean];
    opcode:number;
    isMasked?:boolean;
    payload?:Buffer; 
}

function createFrame({isFinished = true, rsv = [false, false, false], opcode, isMasked = false, payload = Buffer.alloc(0)}:CreateFrameOptions):Frame{
    const frame:Frame = {
        isFinished,
        rsv,
        opcode,
        isMasked,
        payloadLength:payload.byteLength,
        payload
    };
    return frame;
}

export default createFrame;