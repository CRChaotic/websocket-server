import { readFileSync } from "fs";
import { State } from "./WebSocket.js";


import WebSocketServer from "./WebSocketServer.js";

const wsServer = new WebSocketServer({
    port:8081,
    key:readFileSync("./private/localhost.key"), 
    cert:readFileSync("./private/localhost.crt"),
    maxMessageSize:1024**2*100,
    handleSubprotocols(subprotocols) {
        return "";
    },
});

wsServer.on("listening", () => {
    console.log("[INFO] Websocket server is listening");
});

wsServer.on("connection", (ws) => {
    console.log("new websocket connection, remain connections:", wsServer.connections.size);

    ws.on("pong", (payload) =>{
        console.log("recieved pong",payload?.toString());
    });

    ws.on("open", () => {
        console.log("open websocket");
        ws.ping();
    })

    ws.on("message",(message, type) => {

        if(message.toString("utf-8") === "!close"){
            ws.close(1000, "bye");
            return;
        }

        //broadcasting
        let i = 0;
        let start = performance.now();
        wsServer.connections.forEach((websocket) => {
            if(websocket.state !== State.OPEN){
                return;
            }

            websocket.send(message, type)
            .then(() => {
                i++;
                if(i === wsServer.connections.size){
                    console.log("size:",message.byteLength/1024**2, "MB", " broadcasting time:", performance.now()-start);
                }
            }).catch(console.error);
         
        });
    });
    ws.on("close", (code, reason) => {
        console.log("ws closed", "code:"+code , "reason:"+reason," remain connections:", wsServer.connections.size);
    });
    ws.on("error", (err) => {
         console.log("[ERROR] ",err);
    });

});