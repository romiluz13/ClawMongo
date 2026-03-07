import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("docker/mongodb/setup-generator.sh");
const templatePath = path.resolve("docker/mongodb/mongot.conf");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("docker/mongodb/setup-generator.sh", () => {
  it("generates mongot config without embedding block when keys are absent", async () => {
    const authDir = await makeTempDir("clawmongo-auth-");
    const templateDir = await makeTempDir("clawmongo-template-");
    await fs.copyFile(templatePath, path.join(templateDir, "mongot.conf"));

    await execFileAsync("sh", [scriptPath], {
      env: {
        ...process.env,
        AUTH_DIR: authDir,
        TEMPLATE_DIR: templateDir,
      },
    });

    const generated = await fs.readFile(path.join(authDir, "mongot.generated.yml"), "utf8");
    expect(generated).not.toMatch(/^[^#\n]*embedding:/m);
    expect(await fs.readFile(path.join(authDir, "passwordFile"), "utf8")).toBe("mongotPassword");
  });

  it("appends embedding block when embedding keys are provided", async () => {
    const authDir = await makeTempDir("clawmongo-auth-");
    const templateDir = await makeTempDir("clawmongo-template-");
    await fs.copyFile(templatePath, path.join(templateDir, "mongot.conf"));

    await execFileAsync("sh", [scriptPath], {
      env: {
        ...process.env,
        AUTH_DIR: authDir,
        TEMPLATE_DIR: templateDir,
        VOYAGE_API_QUERY_KEY: "query-secret",
        VOYAGE_API_INDEXING_KEY: "index-secret",
        MONGOT_EMBEDDING_PROVIDER_ENDPOINT: "https://ai.mongodb.com/v1/embeddings",
      },
    });

    const generated = await fs.readFile(path.join(authDir, "mongot.generated.yml"), "utf8");
    expect(generated).toContain("embedding:");
    expect(generated).toContain("queryKeyFile: " + path.join(authDir, "voyage-api-query-key"));
    expect(generated).toContain(
      "indexingKeyFile: " + path.join(authDir, "voyage-api-indexing-key"),
    );
    expect(generated).toContain("providerEndpoint: https://ai.mongodb.com/v1/embeddings");
    expect(await fs.readFile(path.join(authDir, "voyage-api-query-key"), "utf8")).toBe(
      "query-secret",
    );
    expect(await fs.readFile(path.join(authDir, "voyage-api-indexing-key"), "utf8")).toBe(
      "index-secret",
    );
  });
});
