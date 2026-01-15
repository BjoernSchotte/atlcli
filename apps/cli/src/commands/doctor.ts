/**
 * Doctor command for atlcli.
 *
 * Diagnoses common issues with atlcli setup, authentication, and connectivity.
 *
 * atlcli doctor           - Run all checks
 * atlcli doctor --fix     - Auto-fix safe issues
 * atlcli doctor --json    - JSON output for scripting
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  output,
  hasFlag,
  loadConfig,
  getActiveProfile,
  type Profile,
} from "@atlcli/core";
import type { OutputOptions } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { JiraClient } from "@atlcli/jira";

type CheckCategory = "config" | "auth" | "connectivity" | "permissions";
type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  category: CheckCategory;
  status: CheckStatus;
  message: string;
  suggestion?: string;
  fixable?: boolean;
  details?: Record<string, unknown>;
}

interface DoctorOutput {
  schemaVersion: string;
  checks: CheckResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
}

const CONFIG_PATH = join(homedir(), ".atlcli", "config.json");
const LOG_DIR = join(homedir(), ".atlcli", "logs");
const LATENCY_WARN_THRESHOLD = 2000; // 2 seconds

export async function handleDoctor(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // Show help if --help or -h flag is set
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(doctorHelp(), opts);
    return;
  }

  const fix = hasFlag(flags, "fix");
  const results: CheckResult[] = [];

  // Run all checks
  results.push(await checkConfigExists(fix));
  results.push(await checkConfigValid());
  results.push(await checkProfileExists());
  results.push(await checkActiveProfile());

  // Only run connectivity checks if we have a valid profile
  const hasValidProfile = results.every(r => r.status !== "fail");
  if (hasValidProfile) {
    const connectivityResults = await checkConnectivity();
    results.push(...connectivityResults);
  }

  results.push(await checkLogDirectory(fix));

  // Calculate summary
  const summary = {
    passed: results.filter((r) => r.status === "pass").length,
    warnings: results.filter((r) => r.status === "warn").length,
    failed: results.filter((r) => r.status === "fail").length,
  };

  // Output results
  if (opts.json) {
    const doctorOutput: DoctorOutput = {
      schemaVersion: "1",
      checks: results,
      summary,
    };
    output(doctorOutput, opts);
  } else {
    outputHuman(results, summary);
  }

  // Exit code: 1 if any checks failed
  if (summary.failed > 0) {
    process.exit(1);
  }
}

// --- Individual Check Functions ---

async function checkConfigExists(fix: boolean): Promise<CheckResult> {
  if (!existsSync(CONFIG_PATH)) {
    if (fix) {
      try {
        await mkdir(dirname(CONFIG_PATH), { recursive: true });
        await writeFile(
          CONFIG_PATH,
          JSON.stringify({ profiles: {} }, null, 2)
        );
        return {
          name: "config_exists",
          category: "config",
          status: "pass",
          message: "Config file created",
          details: { path: CONFIG_PATH, fixed: true },
        };
      } catch (err) {
        return {
          name: "config_exists",
          category: "config",
          status: "fail",
          message: "Failed to create config file",
          suggestion: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {
      name: "config_exists",
      category: "config",
      status: "fail",
      message: "Config file missing",
      suggestion: "Run: atlcli auth login",
      fixable: true,
      details: { path: CONFIG_PATH },
    };
  }

  return {
    name: "config_exists",
    category: "config",
    status: "pass",
    message: "Config file exists",
    details: { path: CONFIG_PATH },
  };
}

async function checkConfigValid(): Promise<CheckResult> {
  if (!existsSync(CONFIG_PATH)) {
    return {
      name: "config_valid",
      category: "config",
      status: "fail",
      message: "Config file missing",
    };
  }

  try {
    const content = await readFile(CONFIG_PATH, "utf-8");
    JSON.parse(content);
    return {
      name: "config_valid",
      category: "config",
      status: "pass",
      message: "Config file is valid JSON",
    };
  } catch {
    return {
      name: "config_valid",
      category: "config",
      status: "fail",
      message: "Config file is invalid JSON",
      suggestion: "Check ~/.atlcli/config.json syntax",
    };
  }
}

async function checkProfileExists(): Promise<CheckResult> {
  try {
    const config = await loadConfig();
    const profileCount = Object.keys(config.profiles || {}).length;

    if (profileCount === 0) {
      return {
        name: "profile_exists",
        category: "auth",
        status: "fail",
        message: "No profiles configured",
        suggestion: "Run: atlcli auth login",
      };
    }

    return {
      name: "profile_exists",
      category: "auth",
      status: "pass",
      message: `${profileCount} profile(s) configured`,
      details: { count: profileCount, profiles: Object.keys(config.profiles) },
    };
  } catch {
    return {
      name: "profile_exists",
      category: "auth",
      status: "fail",
      message: "Could not load config",
    };
  }
}

async function checkActiveProfile(): Promise<CheckResult> {
  try {
    const config = await loadConfig();
    const profile = getActiveProfile(config);

    if (!profile) {
      return {
        name: "active_profile",
        category: "auth",
        status: "fail",
        message: "No active profile",
        suggestion: "Run: atlcli auth switch <profile>",
      };
    }

    // Check profile has required fields
    if (!profile.baseUrl) {
      return {
        name: "active_profile",
        category: "auth",
        status: "fail",
        message: "Active profile missing baseUrl",
        suggestion: "Run: atlcli auth login",
      };
    }

    if (!profile.auth?.email || !profile.auth?.token) {
      return {
        name: "active_profile",
        category: "auth",
        status: "fail",
        message: "Active profile missing credentials",
        suggestion: "Run: atlcli auth login",
      };
    }

    return {
      name: "active_profile",
      category: "auth",
      status: "pass",
      message: `Active profile: ${config.currentProfile}`,
      details: { profile: config.currentProfile, baseUrl: profile.baseUrl },
    };
  } catch {
    return {
      name: "active_profile",
      category: "auth",
      status: "fail",
      message: "Could not load active profile",
    };
  }
}

async function checkConnectivity(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const config = await loadConfig();
    const profile = getActiveProfile(config);

    if (!profile) {
      return [
        {
          name: "connectivity",
          category: "connectivity",
          status: "fail",
          message: "No active profile for connectivity check",
        },
      ];
    }

    // Check Confluence API
    results.push(await checkConfluenceApi(profile));

    // Check Jira API
    results.push(await checkJiraApi(profile));
  } catch (err) {
    results.push({
      name: "connectivity",
      category: "connectivity",
      status: "fail",
      message: "Connectivity check failed",
      suggestion: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

async function checkConfluenceApi(profile: Profile): Promise<CheckResult> {
  try {
    const start = Date.now();
    const client = new ConfluenceClient(profile);
    await client.getCurrentUser();
    const latency = Date.now() - start;

    const wikiUrl = `${profile.baseUrl}/wiki`;

    if (latency > LATENCY_WARN_THRESHOLD) {
      return {
        name: "confluence_api",
        category: "connectivity",
        status: "warn",
        message: `Confluence API slow (${latency}ms)`,
        details: { url: wikiUrl, latencyMs: latency },
      };
    }

    return {
      name: "confluence_api",
      category: "connectivity",
      status: "pass",
      message: `Confluence API OK (${latency}ms)`,
      details: { url: wikiUrl, latencyMs: latency },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const is401 = message.includes("401") || message.includes("Unauthorized");

    return {
      name: "confluence_api",
      category: "connectivity",
      status: "fail",
      message: is401 ? "Confluence auth failed" : "Confluence API unreachable",
      suggestion: is401
        ? "Run: atlcli auth login"
        : "Check network connection and baseUrl",
      details: { error: message },
    };
  }
}

async function checkJiraApi(profile: Profile): Promise<CheckResult> {
  try {
    const start = Date.now();
    const client = new JiraClient(profile);
    await client.getCurrentUser();
    const latency = Date.now() - start;

    if (latency > LATENCY_WARN_THRESHOLD) {
      return {
        name: "jira_api",
        category: "connectivity",
        status: "warn",
        message: `Jira API slow (${latency}ms)`,
        details: { url: profile.baseUrl, latencyMs: latency },
      };
    }

    return {
      name: "jira_api",
      category: "connectivity",
      status: "pass",
      message: `Jira API OK (${latency}ms)`,
      details: { url: profile.baseUrl, latencyMs: latency },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const is401 = message.includes("401") || message.includes("Unauthorized");

    return {
      name: "jira_api",
      category: "connectivity",
      status: "fail",
      message: is401 ? "Jira auth failed" : "Jira API unreachable",
      suggestion: is401
        ? "Run: atlcli auth login"
        : "Check network connection and baseUrl",
      details: { error: message },
    };
  }
}

async function checkLogDirectory(fix: boolean): Promise<CheckResult> {
  if (!existsSync(LOG_DIR)) {
    if (fix) {
      try {
        await mkdir(LOG_DIR, { recursive: true });
        return {
          name: "log_directory",
          category: "permissions",
          status: "pass",
          message: "Log directory created",
          details: { path: LOG_DIR, fixed: true },
        };
      } catch (err) {
        return {
          name: "log_directory",
          category: "permissions",
          status: "fail",
          message: "Failed to create log directory",
          suggestion: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {
      name: "log_directory",
      category: "permissions",
      status: "warn",
      message: "Log directory missing",
      suggestion: "Run: atlcli doctor --fix",
      fixable: true,
      details: { path: LOG_DIR },
    };
  }

  // Check write permissions
  try {
    await access(LOG_DIR, constants.W_OK);
    return {
      name: "log_directory",
      category: "permissions",
      status: "pass",
      message: "Log directory writable",
      details: { path: LOG_DIR },
    };
  } catch {
    return {
      name: "log_directory",
      category: "permissions",
      status: "fail",
      message: "Log directory not writable",
      suggestion: `Check permissions on ${LOG_DIR}`,
      details: { path: LOG_DIR },
    };
  }
}

// --- Output Formatting ---

function outputHuman(
  results: CheckResult[],
  summary: { passed: number; warnings: number; failed: number }
): void {
  const categories = ["config", "auth", "connectivity", "permissions"] as const;
  const categoryLabels: Record<CheckCategory, string> = {
    config: "Config",
    auth: "Authentication",
    connectivity: "Connectivity",
    permissions: "Permissions",
  };

  const statusIcons: Record<CheckStatus, string> = {
    pass: "\x1b[32m✓\x1b[0m", // green
    warn: "\x1b[33m⚠\x1b[0m", // yellow
    fail: "\x1b[31m✗\x1b[0m", // red
  };

  console.log("");

  for (const category of categories) {
    const categoryResults = results.filter((r) => r.category === category);
    if (categoryResults.length === 0) continue;

    console.log(`  ${categoryLabels[category]}`);

    for (const result of categoryResults) {
      const icon = statusIcons[result.status];
      let line = `    ${icon} ${result.message}`;

      // Add latency for connectivity checks
      if (result.details?.latencyMs) {
        // Already included in message
      }

      console.log(line);

      // Show suggestion for failures/warnings
      if (result.suggestion && result.status !== "pass") {
        console.log(`      \x1b[90m→ ${result.suggestion}\x1b[0m`);
      }
    }

    console.log("");
  }

  // Summary line
  const parts: string[] = [];
  if (summary.passed > 0) {
    parts.push(`\x1b[32m${summary.passed} passed\x1b[0m`);
  }
  if (summary.warnings > 0) {
    parts.push(`\x1b[33m${summary.warnings} warning(s)\x1b[0m`);
  }
  if (summary.failed > 0) {
    parts.push(`\x1b[31m${summary.failed} failed\x1b[0m`);
  }

  console.log(`  ${parts.join(", ")}`);
  console.log("");
}

function doctorHelp(): string {
  return `atlcli doctor [options]

Diagnose common issues with atlcli setup and connectivity.

Options:
  --fix   Auto-fix safe issues (create directories, etc.)
  --json  JSON output for scripting

Checks:
  - Config file exists and valid
  - Profile configured with credentials
  - Confluence API reachable
  - Jira API reachable
  - Log directory writable

Examples:
  atlcli doctor
  atlcli doctor --fix
  atlcli doctor --json
`;
}
