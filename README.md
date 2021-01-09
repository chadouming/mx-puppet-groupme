# mx-puppet-groupme

A puppeting Matrix bridge for GroupMe built with mx-puppet-bridge

For discussion and support, join us on Matrix at [#mx-puppet-groupme:townsendandsmith.ml](https://matrix.to/#/#mx-puppet-groupme:townsendandsmith.ml).

## Setup

First, install the dependencies:

```
npm install
```

Create a configuration file and edit it appropriately:

```
cp sample.config.yaml config.yaml
editor config.yaml
```

Then generate an appservice registration file (defaults to `groupme-registration.yaml`):

```
npm run start -- --register
```

Finally, point your homeserver to this registration file. For Synapse, this means adding its path to `app_service_config_files` in `homeserver.yaml`, and then restarting Synapse.

You can now run the bridge:

```
npm run start
```

## Usage

Start a chat with `@_groupmepuppet_bot:<your homeserver>`. You may type `help` to view available commands.

To link your GroupMe account, go to [dev.groupme.com](https://dev.groupme.com/), sign in, and select "Access Token" from the top menu. Copy the token and message the bridge with:

```
link <access token>
```

Note the puppet ID that it returns. (You can find it later with `list`.) You can now get invites to all your groups and DMs with `bridgeeverything <puppet ID>`, or use the `bridgegroup` command to bridge individual groups.

The user and group directories can be shown with `listusers` and `listrooms`. If you ever get locked out of a room, use the `invite` command to get back in.
