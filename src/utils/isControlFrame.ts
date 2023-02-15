
function isControlFrame(opcode:number) {
    return opcode >= 0x07 && opcode <= 0x0f;
}

export default isControlFrame;