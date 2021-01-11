import { EventEmitter } from "events";
import { URL } from "url";
import Axios, { AxiosInstance } from "axios";
import Faye from "faye";
import { Log } from "mx-puppet-bridge";

const log = new Log("GroupMePuppet:client");

export class Client extends EventEmitter {
    private static API_BASE = "https://api.groupme.com/v3";
    private faye = new Faye.Client("https://push.groupme.com/faye", { timeout: 120 });

    private dmListeners: Set<string> = new Set();
    private refreshDmsTimer: NodeJS.Timeout;

    private token: string;
    private userId: string;

    public api: AxiosInstance;
    public oldApi: AxiosInstance;
    public fileApi: AxiosInstance;
    public imageApi: AxiosInstance;
    public videoApi: AxiosInstance;

    constructor(token: string) {
        super();

        this.token = token;
        // Add access token to outgoing subscriptions
        this.faye.addExtension({
            outgoing: (message: any, callback: (message: any) => any) => {
                if (
                    message.channel === "/meta/subscribe" ||
                    message.channel.startsWith("/group/") ||
                    message.channel.startsWith("/direct_message/")
                ) {
                    callback({
                        ...message,
                        ext: { "access_token": token }
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
        this.oldApi = Axios.create({
            baseURL: "https://v2.groupme.com",
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
        this.videoApi = Axios.create({
            baseURL: "https://video.groupme.com",
            headers: { "X-Access-Token": token }
        });
    }

    private async listenAllGroups() {
        const groupIds = (await this.api.get("/groups", {
            params: {
                per_page: "500",
                omit: "memberships"
            }
        })).data.response.map(group => group.id);

        await Promise.all(groupIds.map(groupId =>
            this.faye.subscribe(`/group/${groupId}`, (event: any) =>
                this.emit("channelEvent", groupId, event)
            )
        ));
    }

    private async listenAllDms() {
        const dmIds = (await this.api.get("/chats", {
            params: { per_page: "100" }
        })).data.response
            .map(dm => [this.userId, dm.other_user.id].sort().join("+"))
            // Only look for channels we're not already listening to
            .filter(dmId => !this.dmListeners.has(dmId));

        await Promise.all(dmIds.map(dmId =>
            this.faye.subscribe(`/direct_message/${dmId.replace(/\+/g, "_")}`, (event: any) =>
                this.emit("channelEvent", dmId, event)
            )
        ));

        // Mark these channels as having listeners
        dmIds.forEach(dmId => this.dmListeners.add(dmId));
    }

    async start() {
        this.userId = (await this.api.get("/users/me")).data.response.user_id;

        await Promise.all([
            this.faye.subscribe(`/user/${this.userId}`, message => this.emit("message", message)),
            this.listenAllGroups(),
            this.listenAllDms()
        ]);

        // Refresh the DM listeners each minute, since GroupMe
        // doesn't notify us of new DM channels
        const refreshDms = async () => {
            log.verbose("Refreshing DM listeners...");
            await this.listenAllDms();
        };
        this.refreshDmsTimer = setInterval(refreshDms, 60000);
    }

    async stop() {
        await this.faye.disconnect();
        clearInterval(this.refreshDmsTimer);
    }

    async listenGroup(groupId: string) {
        await this.faye.subscribe(`/group/${groupId}`, (event: any) =>
            this.emit("channelEvent", groupId, event)
        );
    }

    async publish(channel: string, data: any) {
        await this.faye.publish(channel, data);
    }
}
