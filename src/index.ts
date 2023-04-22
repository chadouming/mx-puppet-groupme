import {
    PuppetBridge,
    Log,
    IProtocolInformation,
    IRetData
} from "mx-puppet-bridge";
import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import { GroupMe } from "./groupme.js";

const log = new Log("GroupMePuppet:index");

const commandOptions = [
    { name: "register", alias: "r", type: Boolean },
    { name: "registration-file", alias: "f", type: String },
    { name: "config", alias: "c", type: String },
    { name: "help", alias: "h", type: Boolean }
];
const options = {
    register: false,
    "registration-file": "groupme-registration.yaml",
    config: "config.yaml",
    help: false,
    ...commandLineArgs(commandOptions)
};

if (options.help) {
    console.log(commandLineUsage([
        {
            header: "mx-puppet-groupme",
            content: "Puppeting Matrix bridge for GroupMe"
        },
        {
            header: "Options",
            optionList: commandOptions
        }
    ]));
    process.exit(0);
}

const protocol: IProtocolInformation = {
    features: {
        file: true,
        image: true,
        video: true,
        reply: true,
        globalNamespace: true,
        typingTimeout: 1000
    },
    id: "groupme",
    displayname: "GroupMe",
    externalUrl: "https://groupme.com/"
};

const puppet = new PuppetBridge(options["registration-file"], options.config, protocol);

if (options.register) {
    puppet.readConfig(false);
    try {
        puppet.generateRegistration({
            prefix: "bot_groupme",
            id: "groupme-puppet",
            url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`
        });
    } catch (err) {
        console.log("Couldn't generate registration file: ", err);
    }
    process.exit(0);
}

async function run() {
    await puppet.init();

    const groupme = new GroupMe(puppet);

    puppet.on("puppetNew", groupme.newPuppet.bind(groupme));
    puppet.on("puppetDelete", groupme.deletePuppet.bind(groupme));
    puppet.on("message", groupme.handleMatrixMessage.bind(groupme));
    puppet.on("file", groupme.handleMatrixFile.bind(groupme));
    puppet.on("image", groupme.handleMatrixImage.bind(groupme));
    puppet.on("video", groupme.handleMatrixVideo.bind(groupme));
    puppet.on("reaction", groupme.handleMatrixReaction.bind(groupme));
    puppet.on("removeReaction", groupme.handleMatrixRemoveReaction.bind(groupme));
    puppet.on("reply", groupme.handleMatrixReply.bind(groupme));
    puppet.on("typing", groupme.handleMatrixTyping.bind(groupme));
    puppet.on("read", groupme.handleMatrixReadReceipt.bind(groupme));
    puppet.setGetUserIdsInRoomHook(groupme.getUserIdsInRoom.bind(groupme));
    puppet.setRoomExistsHook(groupme.roomExists.bind(groupme));
    puppet.setCreateRoomHook(groupme.createRoom.bind(groupme));
    puppet.setCreateUserHook(groupme.createUser.bind(groupme));
    puppet.setGetDmRoomIdHook(groupme.getDmRoomId.bind(groupme));
    puppet.setListUsersHook(groupme.listUsers.bind(groupme));
    puppet.setListRoomsHook(groupme.listRooms.bind(groupme));
    puppet.setGetDescHook(async (puppetId: number, data: any): Promise<string> => {
        let desc = "GroupMe";
        if (data.username) {
            desc += ` as ${data.username}`;
        }
        if (data.userId) {
            desc += ` (${data.userId})`;
        }
        return desc;
    });
    puppet.setGetDataFromStrHook(async (str: string): Promise<IRetData> => ({
        success: true,
        data: {
            token: str
        }
    }));
    puppet.setBotHeaderMsgHook((): string => "GroupMe bridge");
    puppet.registerCommand("bridgegroup", {
        fn: groupme.bridgeGroup.bind(groupme),
        help: `Bridge a group

Usage: \`bridgegroup <puppetId> <groupId>\``
    });
    puppet.registerCommand("unbridgegroup", {
        fn: groupme.unbridgeGroup.bind(groupme),
        help: `Unbridge a group

Usage: \`unbridgegroup <puppetId> <groupId>\``
    });
    puppet.registerCommand("bridgeallgroups", {
        fn: groupme.bridgeAllGroups.bind(groupme),
        help: `Bridge all groups you are in

Usage: \`bridgeallgroups <puppetId>\``
    });
    puppet.registerCommand("bridgealldms", {
        fn: groupme.bridgeAllDms.bind(groupme),
        help: `Bridge all of your DMs

Usage: \`bridgealldms <puppetId>\``
    });
    puppet.registerCommand("bridgeeverything", {
        fn: groupme.bridgeEverything.bind(groupme),
        help: `Bridge all of your groups and DMs

Usage: \`bridgeeverything <puppetId>\``
    });

    await puppet.start();
}

run();
