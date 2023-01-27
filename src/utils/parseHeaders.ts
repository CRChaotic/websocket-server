
function parseHeaders(statusCode:number, statusText:string, headers:{[k:string]:string|readonly string[]} = {}){

    let head = "HTTP/1.1" + " " +statusCode+ " "+ statusText + "\r\n";
    for(let [fieldName, fieldValue] of Object.entries(headers)){
        head += `${fieldName}:${ Array.isArray(fieldValue) ? fieldValue.join(";") : fieldValue }\r\n`;
    }
    head += "\r\n";
    
    return head;
}

export default parseHeaders;