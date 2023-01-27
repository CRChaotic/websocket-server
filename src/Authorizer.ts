import type { IncomingMessage } from "http";

export interface Authorizer {
    authenticate(request:IncomingMessage): boolean;
}
