# Getting Started with ClawMongo

ClawMongo is the MongoDB edition of OpenClaw. This guide gets you from zero to a working personal AI assistant with MongoDB-native memory in about 10 minutes.

---

## Prerequisites

### Required

- **Node.js 22+** (24 recommended)
- **MongoDB 7.0+** with mongot (MongoDB Community Search)
- **Voyage AI API key** (for automated embeddings via mongot)
- **LLM API key** (Anthropic Claude recommended, or OpenAI, Google, Mistral, etc.)

### MongoDB Setup Options

#### Option A: Docker (Quickest)

Use the MongoDB Community image with mongot. Create a `docker-compose.yml`:

```yaml
version: "3.8"
services:
  mongodb:
    image: mongodb/mongodb-community-server:latest
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    command: ["--replSet", "rs0", "--bind_ip_all"]
    environment:
      - MONGODB_INIT_REPLICA_SET=true

  mongot:
    image: mongodb/mongodb-atlas-search:latest
    depends_on:
      - mongodb
    environment:
      - MONGOD_HOST=mongodb
      - MONGOD_PORT=27017
      - VOYAGE_API_KEY=${VOYAGE_API_KEY}

volumes:
  mongodb_data:
```

Start the services:

```bash
export VOYAGE_API_KEY="your-voyage-ai-key"
docker compose up -d
```

Initialize the replica set (required for change streams):

```bash
docker exec -it $(docker compose ps -q mongodb) mongosh --eval "rs.initiate()"
```

#### Option B: Local Install (macOS/Linux)

Install MongoDB Community and mongot using Homebrew (macOS) or your package manager:

```bash
# macOS
brew tap mongodb/brew
brew install mongodb-community
brew install mongodb-atlas-cli

# Start as a replica set (required for change streams)
mongod --replSet rs0 --dbpath /usr/local/var/mongodb --logpath /usr/local/var/log/mongodb/mongod.log --fork
mongosh --eval "rs.initiate()"
```

Install and configure mongot separately. See [MongoDB Community Search documentation](https://www.mongodb.com/docs/atlas/atlas-search/) for platform-specific instructions.

#### Option C: MongoDB Atlas

Create a free or paid cluster on [MongoDB Atlas](https://www.mongodb.com/atlas):

1. Create a cluster (M0 free tier works for development)
2. Enable Atlas Search on the cluster
3. Configure the Voyage AI integration in Atlas Search settings
4. Get the connection string from the Atlas dashboard

---

### Voyage AI Setup

1. Sign up at [voyageai.com](https://www.voyageai.com)
2. Generate an API key from the dashboard
3. Configure the key in your mongot deployment (Docker env var, Atlas Search settings, or local config)

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

For Atlas, use the full connection string:

```bash
clawmongo config set memory.mongodb.uri "mongodb+srv://user:password@cluster.mongodb.net/clawmongo"
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
    model: "anthropic/claude-opus-4-6"
  },
  memory: {
    mongodb: {
      uri: "mongodb://localhost:27017/clawmongo?replicaSet=rs0",
      embeddingMode: "automated"
    }
  }
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

If search index creation fails, verify mongot is running and connected to your MongoDB instance. ClawMongo falls back to BSON `$text` indexes when mongot is unavailable, but vector search requires mongot.

### Voyage AI embedding errors

Verify your Voyage AI API key is correctly configured in mongot. Test embedding generation:

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
