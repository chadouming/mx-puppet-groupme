import fromEntries from "fromentries";
import Util from "util";
import { URL } from "url";
import FormData from "form-data";
import Axios from "axios";
import {
    Log,
    MessageDeduplicator,
    PuppetBridge,
    IRetList,
    IRemoteRoom,
    IMessageEvent,
    IFileEvent,
    ISendingUser,
    IReplyEvent,
    IRemoteUserRoomOverride,
    IReceiveParams,
    IRemoteUser,
    SendMessageFn
} from "mx-puppet-bridge";
import { Client } from "./client.js";

const log = new Log("GroupMePuppet:groupme");

interface IGroupMePuppet {
    client: Client;
    data: any;
}

interface IGroupMePuppets {
    [puppetId: number]: IGroupMePuppet;
}

export class GroupMe {
    private puppets: IGroupMePuppets = {};
    private deduper = new MessageDeduplicator();

    constructor(private puppet: PuppetBridge) { }

    async newPuppet(puppetId: number, data: any) {
        if (this.puppets[puppetId]) {
            // The puppet somehow already exists, delete it first
            await this.deletePuppet(puppetId);
        }

        this.puppets[puppetId] = {
            client: new Client(data.token),
            data
        };
        const p = this.puppets[puppetId];

        p.data.typingTimers = {};

        try {
            await p.client.start();

            const me = (await p.client.api.get("/users/me")).data.response;
            p.data.userId = me.user_id;
            p.data.username = me.name;

            await this.puppet.setPuppetData(puppetId, p.data);
            await this.puppet.setUserId(puppetId, p.data.userId);
            await this.puppet.sendStatusMessage(puppetId, "connected");

            p.client.on("message", async (message: any) => {
                try {
                    await this.handleGroupMeMessage.bind(this)(puppetId, message);
                } catch (err) {
                    log.error(`Failed to handle GroupMe message: ${err}`);
                }
            });
            p.client.on("channelEvent", async (roomId: string, event: any) => {
                try {
                    await this.handleGroupMeEvent.bind(this)(puppetId, roomId, event);
                } catch (err) {
                    log.error(`Failed to handle GroupMe event: ${err}`);
                }
            });
        } catch (err) {
            log.error(`Failed to start puppet ${puppetId}: ${err}`);
            await this.puppet.sendStatusMessage(puppetId, `Failed to connect: ${err}`);
        }
    }

    async deletePuppet(puppetId: number) {
        const p = this.puppets[puppetId];
        if (!p) return;

        await p.client.stop();
        delete this.puppets[puppetId];
    }

