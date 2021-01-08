import { EventEmitter } from "events";
import { URL } from "url";
import Axios, { AxiosInstance } from "axios";
import Faye from "faye";

export class Client extends EventEmitter {
    private static API_BASE = "https://api.groupme.com/v3";
    private faye = new Faye.Client("https://push.groupme.com/faye", { timeout: 120 });

    private token: string;
    public api: AxiosInstance;
    public fileApi: AxiosInstance;
    public imageApi: AxiosInstance;

    constructor(token) {
        super();

        this.token = token;
        // Add access token to outgoing subscriptions
        this.faye.addExtension({
            outgoing: (message, callback) => {
                if (message.channel === "/meta/subscribe") {
                    callback({
                        ...message,
                        ext: {
                            "access_token": token,
                            "timestamp": Math.round(new Date().getTime() / 1000)
                        }
                    })
                } else {
                    callback(message)
                }
            }
        });

        this.api = Axios.create({
            baseURL: "https://api.groupme.com/v3",
            headers: { "X-Access-Token": token }
        });
        this.fileApi = Axios.create({
            baseURL: "https://file.groupme.com/v1",
            headers: { "X-Access-Token": token }
        });
        this.imageApi = Axios.create({
            baseURL: "https://image.groupme.com",
            headers: { "X-Access-Token": token }
        });
    }

    async start() {
        const userId = (await this.api.get("/users/me")).data.response.user_id;
        await this.faye.subscribe(`/user/${userId}`, message => this.emit("message", message));
    }

    async stop() {
        await this.faye.disconnect();
    }
}
