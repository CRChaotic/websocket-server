import { randomInt } from "crypto";
import { readFileSync } from "fs";
import { Writable } from "stream";
import createFrame from "./utils/createFrame.js";
import Opcode from "./utils/Opcode.js";

import { ReadyState } from "./WebSocket.js";
import WebSocketServer from "./WebSocketServer.js";

const wsServer = new WebSocketServer({
    port:8081,
    key:readFileSync("./private/localhost.key"), 
    cert:readFileSync("./private/localhost.crt"),
});

wsServer.on("listening", () => {
    console.log("[INFO] Websocket server is listening");
});

wsServer.on("connection", (ws) => {
    console.log("new websocket connection, remain connections:", wsServer.connections.size);
    // ws.setTimeout(10000);

    let pong = true;
    ws.on("pong", () =>{
        pong = true;
        console.log("recieved pong");
    });

    // ws.on("timeout", () => {
    //     ws.ping();
    //     setTimeout(() => {
    //         if(!pong){
    //             ws.close();
    //         }else{
    //             pong = false;
    //         }
    //     }, 5000);
    // });

    ws.on("open", () => {
        console.log("open websocket");
    })

    ws.on("message", ({data, type}) => {
        console.log("type:"+type);
        // console.log("message:", data.toString("utf-8"));
        if(data.toString() === "!close"){
            ws.close(1000, "bye");
            // return;
        }
        //broadcasting
        wsServer.connections.forEach(async (websocket) => {
            if(websocket.readyState !== ReadyState.OPEN){
                return;
            }
            if(type === Opcode.TEXT){
                try{
                    await websocket.send(data.toString("utf-8"));
                }catch(err){
                    console.log(err);
                }
            }else if(type === Opcode.BINARY){
                try{
                    await websocket.send(data);
                }catch(err){
                    console.log(err);
                }
            }
        })
    });
    ws.on("close", (code, reason) => {
        console.log("ws closed", "code:"+code , "reason:"+reason," remain connections:", wsServer.connections.size);
    });
    ws.on("error", (err) => {
        console.log(err);
    });
});

// console.log(createFrame({opCode:Opcode.TEXT, isMasked:true, payload:Buffer.from([0x00])}));
