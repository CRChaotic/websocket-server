class WebSocketError extends Error{

    readonly code:number;
    readonly reason:string;

    constructor(code:number, reason:string){
        super(reason);
        this.code = code;
        this.reason = reason;
    }

}

export default WebSocketError;