    async sendMessage(room: IRemoteRoom, eventId: string, data: any) {
        const p = this.puppets[room.puppetId];
        if (!p) return null;

        try {
            // Register message with deduplicator
            const key = `${room.puppetId};${room.roomId}`;
            this.deduper.unlock(key, p.data.userId, eventId);

            let res: any;
            if (room.roomId.includes("+")) {
                res = (await p.client.api.post("/direct_messages", {
                    direct_message: {
                        ...data,
                        source_guid: eventId,
                        recipient_id: room.roomId.split("+").find(userId => userId !== p.data.userId)
                    }
                })).data.response;
            } else {
                res = (await p.client.api.post(`/groups/${room.roomId}/messages`, {
                    message: {
                        ...data,
                        source_guid: eventId
                    }
                })).data.response;
            }

            // Register message with event store to track replies and likes
            this.puppet.eventSync.insert(
                room, eventId, res.direct_message ? res.direct_message.id : res.message.id
            );
        } catch (err) {
            log.warn(`Failed to send message to ${room.roomId}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to send message");
        }
    }

    async handleMatrixMessage(
        room: IRemoteRoom,
        data: IMessageEvent,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        await this.sendMessage(room, data.eventId!, {
            text: data.body
        });
    }

    async handleMatrixFile(
        room: IRemoteRoom,
        data: IFileEvent,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        try {
            const fileData = (await Axios.get(data.url, { responseType: "arraybuffer" })).data;
            const fileInfo: any = (await p.client.fileApi.post(`/${room.roomId}/files`, fileData, {
                params: { name: data.filename },
                maxBodyLength: Infinity
            })).data;
            const fileId: string = new URL(fileInfo.status_url).searchParams.get("job")!;

            while ((await p.client.fileApi.get(`/${room.roomId}/uploadStatus`, { params: { job: fileId } })).data.status !== "completed") {
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            await this.sendMessage(room, data.eventId!, {
                attachments: [{
                    type: "file",
                    file_id: fileId
                }]
            });
        } catch (err) {
            log.warn(`Failed to upload file ${data.mxc}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to upload file");
            return;
        }
    }

    async handleMatrixImage(
        room: IRemoteRoom,
        data: IFileEvent,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        try {
            const imageData = (await Axios.get(data.url, { responseType: "arraybuffer" })).data;
            const imageInfo: any = (await p.client.imageApi.post("/pictures", imageData, {
                headers: { "Content-Type": data.info!.mimetype }
            })).data;

            await this.sendMessage(room, data.eventId!, {
                attachments: [{
                    type: "image",
                    url: imageInfo.payload.url
                }]
            });
        } catch (err) {
            log.warn(`Failed to upload image ${data.mxc}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to upload image");
            return;
        }
    }

    async handleMatrixVideo(
        room: IRemoteRoom,
        data: IFileEvent,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        try {
            const videoData = (await Axios.get(data.url, { responseType: "arraybuffer" })).data;
            const form = new FormData();
            form.append("file", videoData);
            const videoInfo: any = (await p.client.videoApi.post("/transcode", form.getBuffer(), {
                headers: {
                    ...form.getHeaders(),
                    "X-Conversation-ID": room.roomId
                },
                maxBodyLength: Infinity
            })).data;
            const videoId: string = new URL(videoInfo.status_url).searchParams.get("job")!;

            let jobStatus = (await p.client.videoApi.get("/status", {
                params: { job: videoId }
            })).data;
            while (jobStatus.status !== "complete") {
                await new Promise(resolve => setTimeout(resolve, 500));
                jobStatus = (await p.client.videoApi.get("/status", {
                    params: { job: videoId }
                })).data;
            }

            await this.sendMessage(room, data.eventId!, {
                attachments: [{
                    type: "video",
                    url: jobStatus.url,
                    preview_url: jobStatus.thumbnail_url
                }]
            });
        } catch (err) {
            log.warn(`Failed to upload video ${data.mxc}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to upload video");
        }
    }

    async handleMatrixReaction(
        room: IRemoteRoom,
        eventId: string,
        reaction: string,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        if (reaction === "❤️") {
            try {
                await p.client.api.post(`/messages/${room.roomId}/${eventId}/like`);
            } catch (err) {
                log.warn(`Failed to like message ${eventId}: ${err}`);
                await this.puppet.sendStatusMessage(room, "Failed to like message");
            }
        } else {
            await this.sendMessage(room, event.eventId!, {
                text: reaction,
                attachments: [{
                    type: "reply",
                    reply_id: eventId,
                    base_reply_id: eventId
                }]
            });
        }
    }

    async handleMatrixRemoveReaction(
        room: IRemoteRoom,
        eventId: string,
        reaction: string,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        if (reaction === "❤️") {
            try {
                await p.client.api.post(`/messages/${room.roomId}/${eventId}/unlike`);
            } catch (err) {
                log.warn(`Failed to unlike message ${eventId}: ${err}`);
                await this.puppet.sendStatusMessage(room, "Failed to unlike message");
            }
        }
    }

    async handleMatrixReply(
        room: IRemoteRoom,
        eventId: string,
        data: IReplyEvent,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        await this.sendMessage(room, data.eventId!, {
            text: data.body.split("\n\n")[1],
            attachments: [{
                type: "reply",
                reply_id: eventId,
                base_reply_id: eventId
            }]
        });
    }

    async handleMatrixTyping(
        room: IRemoteRoom,
        typing: boolean,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        // Clear any previous typing notification
        if (p.data.typingTimers[room.roomId]) {
            clearInterval(p.data.typingTimers[room.roomId]);
            delete p.data.typingTimers[room.roomId];
        }

        if (typing) {
            const channel = room.roomId.includes("+") ?
                `/direct_message/${room.roomId.replace(/\+/g, "_")}` :
                `/group/${room.roomId}`;

            const sendTyping = async () => {
                try {
                    await p.client.publish(channel, {
                        type: "typing",
                        user_id: p.data.userId,
                        started: new Date().getTime()
                    });
                } catch (err) {
                    log.warn(`Failed to send typing event to ${room.roomId}: ${err}`);
                }
            };

            sendTyping();
            // GroupMe expects us to resend typing notifications every second
            p.data.typingTimers[room.roomId] = setInterval(sendTyping, 1000);
        }
    }

    async handleMatrixReadReceipt(
        room: IRemoteRoom,
        eventId: string,
        content: any,
        asUser: ISendingUser | null,
        event: any
    ) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        try {
            await p.client.oldApi.post("/read_receipts", {
                read_receipt: {
                    chat_id: room.roomId,
                    message_id: eventId
                }
            });
        } catch (err) {
            log.warn(`Failed to send read receipt to ${room.roomId}: ${err}`);
        }
    }

    async handleGroupMeMessage(puppetId: number, message: any) {
        const p = this.puppets[puppetId];
        if (!p) return;

        if (message.type !== "ping") {
            log.debug(`Got message: ${Util.inspect(message, { depth: null })}`);
        }

        // Deduplicate messages
        if (message.subject && message.subject.source_guid) {
            const key = `${puppetId};${message.subject.group_id || message.subject.chat_id}`;
            if (await this.deduper.dedupe(key, message.subject.user_id, message.subject.source_guid)) {
                log.debug("Deduping message, dropping...");
                return;
            }
        }

        switch (message.type) {
            case "direct_message.create":
            case "line.create": {
                if (message.subject.user_id === "system") {
                    switch (message.subject.event.type) {
                        case "membership.announce.added": {
                            await Promise.all(
                                message.subject.event.data.added_users.map(user =>
                                    this.puppet.addUser({
                                        room: {
                                            roomId: message.subject.group_id,
                                            puppetId
                                        },
                                        user: {
                                            userId: user.id.toString(),
                                            puppetId
                                        }
                                    })
                                )
                            );
                            break;
                        }
                        case "membership.notifications.exited": {
                            await this.puppet.removeUser({
                                room: {
                                    roomId: message.subject.group_id,
                                    puppetId
                                },
                                user: {
                                    userId: message.subject.event.data.removed_user.id.toString(),
                                    puppetId
                                }
                            });
                            break;
                        }
                        case "membership.nickname_changed": {
                            const roomOverrides: {[roomId: string]: IRemoteUserRoomOverride} = {};
                            roomOverrides[message.subject.group_id] = {
                                name: message.subject.event.data.name
                            };

                            await this.puppet.updateUser({
                                userId: message.subject.event.data.user.id.toString(),
                                puppetId,
                                roomOverrides
                            });
                            break;
                        }
                        case "membership.avatar_changed": {
                            const roomOverrides: {[roomId: string]: IRemoteUserRoomOverride} = {};
                            roomOverrides[message.subject.group_id] = {
                                avatarUrl: message.subject.event.data.avatar_url
                            };

                            await this.puppet.updateUser({
                                userId: message.subject.event.data.user.id.toString(),
                                puppetId,
                                roomOverrides
                            });
                            break;
                        }
                        case "group.name_change": {
                            await this.puppet.updateRoom({
                                roomId: message.subject.group_id,
                                puppetId,
                                name: message.subject.event.data.name
                            });
                            break;
                        }
                        case "group.avatar_change": {
                            await this.puppet.updateRoom({
                                roomId: message.subject.group_id,
                                puppetId,
                                avatarUrl: message.subject.event.data.avatar_url
                            });
                            break;
                        }
                        case "group.topic_change": {
                            await this.puppet.updateRoom({
                                roomId: message.subject.group_id,
                                puppetId,
                                topic: message.subject.event.data.topic
                            });
                            break;
                        }
                        default: {
                            await this.puppet.sendStatusMessage(
                                { roomId: message.subject.group_id, puppetId },
                                message.subject.text
                            );
                        }
                    }
                } else {
                    const sendParams: IReceiveParams = {
                        room: {
                            roomId: message.subject.group_id ?
                            message.subject.group_id :
                            message.subject.chat_id,
                            puppetId
                        },
                        user: {
                            userId: message.subject.user_id,
                            puppetId
                        },
                        eventId: message.subject.id
                    };

                    let replyId: string | null = null;
                    let isFile = false;
                    let isVideo = false;

                    await Promise.all(message.subject.attachments.map(async (attachment: any) => {
                        switch (attachment.type) {
                            case "file": {
                                isFile = true;

                                const fileInfo = (await p.client.fileApi.post(
                                    `/${sendParams.room.roomId}/fileData`,
                                    { file_ids: [ attachment.file_id ] }
                                )).data;
                                const fileBuffer = (await p.client.fileApi.get(
                                    `/${sendParams.room.roomId}/files/${attachment.file_id}`,
                                    { responseType: "arraybuffer" }
                                )).data;

                                await this.puppet.sendFile(
                                    sendParams,
                                    fileBuffer,
                                    fileInfo[0].file_data.file_name
                                );
                                break;
                            }
                            case "video": {
                                isVideo = true;
                                await this.puppet.sendVideo(sendParams, attachment.url);
                                break;
                            }
                            case "image": {
                                await this.puppet.sendImage(sendParams, attachment.url);
                                break;
                            }
                            case "reply": {
                                replyId = attachment.reply_id;
                            }
                        }
                    }));

                    let body: string | null = message.subject.text;

                    // Filter out "Shared a document" message
                    if (isFile) {
                        if (body!.startsWith("Shared a document: ")) {
                            body = null;
                        } else {
                            body = body!.replace(/ - Shared a document: \S+$/g, "");
                        }
                    }

                    // Filter out video URL
                    if (isVideo) {
                        if (body!.startsWith("https://v.groupme.com/")) {
                            body = null;
                        } else {
                            body = body!.replace(/ https:\/\/v\.groupme\.com\/\S+$/g, "");
                        }
                    }

                    if (body) {
                        if (replyId) {
                            await this.puppet.sendReply(sendParams, replyId, {
                                body,
                                eventId: message.subject.id
                            });
                        } else {
                            await this.puppet.sendMessage(sendParams, {
                                body,
                                eventId: message.subject.id
                            });
                        }
                    }
                }
                break;
            }
            case "like.create": {
                // We only process likes in DMs here, since in groups it's
                // more reliable to watch for `favorite` events instead
                if (message.subject.line) break;

                const sendParams: IReceiveParams = {
                    room: {
                        roomId: message.subject.direct_message.chat_id,
                        puppetId
                    },
                    user: {
                        userId: message.subject.user_id,
                        puppetId
                    }
                };

                await this.puppet.sendReaction(sendParams, message.subject.direct_message.id, "❤️");
                break;
            }
            case "membership.create": {
                await this.puppet.bridgeRoom({
                    roomId: message.subject.id,
                    puppetId
                });
                // Listen for group-specific events
                await p.client.listenGroup(message.subject.id);
            }
        }
    }

    // Handle events specific to a group, which include likes and typing notifications
    async handleGroupMeEvent(puppetId: number, roomId: string, event: any) {
        const p = this.puppets[puppetId];
        if (!p) return;

        log.debug(`Got event: ${Util.inspect(event, { depth: null })}`);

        switch (event.type) {
            case "favorite": {
                const sendParams: IReceiveParams = {
                    room: {
                        roomId,
                        puppetId
                    },
                    user: {
                        userId: event.subject.user_id,
                        puppetId
                    }
                };
                const messageId = event.subject.line.id;

                await this.puppet.sendReaction(sendParams, messageId, "❤️");
                break;
            }
            case "typing": {
                const sendParams: IReceiveParams = {
                    room: {
                        roomId,
                        puppetId
                    },
                    user: {
                        userId: event.user_id,
                        puppetId
                    }
                };

                await this.puppet.setUserTyping(sendParams, true);
                break;
            }
            case "read_receipt.create": {
                await this.puppet.sendReadReceipt({
                    room: {
                        roomId: event.subject.chat_id,
                        puppetId
                    },
                    user: {
                        userId: event.subject.user_id,
                        puppetId
                    },
                    eventId: event.subject.message_id
                });
            }
        }
    }

    async getUserIdsInRoom(room: IRemoteRoom): Promise<Set<string> | null> {
        const p = this.puppets[room.puppetId];
        if (!p) return null;

        if (room.roomId.includes("+")) {
            return new Set(room.roomId.split("+"));
        } else {
            try {
                const members = (await p.client.api.get(`/groups/${room.roomId}`)).data.response.members;
                return new Set(members.map(member => member.user_id));
            } catch (err) {
                log.error(`Failed to get users in ${room.roomId}: ${err}`);
                return null;
            }
        }
    }

    async createRoom(room: IRemoteRoom): Promise<IRemoteRoom | null> {
        const p = this.puppets[room.puppetId];
        if (!p) return null;

        if (room.roomId.includes("+")) {
            return {
                ...room,
                isDirect: true
            };
        } else {
            try {
                const group = (await p.client.api.get(`/groups/${room.roomId}`)).data.response;
                return {
                    ...room,
                    name: group.name,
                    topic: group.description,
                    avatarUrl: group.image_url,
                    isDirect: false
                };
            } catch (err) {
                log.warn(`Failed to get group info for ${room.roomId}: ${err}`);
                return null;
            }
        }
    }

    async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
        const p = this.puppets[user.puppetId];
        if (!p) return null;

        try {
            const [dms, groups] = await Promise.all([
                p.client.api.get("/chats", { params: { per_page: "100" } })
                    .then(async res => res.data.response),
                p.client.api.get("/groups", { params: { per_page: "500" } })
                    .then(async res => res.data.response)
            ]);

            let profile;
            // First try to get base profile from DMs
            const dm = dms.find(dm => dm.other_user.id === user.userId);
            if (dm) {
                profile = {
                    name: dm.other_user.name,
                    avatarUrl: dm.other_user.avatar_url
                };
            } else {
                const groupProfile = groups.flatMap(group => group.members)
                    .find(member => member.user_id === user.userId);
                if (groupProfile) {
                    profile = {
                        name: groupProfile.name,
                        avatarUrl: groupProfile.image_url
                    };
                }
            }

            const roomOverrides = fromEntries(
                groups.flatMap(group => {
                    const groupProfile = group.members.find(member => member.user_id === user.userId);

                    if (groupProfile &&
                        !(groupProfile.nickname === profile.name &&
                        groupProfile.image_url === profile.avatarUrl)) {
                        return [[group.group_id, {
                            name: groupProfile.nickname,
                            avatarUrl: groupProfile.image_url
                        }]];
                    } else {
                        return [];
                    }
                })
            );

            return {
                ...user,
                ...profile,
                roomOverrides
            };
        } catch (err) {
            log.error(`Failed to find profile for ${user.userId}: ${err}`);
            return null;
        }
    }

