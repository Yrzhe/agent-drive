# Setup & Deployment

Deploy your own Agent Drive instance. Follow steps in order. Never run EdgeSpark commands in parallel.

## Prerequisites

```bash
node --version       # Need 18+
git --version        # Need git
edgespark --version  # Need EdgeSpark CLI
```

**EdgeSpark CLI not found?**
```bash
npm install -g edgespark
```

**Not logged in?**
```bash
edgespark login
```
This prints a URL. **STOP and tell the user:**
> Please open this URL in your browser to log in to EdgeSpark: {url}
> If you don't have an account, sign up free at https://edgespark.dev
> Tell me when you're done.

**Wait for confirmation before continuing.**

## Clone & Initialize

```bash
git clone https://github.com/Yrzhe/agent-drive.git my-agent-drive
cd my-agent-drive
edgespark init my-agent-drive
```

If init fails (directory exists), check `edgespark.toml` for `project_id`. If present, continue.

## Install Dependencies

```bash
cd server && npm install && cd ../web && npm install && cd ..
```

## Database & Storage

```bash
edgespark db generate
edgespark db migrate
edgespark storage apply
```

## Configure Auth

```bash
edgespark auth
```

## Generate AGENT_TOKEN

```bash
node -e "const t=require('crypto').randomBytes(32).toString('base64url'); require('fs').writeFileSync('.env','AGENT_TOKEN='+t+'\n'); console.log('Token saved to .env')"
edgespark secret set AGENT_TOKEN
```

The second command prints a URL. **STOP and tell the user:**
> Please open this URL: {url}
> Run `cat .env` to see your token, then paste that value into the browser form.
> Click Save, then tell me when done.

**Wait for confirmation.**

## Deploy

```bash
edgespark deploy
```

Save the URL from the output (e.g., `https://xxx.edgespark.app`).

## Create Owner Account

**Ask the user:**
> What email and password do you want for your Agent Drive dashboard?

```bash
curl -X POST https://{URL}/api/_es/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"{email}","password":"{password}","name":"Owner"}'
```

## Save Configuration

Write config files **into this skill's directory** so the agent can find them in future sessions:

**`.env`** (in this skill directory):
```
AGENT_TOKEN={the token value from the project .env}
```

**`drive.json`** (in this skill directory):
```json
{
  "url": "https://{DEPLOYED_URL}",
  "apiBase": "https://{DEPLOYED_URL}/api/public/v1",
  "guideUrl": "https://{DEPLOYED_URL}/api/public/guide"
}
```

Copy the token from the project's `.env` into the skill's `.env`. Copy the deployed URL into `drive.json`. Both files sit alongside this `SKILL.md`.

## Show Summary

```
Agent Drive is live!

  Dashboard:  https://{URL}
  API Base:   https://{URL}/api/public/v1
  Guide URL:  https://{URL}/api/public/guide
  Token:      stored in skill .env (never share this)
  Login:      {email}

Config saved to skill directory — agent can use it in any future session.
```

## Troubleshooting

- **"Not authenticated"** — Run `edgespark login`, show URL to user
- **Migration fails** — Must be on default branch (main/master)
- **Deploy fails** — Run `edgespark deploy --dry-run` first
- **Secret not working** — `edgespark secret list` to verify, re-set if needed
- **Can't sign up** — Check auth config: `edgespark auth`
