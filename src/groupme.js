import { URL } from "url";
import Axios from "axios";
import { Log } from "mx-puppet-bridge";
import { Client } from "./client.js";

const log = new Log("GroupMePuppet:groupme");

export class GroupMe {
    puppets = {};

    constructor(puppet) {
        this.puppet = puppet;
    }

    async newPuppet(puppetId, data) {
        if (this.puppets[puppetId]) {
            // The puppet somehow already exists, delete it first
            await this.deletePuppet(puppetId);
        }

        this.puppets[puppetId] = {
            client: new Client(data.token),
            data
        };
        const p = this.puppets[puppetId];

        await p.client.start();

        const me = (await p.client.api.get("/users/me")).data.response;
        p.data.userId = me.user_id;
        p.data.username = me.name;

        await this.puppet.setPuppetData(puppetId, p.data);
        await this.puppet.setUserId(puppetId, p.data.userId);
        await this.puppet.sendStatusMessage(puppetId, "connected");

        p.client.on("message", async message =>
            this.handleGroupMeMessage.bind(this)(puppetId, message)
        );
    }

    async deletePuppet(puppetId) {
        const p = this.puppets[puppetId];
        if (!p) return;

        await p.client.stop();
        delete this.puppets[puppetId];
    }

    async sendMessage(room, data) {
        const p = this.puppets[room.puppetId];
        if (!p) return null;

        if (room.roomId.includes("+")) {
            return (await p.client.api.post("/direct_messages", {
                direct_message: {
                    ...data,
                    recipient_id: room.roomId.split("+").find(userId => userId !== p.data.userId)
                }
            })).data.response;
        } else {
            return (await p.client.api.post(`/groups/${room.roomId}/messages`, {
                message: data
            })).data.response;
        }
    }

    async handleMatrixMessage(room, data, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        console.log(room);
        const res = await this.sendMessage(room, {
            source_guid: data.eventId,
            text: data.body
        });
        this.puppet.eventSync.insert(
            room,
            data.eventId,
            res.direct_message ? res.direct_message.id : res.message.id
        );
    }

