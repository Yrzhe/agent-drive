# Agent Drive CLI

`adrive` is the command-line client for Agent Drive.

Week 2 starts with login and local machine identity. Sync commands will build on this config.

## Install

```bash
cd cli
npm install
npm run build
npm link
```

## Login

```bash
adrive login --url https://large-gator-9215.edgespark.app --token "$AGENT_TOKEN"
```

`--token-type` defaults to `agent_token`. For future OAuth access tokens:

```bash
adrive login --url https://large-gator-9215.edgespark.app --token "$TOKEN" --token-type oauth_access_token
```

Login validates the token by calling MCP `initialize` at:

```text
<URL>/api/public/mcp
```

Config is written to:

```text
~/.agent-drive/config.json
```

The file is created with mode `600`. The first login generates a persistent `machineId`; later logins keep the same `machineId` and update the URL/token fields.

## Whoami

```bash
adrive whoami
```

Prints the configured URL, machine ID, and MCP server info.

## Logout

```bash
adrive logout
```

Deletes `~/.agent-drive/config.json`.
