import { readFileSync } from "fs";
import { State } from "./WebSocket.js";


import WebSocketServer from "./WebSocketServer.js";

const wsServer = new WebSocketServer({
    port:8081,
    key:readFileSync("./private/localhost.key"), 
    cert:readFileSync("./private/localhost.crt"),
    handleSubprotocols(subprotocols) {
        console.log("subprotocols:", subprotocols);
        if(subprotocols.length === 0){
            return "";
        }else{
            return "soap";
        }
    },
});

wsServer.on("listening", () => {
    console.log("[INFO] Websocket server is listening");
});

wsServer.on("connection", (ws) => {
    console.log("new websocket connection, remain connections:", wsServer.connections.size);

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
        ws.ping();
    })

    ws.on("message", async (message, type) => {

        // if(message.toString("utf-8") === "!close"){
        //     ws.close(1000, "bye");
        //     return;
        // }

        //broadcasting
        wsServer.connections.forEach(async (websocket) => {
            if(websocket.state !== State.OPEN){
                return;
            }

            try{
                await websocket.send(message, type);
            }catch(err){
                console.log(err);
            }

        });
    });
    ws.on("close", (code, reason) => {
        console.log("ws closed", "code:"+code , "reason:"+reason," remain connections:", wsServer.connections.size);
    });
    ws.on("error", (err) => {
         console.log("[ERROR] "+err);
    });

});


