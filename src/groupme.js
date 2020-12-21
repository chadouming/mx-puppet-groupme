import Util from "util";
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

        try {
            await p.client.start();

            const me = (await p.client.api.get("/users/me")).data.response;
            p.data.userId = me.user_id;
            p.data.username = me.name;

            await this.puppet.setPuppetData(puppetId, p.data);
            await this.puppet.setUserId(puppetId, p.data.userId);
            await this.puppet.sendStatusMessage(puppetId, "connected");

            p.client.on("message", async message => {
                try {
                    await this.handleGroupMeMessage.bind(this)(puppetId, message);
                } catch (err) {
                    log.error(`Failed to handle GroupMe event: ${err}`);
                }
            });
        } catch (err) {
            log.error(`Failed to start puppet ${puppetId}: ${err}`);
            await this.puppet.sendStatusMessage(puppetId, `Failed to connect: ${err}`);
        }
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

        try {
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
        } catch (err) {
            log.warn(`Failed to send message to ${room.roomId}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to send message");
        }
    }

    async handleMatrixMessage(room, data, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

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

        try {
            const fileData = (await Axios.get(data.url, { responseType: "arraybuffer" })).data;
            const fileInfo = (await p.client.fileApi.post(`/${room.roomId}/files`, fileData, {
                params: { name: data.filename },
                maxBodyLength: Infinity
            })).data;
            const fileId = new URL(fileInfo.status_url).searchParams.get("job");

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
        } catch (err) {
            log.warn(`Failed to upload file ${data.mxc}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to upload file");
            return;
        }
    }

    async handleMatrixImage(room, data, asUser, event) {
        const p = this.puppets[room.puppetId];
        if (!p) return;

        try {
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
        } catch (err) {
            log.warn(`Failed to upload image ${data.mxc}: ${err}`);
            await this.puppet.sendStatusMessage(room, "Failed to upload image");
            return;
        }
    }

    async handleMatrixReaction(room, eventId, reaction, asUser, event) {
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
            const res = await this.sendMessage(room, {
                source_guid: event.eventId,
                text: reaction,
                attachments: [{
                    type: "reply",
                    reply_id: eventId,
                    base_reply_id: eventId
                }]
            });
            this.puppet.eventSync.insert(
                room,
                event.eventId,
                res.direct_message ? res.direct_message.id : res.message.id
            );
        }
    }

    async handleMatrixRemoveReaction(room, eventId, reaction, asUser, event) {
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

        if (message.type !== "ping") {
            log.debug(`Got message: ${Util.inspect(message, { depth: null })}`);
        }

        // Filter out our own messages
        // TODO: Proper deduplication
        if (message.subject && message.subject.user_id === p.data.userId) return;

        switch (message.type) {
            case "direct_message.create":
            case "line.create": {
                if (message.subject.user_id === "system") {
                    switch (message.subject.event.type) {
                        case "membership.announce.added": {
                            await Promise.all(
                                message.subject.event.data.added_users.map(user =>
                                    this.puppet.addUser({
                                        room: message.subject.group_id,
                                        user: user.id
                                    })
                                )
                            );
                            break;
                        }
                        case "membership.notifications.exited": {
                            await this.puppet.removeUser({
                                room: message.subject.group_id,
                                user: message.subject.event.data.removed_user.id
                            });
                            break;
                        }
                        case "membership.nickname_changed": {
                            const roomOverrides = {};
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
                            const roomOverrides = {};
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

                    await Promise.all(message.subject.attachments.map(async attachment => {
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
                    }));

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
            case "membership.create": {
                await this.puppet.bridgeRoom({
                    roomId: message.subject.id,
                    puppetId
                });
            }
        }
    }

    async getUserIdsInRoom(room) {
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

    async createRoom(room) {
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

    async createUser(user) {
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

            const roomOverrides = Object.fromEntries(
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

    async listUsers(puppetId) {
        const p = this.puppets[puppetId];
        if (!p) return null;

        try {
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

    async listRooms(puppetId) {
        const p = this.puppets[puppetId];
        if (!p) return null;

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

    async unbridgeGroup(puppetId, param, sendMessage) {
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

    async bridgeAllGroups(puppetId, param, sendMessage) {
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

    async bridgeAllDms(puppetId, param, sendMessage) {
        const p = this.puppets[puppetId];
        if (!p) {
            await sendMessage("Puppet not found!");
            return;
        }

        try {
            const dms = (await p.client.api.get("/chats", { params: { per_page: "100" } })).data.response;

            await Promise.all(dms.map(dm =>
                this.puppet.bridgeRoom({
                    roomId: dm.last_message.conversation_id,
                    puppetId
                })
            ));
            await sendMessage("All DMs bridged");
        } catch (err) {
            log.error(`Failed to bridge DMs: ${err}`);
            await sendMessage("Failed to bridge DMs");
        }
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
