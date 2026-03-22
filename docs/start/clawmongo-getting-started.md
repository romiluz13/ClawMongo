# Getting Started with ClawMongo

ClawMongo is the MongoDB edition of OpenClaw. This guide gets you from zero to a working personal AI assistant with MongoDB-native memory in about 10 minutes.

---

## Prerequisites

### Required

- **Node.js 22+** (24 recommended)
- **MongoDB** via `mongodb-atlas-local:preview` Docker image (recommended) or Atlas CLI local deployment
- **Voyage AI API key** (for automated embeddings via mongot)
- **LLM API key** (Anthropic Claude recommended, or OpenAI, Google, Mistral, etc.)

### MongoDB Setup Options

#### Option A: Docker (Quickest)

Use `mongodb/mongodb-atlas-local:preview` -- a single Docker image that bundles mongod + the open-source community mongot + Atlas Search + Vector Search + **Voyage AI auto-embeddings** as a ready-to-use replica set (~584 MB).

> **Important:** The `:preview` tag is required for auto-embeddings. The `:latest` and versioned tags (`:8.0`, `:8.2`) do NOT include the community mongot with Voyage AI support. See [Docker Hub](https://hub.docker.com/r/mongodb/mongodb-atlas-local) for details.

```yaml
services:
  mongodb:
    image: mongodb/mongodb-atlas-local:preview
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    environment:
      - VOYAGE_API_KEY=${VOYAGE_API_KEY}

volumes:
  mongodb_data:
```

Start the service:

```bash
export VOYAGE_API_KEY="your-voyage-ai-key"
docker compose up -d
```

That's it -- no replica set init needed. The `mongodb-atlas-local` image starts as a single-node replica set with mongot, Atlas Search, and Vector Search already configured. Verify it's healthy:

```bash
docker exec -it $(docker compose ps -q mongodb) mongosh --eval "db.runCommand({ ping: 1 })"
```

#### Option B: Atlas CLI Local Deployment

Use the MongoDB Atlas CLI to create a local deployment (bundles mongod + mongot):

```bash
# Install Atlas CLI
brew install mongodb-atlas-cli  # macOS
# or see https://www.mongodb.com/docs/atlas/cli/stable/install-atlas-cli/

# Create a local deployment with search support
atlas deployments setup clawmongo --type local --port 27017
```

This creates a local deployment with mongod + mongot bundled together -- no separate mongot install needed.

> **Why not Atlas SaaS?** ClawMongo targets local MongoDB via the `mongodb-atlas-local:preview` Docker image. Atlas SaaS URIs (`.mongodb.net`) are not supported by the onboarding wizard. The atlas-local image provides the same search capabilities without a cloud dependency.

---

### Voyage AI Setup

1. Sign up at [voyageai.com](https://www.voyageai.com)
2. Generate an API key from the dashboard
3. Set `VOYAGE_API_KEY` when starting the atlas-local container (Docker env var) or pass it to Atlas CLI

ClawMongo uses `voyage-4-large` (1024 dimensions) for all embeddings. This is configured in the search index definitions, not in application code.

---

## Install ClawMongo

```bash
npm install -g @romiluz/clawmongo@latest
# or
pnpm add -g @romiluz/clawmongo@latest
```

Verify installation:

```bash
clawmongo --version
```

The `openclaw` command is also available as an alias for compatibility.

---

## Configure MongoDB Connection

```bash
# Set the MongoDB connection URI
clawmongo config set memory.mongodb.uri "mongodb://localhost:27017/clawmongo?replicaSet=rs0"

# Enable automated embeddings via mongot
clawmongo config set memory.mongodb.embeddingMode "automated"
```

---

## Run Onboarding

```bash
clawmongo onboard --install-daemon
```

The onboarding wizard walks you through:

1. **Model provider selection** -- choose Anthropic, OpenAI, Google, or another supported provider
2. **API key entry** -- enter your LLM provider API key
3. **Gateway setup** -- configures the gateway daemon on port 18789
4. **Collection bootstrap** -- creates all 20 MongoDB collections and 53 standard indexes
5. **Search index creation** -- creates text and vector search indexes (requires mongot)

The `--install-daemon` flag installs the gateway as a system service (launchd on macOS, systemd on Linux) so it stays running.

---

## Verify the Setup

### Check gateway status

```bash
clawmongo gateway status
```

### Check channel connectivity

```bash
clawmongo channels status --probe
```

### Check MongoDB connection and memory health

```bash
clawmongo doctor
```

The doctor command verifies MongoDB connectivity, collection existence, index counts, and mongot availability.

### Send a test message

```bash
clawmongo agent --message "Hello, remember that my name is Alice" --thinking low
```

Then verify memory was written:

```bash
clawmongo agent --message "What is my name?" --thinking low
```

---

## Connect a Channel (Optional)

Telegram is the quickest channel to set up:

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token
3. Configure it:

```bash
clawmongo config set channels.telegram.botToken "YOUR_BOT_TOKEN"
```

4. Restart the gateway:

```bash
clawmongo gateway restart
```

5. Send a message to your bot on Telegram

For other channels (WhatsApp, Slack, Discord, etc.), see the [channel setup guides](https://docs.openclaw.ai/channels).

---

## Configuration Reference

Minimal `~/.openclaw/openclaw.json` for ClawMongo:

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
  memory: {
    mongodb: {
      uri: "mongodb://localhost:27017/clawmongo?replicaSet=rs0",
      embeddingMode: "automated",
    },
  },
}
```

For the full configuration reference: [docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration)

For MongoDB-specific memory configuration: [docs/reference/memory-config.md](../reference/memory-config.md)

---

## Next Steps

- **Import knowledge base documents**: Use `clawmongo kb import` to add reference material
- **Configure structured memory**: The agent writes structured facts automatically during conversations
- **Read the MongoDB capability deep-dive**: [docs/reference/mongodb-capabilities.md](../reference/mongodb-capabilities.md)
- **Understand the architecture**: [docs/reference/heart-brain-boundary.md](../reference/heart-brain-boundary.md)
- **Compare with default memory**: [docs/reference/clawmongo-vs-default-memory.md](../reference/clawmongo-vs-default-memory.md)
- **Set up additional channels**: [docs.openclaw.ai/channels](https://docs.openclaw.ai/channels)

---

## Troubleshooting

### MongoDB connection refused

Verify MongoDB is running and accessible:

```bash
mongosh "mongodb://localhost:27017" --eval "db.runCommand({ ping: 1 })"
```

### Replica set not initialized

Change streams require a replica set. Initialize it:

```bash
mongosh --eval "rs.initiate()"
```

### mongot not available

If search index creation fails, ensure you are running the `mongodb-atlas-local:preview` Docker image
which bundles mongot. Run:

```bash
./docker/mongodb/start-preview.sh
```

ClawMongo falls back to BSON `$text` indexes when mongot is unavailable, but vector search requires mongot.

### Voyage AI embedding errors

Verify the `VOYAGE_API_KEY` environment variable is set on the atlas-local container. Test embedding generation:

```bash
curl -X POST "https://api.voyageai.com/v1/embeddings" \
  -H "Authorization: Bearer YOUR_VOYAGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "test", "model": "voyage-4-large"}'
```

### Run the doctor

```bash
clawmongo doctor
```

The doctor command checks for common configuration issues and provides actionable fix suggestions.
