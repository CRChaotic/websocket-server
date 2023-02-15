import type { Socket } from "net";
import type { IncomingMessage } from "http";
import EventEmitter from "events";

import { createServer, Server } from "https";
import type { Authorizer } from "./Authorizer.js";
import parseHeaders from "./utils/parseHeaders.js";
import WebSocket from "./WebSocket.js";

export type WebSocketServerOptions = {
    port:number;
    key:Buffer;
    cert:Buffer;
    allowOrigin?:string[];
    path?:string;
    maxConnections?:number;
    authorizer?:Authorizer;
    maxMessageSize?:number;
    handleSubprotocols?:(subprotocols:string[]) => string;
};

declare interface WebSocketServer{
    on(event: "listening", listener: () => void): this;
    on(event: "connection", listener: (websocket: WebSocket) => void): this;
    on(event: string, listener: Function): this;
}

class WebSocketServer extends EventEmitter{

    readonly connections:Set<WebSocket>;
    readonly maxConnections:number|undefined;
    #server:Server;
    path:string;
    allowOrigin:string[]|undefined;
    authorizer:WebSocketServerOptions["authorizer"];
    handleSubprotocols:(subprotocols:string[]) => string;

    constructor({port, key, cert, allowOrigin, path = "/", maxConnections, maxMessageSize = 1024**2*100, authorizer, handleSubprotocols}:WebSocketServerOptions){
        super();
        this.connections = new Set();
        this.path = path;
        this.authorizer = authorizer;
        this.allowOrigin = allowOrigin;
        this.maxConnections = maxConnections;
        this.handleSubprotocols = handleSubprotocols??(() => "");

        this.#server = createServer({key, cert});
        this.#server.listen(port);
        this.#server.addListener("error", (err) => this.emit("error", err));
        this.#server.addListener("listening", () => this.emit("listening"));

        this.#server.addListener("upgrade", (req, socket) => {
            if(this.maxConnections != null && this.connections.size === this.maxConnections){
                socket.write(parseHeaders(503, "Service Unavailable"), () => socket.destroy());
                return;
            }
            const webSocketKey = req.headers["sec-websocket-key"];
            const webSocketVersion = req.headers["sec-websocket-version"];
            const isValidUpgradeProtocol = req.headers["upgrade"]?.split(",").includes("websocket");
            const webSocketSubprotocols = req.headers["sec-websocket-protocol"]?.split(",")??[];
            //check out if it is a valid websocket upgrade
            if(
                !isValidUpgradeProtocol || 
                webSocketVersion !== WebSocket.getVersion() ||
                webSocketKey == null
            ){
                let headers:{[k:string]:string} = {
                    connection:"upgrade",
                    upgrade:"websocket"
                };
                if(webSocketVersion !== WebSocket.getVersion()){
                    headers["sec-websocket-version"] = WebSocket.getVersion();
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
            const subprotocol = this.handleSubprotocols(webSocketSubprotocols);
            const webSocket = new WebSocket(webSocketKey, socket, {maxMessageSize, subprotocol});
            webSocket.on("open", () => {
                this.connections.add(webSocket);
                console.log("[INFO] add new websocket, rest of all:", this.connections.size);
            });
            webSocket.on("close", () => {
                this.connections.delete(webSocket);
                console.log("[INFO] remove webosocket, rest of all:", this.connections.size);
            });
            this.emit("connection", webSocket); 
        });
    }

    protected handleUpdrade(req:IncomingMessage, socket:Socket){

        
    }

}

export default WebSocketServer;