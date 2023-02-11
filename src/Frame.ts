import type Opcode from "./utils/Opcode.js";

export type Frame = {
    isFinished:boolean;
    rsv:[boolean, boolean, boolean];
    opcode:Opcode;
    isMasked:boolean;
    payloadLength:number
    payload:Buffer;
}

export type Header = {
    isFinished:boolean;
    rsv:[boolean, boolean, boolean];
    opcode:Opcode;
    isMasked:boolean;
    payloadLength:number
}

