import buffer from "buffer";
import Opcode from "./utils/Opcode.js";

class Frame {

    #fin:boolean;
    #rsv:[boolean,boolean,boolean];
    #opcode:Opcode;
    #masked:boolean;
    #payloadLength:number;
    #maskingKey:Buffer;
    #bufferedMaskingKeySize:number;
    #payloadData:Buffer;

    #extendedPayloadLength:Buffer|null;
    #bufferedExtendedPayloadLengthSize:number;

    constructor(){
        this.#fin = true;
        this.#rsv = [false, false, false];
        this.#opcode = Opcode.CONTINUATION;
        this.#masked = false;
        this.#payloadLength = -1;
        this.#extendedPayloadLength = null;
        this.#bufferedExtendedPayloadLengthSize = 0;
        this.#maskingKey = Buffer.alloc(4);
        this.#bufferedMaskingKeySize = 0;
        this.#payloadData = Buffer.alloc(0);
    }

    set fin(fin:boolean){
        this.#fin = fin;
    }

    get fin(){
        return this.#fin;
    }

    set rsv(rsv:[boolean,boolean,boolean]){
        this.#rsv = rsv;
    }

    get rsv(){
        return this.#rsv;
    }

    set opcode(opcode:Opcode){
        this.#opcode = opcode;
    }

    get opcode(){
        return this.#opcode;
    }

    set masked(masked:boolean){
        this.#masked = masked;
        if(masked){
            this.#maskingKey.fill(0);
        }
    }

    get masked(){
        return this.#masked;
    }

    set payloadLength(payloadLength:bigint|number){
        if(payloadLength < 0 || payloadLength > buffer.constants.MAX_LENGTH || !Number.isSafeInteger(payloadLength)){
            //throw error
        }

        this.#payloadLength = Number(payloadLength);
        this.#payloadData = Buffer.allocUnsafe(Number(this.#payloadLength));
    }


    bufferPayloadLength(byte:number){

        if(this.#payloadLength === -1){
            if(byte === 127){
                this.#extendedPayloadLength = Buffer.alloc(8);
            }else if(byte === 126){
                this.#extendedPayloadLength = Buffer.alloc(2);
            }else{
                this.#payloadLength = byte;
            }
        }
        
        if(this.#extendedPayloadLength){

            if(this.#bufferedExtendedPayloadLengthSize < this.#extendedPayloadLength.byteLength){
                this.#extendedPayloadLength[this.#bufferedExtendedPayloadLengthSize] = byte;
                this.#bufferedExtendedPayloadLengthSize++;
            }
            
            if(this.#bufferedExtendedPayloadLengthSize === this.#extendedPayloadLength.byteLength){
                if(this.#extendedPayloadLength.byteLength === 2){
                    this.#payloadLength = this.#extendedPayloadLength.readUInt16BE(0);
                }else if(this.#extendedPayloadLength.byteLength === 8){
                    const payloadLength = this.#extendedPayloadLength.readBigUInt64BE(0);
                    if(payloadLength > buffer.constants.MAX_LENGTH || !Number.isSafeInteger(payloadLength)){
                        //throw too large error
                    }
                    this.#payloadLength = Number(payloadLength);
                }
            }

        }

        return this.#payloadLength !== -1;
    }
    
    get payloadLength(){
        return this.#payloadLength;
    }

    bufferMaskingKey(byte:number){
        if(this.#bufferedMaskingKeySize < this.#maskingKey.byteLength){
            this.#maskingKey[this.#bufferedMaskingKeySize] = byte;
            this.#bufferedMaskingKeySize++;
        }

        return this.#bufferedMaskingKeySize === this.#maskingKey.byteLength;
    }

    get maskingKey(){
        return this.#maskingKey;
    }
}
