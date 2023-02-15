class WebSocketError extends Error{

    readonly code:number;

    constructor(code:number, reason?:string){
        super(reason);
        this.code = code;
    }

    get reason(){
        return this.message;
    }
}

export default WebSocketError;