    async listUsers(puppetId: number): Promise<IRetList[]> {
        const p = this.puppets[puppetId];
        if (!p) return [];

        try {
            const list: IRetList[] = [];

            const groups = (await p.client.api.get("/groups", { params: { per_page: "500" } })).data.response;
            groups.forEach(group => {
                list.push({
                    category: true,
                    name: group.name
                });
                group.members.forEach(member =>
                    list.push({
                        id: member.user_id,
                        name: member.nickname
                    })
                );
            });

            const dms = (await p.client.api.get("/chats", { params: { per_page: "100" } })).data.response;
            if (dms.length > 0) {
                list.push({
                    category: true,
                    name: "DMs"
                });
                dms.forEach(dm =>
                    list.push({
                        id: dm.other_user.id,
                        name: dm.other_user.name
                    })
                );
            }

            return list;
        } catch (err) {
            log.error(`Failed to get user lists: ${err}`);
            return [];
        }
    }

    async listRooms(puppetId: number): Promise<IRetList[]> {
        const p = this.puppets[puppetId];
        if (!p) return [];

        try {
            const groups = (await p.client.api.get("/groups", {
                params: {
                    per_page: "500",
                    omit: "memberships"
                }
            })).data.response;

            return groups.map(group => ({
                id: group.id,
                name: group.name
            }));
        } catch (err) {
            log.error(`Failed to get group list: ${err}`);
            return [];
        }
    }

