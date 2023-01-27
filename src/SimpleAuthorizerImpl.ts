import { randomUUID } from "crypto";
import type { IncomingMessage } from "http";
import type { Authorizer } from "./Authorizer.js";

type SimpleAuthorizerOptions = {
    idAlias?:string;
}

class SimpleAuthorizerImpl implements Authorizer{

    #uuids:Set<string>;
    #idAlias;

    constructor({idAlias = "id"}:SimpleAuthorizerOptions = {}){
        this.#uuids = new Set();
        this.#idAlias = idAlias;
    }

    addId(){
        const uuid:string = randomUUID()
        this.#uuids.add(uuid);
        return uuid;
    }

    removeId(uuid:string){
        this.#uuids.delete(uuid);
    }

    authenticate(request: IncomingMessage): boolean {
        const url = new URL(`https://localhost${request.url}`);
        const uuid =  url.searchParams.get(this.#idAlias);
        if(uuid == null){
            return false;
        }else{
            return this.#uuids.has(uuid);
        }
    }
    
}

export default SimpleAuthorizerImpl;