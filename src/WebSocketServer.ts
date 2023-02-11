import type { Socket } from "net";
import type { IncomingMessage } from "http";
import EventEmitter from "events";

import { createServer, Server } from "https";
import type { Authorizer } from "./Authorizer.js";
import { createHash } from "crypto";
import parseHeaders from "./utils/parseHeaders.js";
import type WebSocket from "./WebSocket.js";

import Sender from "./Sender.js";
import Opcode from "./utils/Opcode.js";
import Receiver from "./Reciever.js";
import type { Frame } from "./Frame.js";
import { send } from "process";
import Websocket from "./WebSocket.js";

const MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const UPGRADE_PROTOCOL = "websocket";
const PROTOCOL_VERSION = "13";

export type WebSocketServerOptions = {
    port:number;
    key:Buffer;
    cert:Buffer;
    allowOrigin?:string[];
    path?:string;
    maxConnections?:number;
    authorizer?:Authorizer;
};

declare interface WebSocketServer{
    on(event: "listening", listener: () => void): this;
    on(event: "connection", listener: (websocket: WebSocket) => void): this;
    on(event: string, listener: Function): this;
}
//TO DO broadcasting
class WebSocketServer extends EventEmitter{

    readonly connections:Set<WebSocket>;
    readonly maxConnections:number|undefined;
    #server:Server;
    path:string;
    allowOrigin:string[]|undefined;
    authorizer:WebSocketServerOptions["authorizer"];

    constructor({port, key, cert, allowOrigin, path = "/", maxConnections, authorizer}:WebSocketServerOptions){
        super();
        this.connections = new Set();
        this.path = path;
        this.authorizer = authorizer;
        this.allowOrigin = allowOrigin;
        this.maxConnections = maxConnections;

        this.#server = createServer({key, cert});
        this.#server.listen(port);
        this.#server.addListener("error", (err) => this.emit("error", err));
        this.#server.addListener("listening", () => this.emit("listening"));
        this.#server.addListener("upgrade", this.handleUpdrade.bind(this));
    }

    protected handleUpdrade(req:IncomingMessage, socket:Socket){

        if(this.maxConnections != null && this.connections.size === this.maxConnections){
            socket.write(parseHeaders(503, "Service Unavailable"), () => socket.destroy());
            return;
        }
        // console.log(req.headers, req.httpVersion);
        const webSocketKey = req.headers["sec-websocket-key"];
        const webSocketVersion = req.headers["sec-websocket-version"];
        const isValidUpgradeProtocol = req.headers["upgrade"]?.split(",").includes(UPGRADE_PROTOCOL);
        const webSocketSubprotocols = req.headers["sec-websocket-protocol"]?.split(",")??[];
        //check out if it is a valid websocket upgrade
        if(
            !isValidUpgradeProtocol || 
            webSocketVersion !== PROTOCOL_VERSION ||
            webSocketKey == null
        ){
            let headers:{[k:string]:string} = {
                connection:"upgrade",
                upgrade:UPGRADE_PROTOCOL
            };
            if(webSocketVersion !== PROTOCOL_VERSION){
                headers["sec-websocket-version"] = PROTOCOL_VERSION;
            }

            socket.write(parseHeaders(426, "Upgrade Required", headers), () => socket.destroy());
            return;
        }

        const url = new URL(`https://localhost${req.url}`);
        const origin = req.headers["origin"];
        //check out if it is allowed origin and correct path, "*" means no need to check out origin
        if(
            url.pathname !== this.path ||
            origin == null ||
            (this.allowOrigin && !this.allowOrigin.includes(origin))
        ){
            const headers = parseHeaders(403, "Forbidden");
            socket.write(headers, () => socket.destroy());
            return;
        }
        //authenticate request if it needs
        if(this.authorizer && !this.authorizer.authenticate(req)){
            const headers = parseHeaders(401, "Unauthorized");
            // console.log({headers});
            socket.write(headers, () => socket.destroy());
            return;
        }
    
        const webSocket = new Websocket(webSocketKey, webSocketVersion, socket);
        webSocket.on("open", () => {
            this.connections.add(webSocket);
            console.log("[INFO] add new websocket, rest of all:", this.connections.size);
        });
        webSocket.on("close", () => {
            this.connections.delete(webSocket);
            console.log("[INFO] remove webosocket, rest of all:", this.connections.size);
        });

        this.emit("connection", webSocket); 
    }

}

export default WebSocketServer;