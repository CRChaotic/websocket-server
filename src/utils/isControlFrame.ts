import Opcode from "./Opcode.js";

type ControlOpcode =
| Opcode.CLOSE 
| Opcode.PING 
| Opcode.PONG

const CONTROL_FRAME_OPCODE:Opcode[] = [Opcode.CLOSE, Opcode.PING, Opcode.PONG];

function isControlFrame(opcode:number):opcode is ControlOpcode {
    return CONTROL_FRAME_OPCODE.includes(opcode);
}

export default isControlFrame;