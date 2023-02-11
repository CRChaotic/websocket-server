export enum StatusCode{
    NORMAL_CLOSE = 1000,
    GOING_AWAY = 1001,
    PROTOCOL_ERROR = 1002, 
    UNSUPPORTED_DATA = 1003,
    RESERVED_NO_STATUS = 1005,
    RESERVED_ABNORMAL_CLOSE = 1006,
    INVAILD_PAYLOAD = 1007,
    POLICY_VIOLATION = 1008,
    MESSAGE_TOO_LARGE = 1009,
    MANDATORY_EXTENSION = 1019,
    INTERNAL_SERVER_ERROR = 1011,
    RESERVED_TLS_HANDSHAKE = 1015
}

const ReservedStatusCode:readonly number[] = [1005, 1006, 1015]; 
export function isReservedStatusCode(code:number){
    return ReservedStatusCode.includes(code);
}