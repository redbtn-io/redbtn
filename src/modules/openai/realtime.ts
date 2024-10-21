import EventEmitter from "events";
import WebSocket from "ws";

const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";

export default class RealtimeAI {
    private ws: WebSocket;
    private _onMessage: any;
    private _onOpen: any;
    private listeners: { [eventName: string]: Function[] } = {};

    constructor({onMessage, onOpen} : any) {
        this.ws = new WebSocket(url, {
            headers: {
                "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
                "OpenAI-Beta": "realtime=v1",
            },
        });
        const ws = this.ws;
        const updateSession = this.updateSession
        const emit = this.emit
        const listeners = this.listeners

        if (onMessage)
            this._onMessage = onMessage
        else 
            this._onMessage = (message: string) =>{ }

        if (onOpen)
            this._onOpen = onOpen
        else
            this._onOpen = () => console.log("Connection opened")

        onMessage = this._onMessage
        onOpen = this._onOpen

        ws.on("open", function open() {
            if (onOpen)
            onOpen()
        });

        ws.on("error", function error(err) {
            emit(listeners,"error", err)
        });

        ws.on("close", function close() {
            emit(listeners,"close")
        });

        ws.on("message", function incoming(response: any) {
            
            const message = JSON.parse(response.toString())
            switch (message.type) {
                case "session.created": {
                    updateSession({
                        instructions: "Your name is Red. You are speaking with George. Respond naturally as you would in a podcast conversation, but don't be too overly-excited.",
                        modalities: ["text"],
                        voice: "shimmer"
                    }, ws)
                    break;
                }
                case "session.updated": {
                    
                    break;
                }
                case "response.done": {
                    if (onMessage)
                        onMessage(message.response.output[0].content[0].text)
                    emit(listeners,"response", message.response.output[0].content[0].text)
                    break;
                }
                case "conversation.item.created": {
                    if (message.item.role === "user") 
                        ws.send(JSON.stringify({
                            type: "response.create"
                        }))
                    break;
                }
                case "response.text.delta": {
    
                    break;
                }
                default: {
                    
                    break;
                }
            }
        });

    }

    send(message: string) {
        this.ws.send(JSON.stringify({
            type: "conversation.item.create",
            previous_item_id: null,
            item: {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": message
                    }
                ]
            }
        }));
    }

    createResponse() {
        this.ws.send(JSON.stringify({
            type: "response.create"
        }))
    }

    updateSession( session: any, ws?: WebSocket) {
        ws = ws || this.ws
        ws.send(JSON.stringify({
            type: "session.update",
            session
        }))
    }

    set onMessage(fn: Function) {
        this._onMessage = fn
        const ws = this.ws
        const updateSession = this.updateSession
        const onMessage = this._onMessage
        const emit = this.emit
        const listeners = this.listeners
        ws.removeAllListeners("message")
        ws.on("message", function incoming(response: any) {
            
            const message = JSON.parse(response.toString())
            switch (message.type) {
                case "session.created": {
                    updateSession({
                        instructions: "Your name is Red. You are speaking with George. Respond naturally as you would in a podcast conversation, but don't be too overly-excited.",
                        modalities: ["text"],
                        voice: "shimmer"
                    }, ws)
                    break;
                }
                case "session.updated": {
                    
                    break;
                }
                case "response.done": {
                    if (onMessage)
                        onMessage(message.response.output[0].content[0].text)
                    emit(listeners,"response", message.response.output[0].content[0].text)
                    break;
                }
                case "conversation.item.created": {
                    if (message.item.role === "user") 
                        ws.send(JSON.stringify({
                            type: "response.create"
                        }))
                    break;
                }
                case "response.text.delta": {
                    emit(listeners,"delta", message.delta.text)
                    break;
                }
                default: {
                    
                    break;
                }
            }
        });
    }

    set onOpen(fn: Function) {
        this._onOpen = fn
        const ws = this.ws
        const onOpen = this._onOpen
        ws.removeAllListeners("open")
        ws.on("open", function open() {
            if (onOpen)
            onOpen()
        });
    }

    on(eventName:string, listener: Function) {
        if (!this.listeners[eventName]) {
          this.listeners[eventName] = [];
        }
        this.listeners[eventName].push(listener);
    }

    private emit( listeners: { [eventName: string]: Function[] }, eventName: string, ...args: any[]) {
        if (listeners[eventName]) {
            listeners[eventName].forEach((listener) => listener(...args));
        }
    }

}