    async getDmRoomId(user: IRemoteUser): Promise<string | null> {
        const p = this.puppets[user.puppetId];
        if (!p) return null;

        return [p.data.userId, user.userId].sort().join("+");
    }

    async bridgeGroup(puppetId: number, param: string, sendMessage: SendMessageFn) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        try {
            await this.puppet.bridgeRoom({
                roomId: param,
                puppetId
            });
            await sendMessage("Group bridged");
        } catch (err) {
            log.warn(`Failed to bridge group ${param}: ${err}`);
            await sendMessage("Failed to bridge group\nIs the group ID correct?");
        }
    }

    async unbridgeGroup(puppetId: number, param: string, sendMessage: SendMessageFn) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        try {
            await this.puppet.unbridgeRoom({
                roomId: param,
                puppetId
            });
            await sendMessage("Group unbridged");
        } catch (err) {
            log.warn(`Failed to unbridge group ${param}: ${err}`);
            await sendMessage("Failed to unbridge group\nIs the group currently bridged, and the group ID correct?");
        }
    }

    async bridgeAllGroups(puppetId: number, param: string, sendMessage: SendMessageFn) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        try {
            const groups = (await p.client.api.get("/groups", {
                params: {
                    per_page: "500",
                    omit: "memberships"
                }
            })).data.response;

            await Promise.all(groups.map(group =>
                this.puppet.bridgeRoom({
                    roomId: group.id,
                    puppetId
                })
            ));
            await sendMessage("All groups bridged");
        } catch (err) {
            log.error(`Failed to bridge groups: ${err}`);
            await sendMessage("Failed to bridge groups");
        }
    }

    async bridgeAllDms(puppetId: number, param: string, sendMessage: SendMessageFn) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        try {
            const dms = (await p.client.api.get("/chats", { params: { per_page: "100" } })).data.response;

            await Promise.all(dms.map(dm =>
                this.puppet.bridgeRoom({
                    roomId: [p.data.userId, dm.other_user.id].sort().join("+"),
                    puppetId
                })
            ));
            await sendMessage("All DMs bridged");
        } catch (err) {
            log.error(`Failed to bridge DMs: ${err}`);
            await sendMessage("Failed to bridge DMs");
        }
    }

    async bridgeEverything(puppetId: number, param: string, sendMessage: SendMessageFn) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        await Promise.all([
            this.bridgeAllGroups(puppetId, param, sendMessage),
            this.bridgeAllDms(puppetId, param, sendMessage)
        ]);
    }
}