    async handleMatrixFile(room, data, asUser, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        const fileData = (await Axios.get(data.url, { responseType: "arraybuffer" })).data;
        const fileInfo = (await p.client.fileApi.post(`/${room.roomId}/files`, fileData, {
            params: { name: data.filename },
            maxBodyLength: Infinity
        })).data;
        const fileId = new URL(fileInfo.status_url).searchParams.get("job");
        console.log(`file id: ${fileId}`);

        while ((await p.client.fileApi.get(`/${room.roomId}/uploadStatus`, { params: { job: fileId } })).data.status !== "completed") {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const res = await this.sendMessage(room, {
            source_guid: data.eventId,
            attachments: [{
                type: "file",
                file_id: fileId
            }]
        });
        this.puppet.eventSync.insert(
            room,
            data.eventId,
            res.direct_message ? res.direct_message.id : res.message.id
        );
    }

    async handleMatrixImage(room, data, asUser, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        const imageData = (await Axios.get(data.url, { responseType: "arraybuffer" })).data;
        const imageInfo = (await p.client.imageApi.post("/pictures", imageData, {
            headers: { "Content-Type": data.info.mimetype }
        })).data;

        const res = await this.sendMessage(room, {
            source_guid: data.eventId,
            attachments: [{
                type: "image",
                url: imageInfo.payload.url
            }]
        });
        this.puppet.eventSync.insert(
            room,
            data.eventId,
            res.direct_message ? res.direct_message.id : res.message.id
        );
    }

    async handleMatrixReaction(room, eventId, reaction, asUser, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        if (reaction === "❤️") {
            await p.client.api.post(`/messages/${room.roomId}/${eventId}/like`);
        }
    }

    async handleMatrixRemoveReaction(room, eventId, reaction, asUser, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        if (reaction === "❤️") {
            await p.client.api.post(`/messages/${room.roomId}/${eventId}/unlike`);
        }
    }

    async handleMatrixReply(room, eventId, data, asUser, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        const res = await this.sendMessage(room, {
            source_guid: data.eventId,
            text: data.body.split("\n\n")[1],
            attachments: [{
                type: "reply",
                reply_id: eventId,
                base_reply_id: eventId
            }]
        });
        this.puppet.eventSync.insert(
            room,
            data.eventId,
            res.direct_message ? res.direct_message.id : res.message.id
        );
    }

    async handleGroupMeMessage(puppetId, message) {
        const p = this.puppets[puppetId];
        if (!p) return;

        console.log(message);
        if (message.subject && message.subject.attachments) {
            console.log(message.subject.attachments);
        }

        // Filter out our own messages
        // TODO: Proper deduplication
        if (message.subject && message.subject.user_id === p.data.userId) return;

        switch (message.type) {
            case "direct_message.create":
            case "line.create": {
                const sendParams = {
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
                let replyId;

                message.subject.attachments.forEach(async attachment => {
                    switch (attachment.type) {
                        case "file": {
                            const fileInfo = (await p.client.fileApi.post(
                                `/${sendParams.room.roomId}/fileData`,
                                { file_ids: [ attachment.file_id ] }
                            )).data;
                            const fileBuffer = (await p.client.fileApi.get(
                                `/${sendParams.room.roomId}/files/${attachment.file_id}`,
                                { responseType: "arraybuffer" }
                            )).data;

                            this.puppet.sendFile(
                                sendParams,
                                fileBuffer,
                                fileInfo[0].file_data.file_name
                            );
                            // TODO: Discard "Shared a document" message
                            break;
                        }
                        case "image": {
                            this.puppet.sendImage(sendParams, attachment.url);
                            break;
                        }
                        case "reply": {
                            replyId = attachment.reply_id;
                        }
                    }
                });

                if (message.subject.text) {
                    if (replyId) {
                        await this.puppet.sendReply(sendParams, replyId, {
                            body: message.subject.text,
                            eventId: message.subject.id
                        });
                    } else {
                        await this.puppet.sendMessage(sendParams, {
                            body: message.subject.text,
                            eventId: message.subject.id
                        });
                    }
                }
                break;
            }
            case "like.create": {
                const sendParams = {
                    room: {
                        roomId: message.subject.line ?
                            message.subject.line.group_id :
                            message.subject.direct_message.chat_id,
                        puppetId
                    },
                    user: {
                        userId: message.subject.user_id,
                        puppetId
                    }
                };
                const messageId = message.subject.line ?
                    message.subject.line.id :
                    message.subject.direct_message.id;

                await this.puppet.sendReaction(sendParams, messageId, "❤️");
                break;
            }
        }
    }

    async getUserIdsInRoom(room) {
        const p = this.puppets[room.puppetId];
        if (!p) return null;

        if (room.roomId.includes("+")) {
            return new Set(room.roomId.split("+"));
        } else {
            const members = (await p.client.api.get(`/groups/${room.roomId}`)).data.response.members;
            return new Set(members.map(member => member.user_id));
        }
    }

    async createRoom(room) {
        const p = this.puppets[room.puppetId];
        if (!p) return null;

        if (room.roomId.includes("+")) {
            return {
                ...room,
                isDirect: true
            };
        } else {
            const group = (await p.client.api.get(`/groups/${room.roomId}`)).data.response;
            return {
                ...room,
                name: group.name,
                topic: group.description,
                avatarUrl: group.image_url,
                isDirect: false
            };
        }
    }

    async createUser(user) {
        const p = this.puppets[user.puppetId];
        if (!p) return null;

        // First check group memberships
        const groups = (await p.client.api.get("/groups", { params: { per_page: "500" } })).data.response;
        const groupUser = groups.flatMap(group => group.members).find(u => u.user_id === user.userId);

        if (groupUser) {
            return {
                ...user,
                name: groupUser.name,
                avatarUrl: groupUser.image_url
            };
        } else {
            // Check DMs instead
            const dms = (await p.client.api.get("/chats", { params: { per_page: "100" } })).data.response;
            const dmUser = dms.find(dm => dm.other_user.id === user.userId);

            return {
                ...user,
                name: dmUser.name,
                avatarUrl: dmUser.avatarUrl
            };
        }
    }

    async listUsers(puppetId) {
        const p = this.puppets[puppetId];
        if (!p) return null;

        const list = [];

        const groups = (await p.client.api.get("/groups", { params: { per_page: "500" } })).data.response;
        groups.forEach(group => {
            list.push({
                category: true,
                name: group.name
            });
            group.members.forEach(member =>
                list.push({
                    id: member.user_id,
                    name: member.name
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
    }

    async listRooms(puppetId) {
        const p = this.puppets[puppetId];
        if (!p) return null;

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
    }

    async getDmRoomId(user) {
        const p = this.puppets[user.puppetId];
        if (!p) return null;

        return [p.data.userId, user.userId].sort().join("+");
    }

    async bridgeGroup(puppetId, param, sendMessage) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        await this.puppet.bridgeRoom({
            roomId: param,
            puppetId
        });
        await sendMessage("Group bridged");
    }

    async unbridgeGroup(puppetId, param, sendMessage) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        await this.puppet.unbridgeRoom({
            roomId: param,
            puppetId
        });
        await sendMessage("Group unbridged");
    }

    async bridgeAllGroups(puppetId, param, sendMessage) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        const groups = (await p.client.api.get("/groups", {
            params: {
                per_page: "500",
                omit: "memberships"
            }
        })).data.response;

        groups.forEach(async group =>
            await this.puppet.bridgeRoom({
                roomId: group.id,
                puppetId
            })
        );
        await sendMessage("All groups bridged");
    }

    async bridgeAllDms(puppetId, param, sendMessage) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        const dms = (await p.client.api.get("/chats", { params: { per_page: "100" } })).data.response;

        dms.forEach(async dm =>
            await this.puppet.bridgeRoom({
                roomId: dm.last_message.conversation_id,
                puppetId
            })
        );
        await sendMessage("All DMs bridged");
    }

    async bridgeEverything(puppetId, param, sendMessage) {
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
