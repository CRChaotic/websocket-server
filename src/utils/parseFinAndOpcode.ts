import Opcode from "./Opcode.js";

function parseFinAndOpcode(byte:number){

    const isFinished = (byte & 0b10000000) === 128;
    const rsv1 = byte & 0b01000000;
    const rsv2 = byte & 0b00100000;
    const rsv3 = byte & 0b00010000;
    const rawOpCode = byte & 0b00001111;
    let opCode:Opcode|null;

    switch(rawOpCode){
        case Opcode.TEXT:  
        case Opcode.BINARY:
        case Opcode.CONTINUATION:
        case Opcode.CLOSE:
        case Opcode.PING:
        case Opcode.PONG:
            opCode = rawOpCode;
            break;
        default:
            opCode = null;
    }

    return Object.freeze({isFinished, rsv1, rsv2, rsv3, opCode});
}

export default parseFinAndOpcode2;

function parseFinAndOpcode2(byte:number){

    const isFinished = (byte & 0b10000000) === 128;
    const rsv1 = (byte & 0b01000000) !== 0;
    const rsv2 = (byte & 0b00100000) !== 0;
    const rsv3 = (byte & 0b00010000) !== 0;
    const rsv:[boolean, boolean, boolean] = [rsv1, rsv2, rsv3];
    const opcode = byte & 0b00001111;

    return Object.freeze({isFinished, rsv, opcode});
}
