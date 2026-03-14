import { spawn } from "node:child_process";
import { createServer } from "node:net";

export type SshParsedTarget = {
  user?: string;
  host: string;
  port: number;
};

export type SshTunnel = {
  parsedTarget: SshParsedTarget;
  localPort: number;
  remotePort: number;
  pid: number | null;
  stderr: string[];
  stop: () => Promise<void>;
};

export function parseSshTarget(raw: string): SshParsedTarget | null {
  const trimmed = raw.trim().replace(/^ssh\s+/, "");
  if (!trimmed) {
    return null;
  }

  const [userPart, hostPart] = trimmed.includes("@")
    ? ((): [string | undefined, string] => {
        const idx = trimmed.indexOf("@");
        const user = trimmed.slice(0, idx).trim();
        const host = trimmed.slice(idx + 1).trim();
        return [user || undefined, host];
      })()
    : [undefined, trimmed];

  const colonIdx = hostPart.lastIndexOf(":");
  if (colonIdx > 0 && colonIdx < hostPart.length - 1) {
    const host = hostPart.slice(0, colonIdx).trim();
    const portRaw = hostPart.slice(colonIdx + 1).trim();
    const port = Number.parseInt(portRaw, 10);
    if (!host || !Number.isFinite(port) || port <= 0) {
      return null;
    }
    // Security: Reject hostnames starting with '-' to prevent argument injection
    if (host.startsWith("-")) {
      return null;
    }
    return { user: userPart, host, port };
  }

  if (!hostPart) {
    return null;
  }
  // Security: Reject hostnames starting with '-' to prevent argument injection
  if (hostPart.startsWith("-")) {
    return null;
  }
  return { user: userPart, host: hostPart, port: 22 };
}

async function pickEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to allocate a local port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

async function checkPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = require("node:net").createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function startSshPortForward(opts: {
  target: string;
  identity?: string;
  localPortPreferred: number;
  remotePort: number;
  timeoutMs: number;
}): Promise<SshTunnel> {
  const parsed = parseSshTarget(opts.target);
  if (!parsed) {
    throw new Error(`invalid SSH target: ${opts.target}`);
  }

  let localPort = opts.localPortPreferred;
  try {
    const server = createServer();
    server.listen(localPort, "127.0.0.1", () => {
      server.close();
    });
    server.on("error", (err) => {
      if (err && "code" in err && err.code === "EADDRINUSE") {
        localPort = await pickEphemeralPort();
      } else {
        throw err;
      }
    });
  } catch (err) {
    if (err && "code" in err && err.code === "EADDRINUSE") {
      localPort = await pickEphemeralPort();
    } else {
      throw err;
    }
  }

  const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
  const args = [
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${opts.remotePort}`,
    "-p",
    String(parsed.port),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "UpdateHostKeys=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (opts.identity?.trim()) {
    args.push("-i", opts.identity.trim());
  }
  // Security: Use '--' to prevent userHost from being interpreted as an option
  args.push("--", userHost);

  const stderr: string[] = [];
  const child = spawn("/usr/bin/ssh", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    const lines = String(chunk)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    stderr.push(...lines);
  });

  const stop = async () => {
    if (child.killed) {
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } finally {
          resolve();
        }
      }, 1500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  // Wait for port to be listening with timeout
  const checkInterval = 50;
  const maxAttempts = Math.ceil(Math.max(250, opts.timeoutMs) / checkInterval);
  let portReady = false;
  for (let i = 0; i < maxAttempts; i++) {
    if (await checkPortListening(localPort)) {
      portReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  if (!portReady) {
    await stop();
    const suffix = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
    throw new Error(`ssh tunnel did not start listening on localhost:${localPort}${suffix}`);
  }

  // Check for SSH process exit
  if (child.killed) {
    const suffix = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
    throw new Error(`ssh process exited prematurely${suffix}`);
  }

  return {
    parsedTarget: parsed,
    localPort,
    remotePort: opts.remotePort,
    pid: typeof child.pid === "number" ? child.pid : null,
    stderr,
    stop,
  };
}