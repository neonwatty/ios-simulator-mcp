#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";

const execFileAsync = promisify(execFile);

/**
 * Strict UDID/UUID pattern: 8-4-4-4-12 hexadecimal characters (e.g. 37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA)
 */
const UDID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);

// ============ SESSION-BOUND SIMULATOR OWNERSHIP ============
// This section implements exclusive simulator ownership per MCP session
// to prevent multiple Claude Code instances from interfering with each other.

const SESSION_ID = `mcp-${process.pid}-${Date.now()}`;
const LOCK_DIR = path.join(os.homedir(), ".ios-simulator-mcp", "locks");

// Session state - the simulator claimed by this session
let claimedSimulatorUdid: string | null = null;

interface LockInfo {
  sessionId: string;
  pid: number;
  timestamp: number;
}

function ensureLockDir(): void {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }
}

function getLockPath(udid: string): string {
  return path.join(LOCK_DIR, `${udid}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(lockPath: string): LockInfo | null {
  try {
    const content = fs.readFileSync(lockPath, "utf-8");
    return JSON.parse(content) as LockInfo;
  } catch {
    return null;
  }
}

function isLockStale(lockPath: string): boolean {
  const lockInfo = readLockFile(lockPath);
  if (!lockInfo) return true;

  // Check if the owning process is still alive
  if (!isProcessAlive(lockInfo.pid)) {
    return true;
  }

  // Check if lock is older than 24 hours (failsafe for edge cases)
  const ageMs = Date.now() - lockInfo.timestamp;
  if (ageMs > 24 * 60 * 60 * 1000) {
    return true;
  }

  return false;
}

function tryAcquireLock(udid: string): boolean {
  ensureLockDir();
  const lockPath = getLockPath(udid);

  // Check for existing lock
  if (fs.existsSync(lockPath)) {
    // Check if we already own this lock
    const existingLock = readLockFile(lockPath);
    if (existingLock && existingLock.sessionId === SESSION_ID) {
      return true; // We already own it
    }

    // Check if lock is stale
    if (isLockStale(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return false;
      }
    } else {
      // Lock is held by another active session
      return false;
    }
  }

  // Try to create lock file exclusively
  try {
    const lockInfo: LockInfo = {
      sessionId: SESSION_ID,
      pid: process.pid,
      timestamp: Date.now(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(udid: string): void {
  const lockPath = getLockPath(udid);
  try {
    const lockInfo = readLockFile(lockPath);
    // Only release if we own it
    if (lockInfo && lockInfo.sessionId === SESSION_ID) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// ============ END SESSION-BOUND SIMULATOR OWNERSHIP ============

/**
 * Runs a command with arguments and returns the stdout and stderr
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { shell: false });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * Gets the IDB command path from environment variable or defaults to "idb"
 * @returns The path to the IDB executable
 * @throws Error if custom path is specified but doesn't exist
 */
function getIdbPath(): string {
  const customPath = process.env.IOS_SIMULATOR_MCP_IDB_PATH;

  if (customPath) {
    // Expand tilde if present
    const expandedPath = customPath.startsWith("~/")
      ? path.join(os.homedir(), customPath.slice(2))
      : customPath;

    // Check if the path exists
    if (!fs.existsSync(expandedPath)) {
      throw new Error(
        `Custom IDB path specified in IOS_SIMULATOR_MCP_IDB_PATH does not exist: ${expandedPath}`
      );
    }

    return expandedPath;
  }

  return "idb";
}

/**
 * Runs the idb command with the given arguments
 * @param args - arguments to pass to the idb command
 * @returns The stdout and stderr of the command
 * @see https://fbidb.io/docs/commands for documentation of available idb commands
 */
async function idb(...args: string[]) {
  return run(getIdbPath(), args);
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  return FILTERED_TOOLS.includes(toolName);
}

const server = new McpServer({
  name: "ios-simulator",
  version: require("../package.json").version,
});

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/joshuayoes/ios-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/joshuayoes/ios-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

async function getBootedDevice() {
  const { stdout, stderr } = await run("xcrun", ["simctl", "list", "devices"]);

  if (stderr) throw new Error(stderr);

  // Parse the output to find booted device
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes("Booted")) {
      // Extract the UUID - it's inside parentheses
      const match = line.match(/\(([-0-9A-F]+)\)/);
      if (match) {
        const deviceId = match[1];
        const deviceName = line.split("(")[0].trim();
        return {
          name: deviceName,
          id: deviceId,
        };
      }
    }
  }

  throw Error("No booted simulator found");
}

/**
 * Gets all currently booted simulators
 */
async function getAllBootedSimulators(): Promise<
  Array<{ name: string; id: string }>
> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices"]);
  const simulators: Array<{ name: string; id: string }> = [];

  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes("Booted")) {
      const match = line.match(/\(([-0-9A-F]+)\)/);
      if (match) {
        const deviceId = match[1];
        const deviceName = line.split("(")[0].trim();
        simulators.push({ name: deviceName, id: deviceId });
      }
    }
  }

  return simulators;
}

/**
 * Gets all available simulators (booted or shutdown)
 */
async function getAllAvailableSimulators(): Promise<
  Array<{ name: string; id: string; state: string; runtime: string }>
> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"]);
  const data = JSON.parse(stdout);
  const simulators: Array<{
    name: string;
    id: string;
    state: string;
    runtime: string;
  }> = [];

  for (const [runtime, devices] of Object.entries(data.devices)) {
    for (const device of devices as any[]) {
      if (device.isAvailable) {
        simulators.push({
          name: device.name,
          id: device.udid,
          state: device.state,
          runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
        });
      }
    }
  }

  return simulators;
}

/**
 * Claims a simulator for exclusive use by this session.
 * If no UDID is provided, tries to claim an existing booted simulator,
 * or boots a new one if all booted simulators are claimed.
 */
async function claimSimulator(
  udid?: string
): Promise<{ id: string; name: string }> {
  // If we already have a claimed simulator that's still valid, return it
  if (claimedSimulatorUdid) {
    const booted = await getAllBootedSimulators();
    const found = booted.find((s) => s.id === claimedSimulatorUdid);
    if (found) {
      return found;
    }
    // Our claimed simulator is no longer booted, release and reclaim
    releaseLock(claimedSimulatorUdid);
    claimedSimulatorUdid = null;
  }

  // If specific UDID requested, try to claim it
  if (udid) {
    if (tryAcquireLock(udid)) {
      claimedSimulatorUdid = udid;
      // Check if it's booted
      const booted = await getAllBootedSimulators();
      const found = booted.find((s) => s.id === udid);
      if (found) {
        return found;
      }
      // Not booted, boot it
      await run("xcrun", ["simctl", "boot", udid]);
      await run("open", ["-a", "Simulator.app"]);
      // Wait for boot
      await new Promise((r) => setTimeout(r, 3000));
      const afterBoot = await getAllBootedSimulators();
      const booted2 = afterBoot.find((s) => s.id === udid);
      if (booted2) return booted2;
      return { id: udid, name: "Simulator" };
    }
    throw new Error(
      `Simulator ${udid} is already claimed by another Claude Code instance`
    );
  }

  // Try to claim an existing booted simulator
  const bootedSimulators = await getAllBootedSimulators();
  for (const sim of bootedSimulators) {
    if (tryAcquireLock(sim.id)) {
      claimedSimulatorUdid = sim.id;
      return sim;
    }
  }

  // No unclaimed booted simulators - boot a new one
  const available = await getAllAvailableSimulators();
  const shutdownSims = available.filter((s) => s.state === "Shutdown");

  if (shutdownSims.length === 0) {
    throw new Error(
      "No available simulators to boot. Please create one in Xcode."
    );
  }

  // Prefer iPhone simulators
  const iPhones = shutdownSims.filter((s) => s.name.includes("iPhone"));
  const tooBoot = iPhones.length > 0 ? iPhones[0] : shutdownSims[0];

  if (!tryAcquireLock(tooBoot.id)) {
    throw new Error("Failed to acquire lock for simulator");
  }

  await run("xcrun", ["simctl", "boot", tooBoot.id]);
  await run("open", ["-a", "Simulator.app"]);

  claimedSimulatorUdid = tooBoot.id;

  // Wait for boot
  await new Promise((r) => setTimeout(r, 3000));

  return { id: tooBoot.id, name: tooBoot.name };
}

/**
 * Gets the device ID to use, with session claiming support.
 * - If deviceId is provided, uses it directly
 * - If we have a claimed simulator, uses that
 * - Otherwise, auto-claims a simulator
 */
async function getBootedDeviceIdWithClaim(
  deviceId: string | undefined
): Promise<string> {
  // If explicit deviceId provided, use it (allows override)
  if (deviceId) {
    return deviceId;
  }

  // If we have a claimed simulator, use it
  if (claimedSimulatorUdid) {
    return claimedSimulatorUdid;
  }

  // Auto-claim a simulator on first use
  const claimed = await claimSimulator();
  return claimed.id;
}

// Legacy function for backward compatibility (now calls the new one)
async function getBootedDeviceId(
  deviceId: string | undefined
): Promise<string> {
  return getBootedDeviceIdWithClaim(deviceId);
}

// Register tools only if they're not filtered
if (!isToolFiltered("get_booted_sim_id")) {
  server.tool(
    "get_booted_sim_id",
    "Get the ID of the currently booted iOS simulator",
    async () => {
      try {
        const { id, name } = await getBootedDevice();

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Booted Simulator: "${name}". UUID: "${id}"`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

// ============ NEW TOOLS FOR SESSION-BOUND OWNERSHIP ============

if (!isToolFiltered("claim_simulator")) {
  server.tool(
    "claim_simulator",
    "Claim a simulator for exclusive use by this Claude Code session. Other instances won't be able to control this simulator until released.",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe(
          "UDID of specific simulator to claim. If not provided, claims any available simulator (preferring already-booted ones)."
        ),
    },
    async ({ udid }) => {
      try {
        const claimed = await claimSimulator(udid);
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Successfully claimed simulator: "${claimed.name}" (${claimed.id})\n\nThis simulator is now exclusively controlled by this Claude Code session.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error claiming simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("get_claimed_simulator")) {
  server.tool(
    "get_claimed_simulator",
    "Get information about the simulator claimed by this Claude Code session",
    {},
    async () => {
      try {
        if (!claimedSimulatorUdid) {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: "No simulator currently claimed. Use claim_simulator or any UI tool to auto-claim one.",
              },
            ],
          };
        }

        const booted = await getAllBootedSimulators();
        const sim = booted.find((s) => s.id === claimedSimulatorUdid);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: sim
                ? `Claimed simulator: "${sim.name}" (${sim.id}) - Booted`
                : `Claimed simulator: ${claimedSimulatorUdid} - Not currently booted`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error getting claimed simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("list_simulators")) {
  server.tool(
    "list_simulators",
    "List all available iOS simulators with their status and claim information",
    {},
    async () => {
      try {
        const all = await getAllAvailableSimulators();
        ensureLockDir();

        const lines = all.map((sim) => {
          const lockPath = getLockPath(sim.id);
          let claimStatus = "Available";

          if (fs.existsSync(lockPath)) {
            const lockInfo = readLockFile(lockPath);
            if (lockInfo) {
              if (lockInfo.sessionId === SESSION_ID) {
                claimStatus = "Claimed by YOU";
              } else if (isProcessAlive(lockInfo.pid)) {
                claimStatus = "Claimed by another session";
              } else {
                claimStatus = "Available (stale lock)";
              }
            }
          }

          return `${sim.name} (${sim.id.slice(0, 8)}...)\n  State: ${sim.state}\n  Runtime: ${sim.runtime}\n  Status: ${claimStatus}`;
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: lines.join("\n\n"),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error listing simulators: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("boot_simulator")) {
  server.tool(
    "boot_simulator",
    "Boot a specific simulator and claim it for this session",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .describe("UDID of the simulator to boot"),
    },
    async ({ udid }) => {
      try {
        // First try to claim it
        if (!tryAcquireLock(udid)) {
          throw new Error(
            "Simulator is already claimed by another Claude Code instance"
          );
        }

        claimedSimulatorUdid = udid;

        // Boot the simulator
        await run("xcrun", ["simctl", "boot", udid]);
        await run("open", ["-a", "Simulator.app"]);

        // Wait for boot
        await new Promise((r) => setTimeout(r, 3000));

        const booted = await getAllBootedSimulators();
        const sim = booted.find((s) => s.id === udid);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: sim
                ? `Booted and claimed simulator: "${sim.name}" (${sim.id})`
                : `Booted and claimed simulator: ${udid}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error booting simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

// ============ END NEW TOOLS ============

if (!isToolFiltered("open_simulator")) {
  server.tool(
    "open_simulator",
    "Opens the iOS Simulator application",
    async () => {
      try {
        await run("open", ["-a", "Simulator.app"]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Simulator.app opened successfully",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error opening Simulator.app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Describes accessibility information for the entire screen in the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
    },
    async ({ udid }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        return {
          isError: false,
          content: [{ type: "text", text: stdout }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing all of the ui: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The x-coordinate"),
    },
    async ({ duration, udid, x, y }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Tapped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error tapping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Input text into the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    },
    async ({ udid, text }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await idb(
          "ui",
          "text",
          "--udid",
          actualUdid,
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          text
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Typed successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing text into the iOS Simulator: ${
                  toError(error).message
                }`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Swipe duration in seconds (e.g., 0.1)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    },
    async ({ duration, udid, x_start, y_start, x_end, y_end, delta }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await idb(
          "ui",
          "swipe",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          ...(delta ? ["--delta", String(delta)] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x_start),
          String(y_start),
          String(x_end),
          String(y_end)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Swiped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    async ({ udid, x, y }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout, stderr } = await idb(
          "ui",
          "describe-point",
          "--udid",
          actualUdid,
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: stdout }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point (${x}, ${y}): ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get the image content of a compressed screenshot of the current simulator view",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
    },
    async ({ udid }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        // Get screen dimensions in points from ui_describe_all
        const { stdout: uiDescribeOutput } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(uiDescribeOutput);
        const screenFrame = uiData[0]?.frame;
        if (!screenFrame) {
          throw new Error("Could not determine screen dimensions");
        }

        const pointWidth = screenFrame.width;
        const pointHeight = screenFrame.height;

        // Generate unique file names with timestamp
        const ts = Date.now();
        const rawPng = path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`);
        const compressedJpg = path.join(
          TMP_ROOT_DIR,
          `ui-view-${ts}-compressed.jpg`
        );

        // Capture screenshot as PNG
        await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          "--type=png",
          "--",
          rawPng,
        ]);

        // Resize to match point dimensions and compress to JPEG using sips
        await run("sips", [
          "-z",
          String(pointHeight), // height in points
          String(pointWidth), // width in points
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80", // 80% quality
          rawPng,
          "--out",
          compressedJpg,
        ]);

        // Read and encode the compressed image
        const imageData = fs.readFileSync(compressedJpg);
        const base64Data = imageData.toString("base64");

        return {
          isError: false,
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: "Screenshot captured",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error capturing screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR;

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Takes a screenshot of the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    },
    async ({ udid, output_path, type, display, mask }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
        const absolutePath = ensureAbsolutePath(output_path);

        // command is weird, it responds with stderr on success and stdout is blank
        const { stderr: stdout } = await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          ...(type ? [`--type=${type}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          absolutePath,
        ]);

        // throw if we don't get the expected success message
        if (stdout && !stdout.includes("Wrote screenshot to")) {
          throw new Error(stdout);
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: stdout,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error taking screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator using simctl directly",
    {
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
        ),
      codec: z
        .enum(["h264", "hevc"])
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    },
    async ({ output_path, codec, display, mask, force }) => {
      try {
        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        const outputFile = ensureAbsolutePath(output_path ?? defaultFileName);

        // Get the actual device ID (using claimed simulator if available)
        const actualUdid = await getBootedDeviceIdWithClaim(undefined);

        // Start the recording process with the specific UDID (not "booted")
        const recordingProcess = spawn("xcrun", [
          "simctl",
          "io",
          actualUdid, // FIX: Use specific UDID instead of "booted"
          "recordVideo",
          ...(codec ? [`--codec=${codec}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          ...(force ? ["--force"] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          outputFile,
        ]);

        // Wait for recording to start
        await new Promise((resolve, reject) => {
          let errorOutput = "";

          recordingProcess.stderr.on("data", (data) => {
            const message = data.toString();
            if (message.includes("Recording started")) {
              resolve(true);
            } else {
              errorOutput += message;
            }
          });

          // Set timeout for start verification
          setTimeout(() => {
            if (recordingProcess.killed) {
              reject(new Error("Recording process terminated unexpectedly"));
            } else {
              resolve(true);
            }
          }, 3000);
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording started. The video will be saved to: ${outputFile}\nTo stop recording, use the stop_recording command.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops the simulator video recording using killall",
    {},
    async () => {
      try {
        await run("pkill", ["-SIGINT", "-f", "simctl.*recordVideo"]);

        // Wait a moment for the video to finalize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Recording stopped successfully.",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("install_app")) {
  server.tool(
    "install_app",
    "Installs an app bundle (.app or .ipa) on the iOS Simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      app_path: z
        .string()
        .max(1024)
        .describe(
          "Path to the app bundle (.app directory or .ipa file) to install"
        ),
    },
    async ({ udid, app_path }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
        const absolutePath = path.isAbsolute(app_path)
          ? app_path
          : path.resolve(app_path);

        // Check if the app bundle exists
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`App bundle not found at: ${absolutePath}`);
        }

        // run() will throw if the command fails (non-zero exit code)
        await run("xcrun", ["simctl", "install", actualUdid, absolutePath]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App installed successfully from: ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error installing app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("launch_app")) {
  server.tool(
    "launch_app",
    "Launches an app on the iOS Simulator by bundle identifier",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      bundle_id: z
        .string()
        .max(256)
        .describe(
          "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
        ),
      terminate_running: z
        .boolean()
        .optional()
        .describe(
          "Terminate the app if it is already running before launching"
        ),
    },
    async ({ udid, bundle_id, terminate_running }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        // run() will throw if the command fails (non-zero exit code)
        const { stdout } = await run("xcrun", [
          "simctl",
          "launch",
          ...(terminate_running ? ["--terminate-running-process"] : []),
          actualUdid,
          bundle_id,
        ]);

        // Extract PID from output if available
        // simctl launch outputs the PID as the first token in stdout
        const pidMatch = stdout.match(/^(\d+)/);
        const pid = pidMatch ? pidMatch[1] : null;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: pid
                ? `App ${bundle_id} launched successfully with PID: ${pid}`
                : `App ${bundle_id} launched successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error launching app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

// Cleanup handlers for releasing simulator locks
process.on("exit", () => {
  if (claimedSimulatorUdid) {
    releaseLock(claimedSimulatorUdid);
  }
});

process.on("SIGINT", () => {
  if (claimedSimulatorUdid) {
    releaseLock(claimedSimulatorUdid);
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (claimedSimulatorUdid) {
    releaseLock(claimedSimulatorUdid);
  }
  process.exit(0);
});

process.stdin.on("close", () => {
  console.log("iOS Simulator MCP Server closed");
  if (claimedSimulatorUdid) {
    releaseLock(claimedSimulatorUdid);
  }
  server.close();
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});
