/**
 * Worklog utilities for time tracking.
 *
 * Supports natural time input formats:
 * - Jira format: 1w 2d 3h 4m
 * - Decimal hours: 1.5h, 2.25h
 * - Minutes: 90m, 45m
 * - HH:MM format: 1:30, 2:45
 * - Verbose: "1 hour 30 minutes"
 *
 * Also provides timer mode for start/stop tracking.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

/** Jira time configuration (can be customized per instance) */
export interface TimeConfig {
  /** Hours per day (default: 8) */
  hoursPerDay: number;
  /** Days per week (default: 5) */
  daysPerWeek: number;
}

const DEFAULT_CONFIG: TimeConfig = {
  hoursPerDay: 8,
  daysPerWeek: 5,
};

/**
 * Parse natural time input to seconds.
 *
 * Supported formats:
 * - "1h30m", "1h 30m" - hours and minutes
 * - "1.5h", "2.25h" - decimal hours
 * - "90m", "45m" - minutes only
 * - "2h" - hours only
 * - "1d", "2d" - days
 * - "1w" - weeks
 * - "1:30", "2:45" - HH:MM format
 * - "1 hour 30 minutes" - verbose
 * - Combinations: "1w 2d 3h 4m"
 */
export function parseTimeToSeconds(
  input: string,
  config: TimeConfig = DEFAULT_CONFIG
): number {
  const trimmed = input.trim().toLowerCase();

  // Handle HH:MM format (e.g., "1:30", "02:45")
  const hhmmMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (hhmmMatch) {
    const hours = parseInt(hhmmMatch[1], 10);
    const minutes = parseInt(hhmmMatch[2], 10);
    return (hours * 60 + minutes) * 60;
  }

  // Handle decimal hours (e.g., "1.5h", "2.25h")
  const decimalMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/);
  if (decimalMatch) {
    const hours = parseFloat(decimalMatch[1]);
    return Math.round(hours * 3600);
  }

  // Handle minutes only (e.g., "90m", "45 minutes")
  const minutesOnlyMatch = trimmed.match(/^(\d+)\s*(?:m|min|mins|minutes?)$/);
  if (minutesOnlyMatch) {
    return parseInt(minutesOnlyMatch[1], 10) * 60;
  }

  // Handle Jira-style format: 1w 2d 3h 4m
  let totalSeconds = 0;
  let matched = false;

  // Weeks
  const weeksMatch = trimmed.match(/(\d+)\s*w(?:eeks?)?/);
  if (weeksMatch) {
    totalSeconds += parseInt(weeksMatch[1], 10) * config.daysPerWeek * config.hoursPerDay * 3600;
    matched = true;
  }

  // Days
  const daysMatch = trimmed.match(/(\d+)\s*d(?:ays?)?/);
  if (daysMatch) {
    totalSeconds += parseInt(daysMatch[1], 10) * config.hoursPerDay * 3600;
    matched = true;
  }

  // Hours (non-decimal in combined format)
  const hoursMatch = trimmed.match(/(\d+)\s*h(?:ours?)?(?!\d*\.)/);
  if (hoursMatch) {
    totalSeconds += parseInt(hoursMatch[1], 10) * 3600;
    matched = true;
  }

  // Minutes
  const minsMatch = trimmed.match(/(\d+)\s*m(?:in(?:ute)?s?)?(?![a-z])/);
  if (minsMatch) {
    totalSeconds += parseInt(minsMatch[1], 10) * 60;
    matched = true;
  }

  if (matched && totalSeconds > 0) {
    return totalSeconds;
  }

  // Try parsing verbose format: "1 hour 30 minutes", "2 hours"
  const verboseHours = trimmed.match(/(\d+)\s*hours?/);
  const verboseMins = trimmed.match(/(\d+)\s*minutes?/);

  if (verboseHours || verboseMins) {
    let secs = 0;
    if (verboseHours) secs += parseInt(verboseHours[1], 10) * 3600;
    if (verboseMins) secs += parseInt(verboseMins[1], 10) * 60;
    if (secs > 0) return secs;
  }

  throw new Error(
    `Invalid time format: "${input}". ` +
      `Supported: 1h30m, 1.5h, 90m, 1:30, "1 hour 30 minutes", 1w2d3h4m`
  );
}

/**
 * Convert seconds to Jira time format (e.g., "1h 30m").
 */
export function secondsToJiraFormat(
  seconds: number,
  config: TimeConfig = DEFAULT_CONFIG
): string {
  if (seconds <= 0) return "0m";

  const parts: string[] = [];

  const hoursPerWeek = config.daysPerWeek * config.hoursPerDay;
  const secondsPerWeek = hoursPerWeek * 3600;
  const secondsPerDay = config.hoursPerDay * 3600;

  // Weeks
  const weeks = Math.floor(seconds / secondsPerWeek);
  if (weeks > 0) {
    parts.push(`${weeks}w`);
    seconds -= weeks * secondsPerWeek;
  }

  // Days
  const days = Math.floor(seconds / secondsPerDay);
  if (days > 0) {
    parts.push(`${days}d`);
    seconds -= days * secondsPerDay;
  }

  // Hours
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) {
    parts.push(`${hours}h`);
    seconds -= hours * 3600;
  }

  // Minutes
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  return parts.length > 0 ? parts.join(" ") : "0m";
}

/**
 * Convert seconds to human-readable format (e.g., "1 hour 30 minutes").
 */
export function secondsToHuman(seconds: number): string {
  if (seconds <= 0) return "0 minutes";

  const parts: string[] = [];

  const hours = Math.floor(seconds / 3600);
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
    seconds -= hours * 3600;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }

  return parts.length > 0 ? parts.join(" ") : "0 minutes";
}

/**
 * Round seconds to the nearest interval.
 *
 * @param seconds - Time in seconds
 * @param intervalMinutes - Rounding interval in minutes (e.g., 15)
 * @param mode - "nearest" (default), "up", or "down"
 */
export function roundTime(
  seconds: number,
  intervalMinutes: number,
  mode: "nearest" | "up" | "down" = "nearest"
): number {
  const intervalSeconds = intervalMinutes * 60;

  switch (mode) {
    case "up":
      return Math.ceil(seconds / intervalSeconds) * intervalSeconds;
    case "down":
      return Math.floor(seconds / intervalSeconds) * intervalSeconds;
    case "nearest":
    default:
      return Math.round(seconds / intervalSeconds) * intervalSeconds;
  }
}

/**
 * Parse a rounding interval (e.g., "15m", "30m", "1h").
 */
export function parseRoundingInterval(input: string): number {
  const trimmed = input.trim().toLowerCase();

  const minutesMatch = trimmed.match(/^(\d+)\s*m(?:in)?$/);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10);
  }

  const hoursMatch = trimmed.match(/^(\d+)\s*h$/);
  if (hoursMatch) {
    return parseInt(hoursMatch[1], 10) * 60;
  }

  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    return parseInt(numMatch[1], 10); // Assume minutes
  }

  throw new Error(`Invalid rounding interval: "${input}". Use: 15m, 30m, 1h`);
}

/**
 * Format a date for Jira worklog "started" field.
 * ISO 8601 format: 2026-01-12T14:30:00.000+0100
 */
export function formatWorklogDate(date: Date = new Date()): string {
  return date.toISOString().replace("Z", "+0000");
}

/**
 * Parse various date inputs for the "started" field.
 *
 * Supports:
 * - ISO 8601: "2026-01-12T14:30:00"
 * - Date only: "2026-01-12" (uses current time)
 * - Time only: "14:30" (uses today)
 * - Relative: "today", "yesterday"
 */
export function parseStartedDate(input: string): Date {
  const trimmed = input.trim().toLowerCase();

  // "today" - start of today + current time
  if (trimmed === "today" || trimmed === "now") {
    return new Date();
  }

  // "yesterday"
  if (trimmed === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }

  // Time only (HH:MM) - today at that time
  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const d = new Date();
    d.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
    return d;
  }

  // Date only (YYYY-MM-DD) - that day at current time
  const dateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const now = new Date();
    return new Date(
      parseInt(dateMatch[1], 10),
      parseInt(dateMatch[2], 10) - 1,
      parseInt(dateMatch[3], 10),
      now.getHours(),
      now.getMinutes()
    );
  }

  // Try parsing as ISO date
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(
    `Invalid date format: "${input}". ` +
      `Supported: 2026-01-12, 14:30, today, yesterday, ISO 8601`
  );
}

// ============ Timer Mode ============

/** Timer state stored in ~/.atlcli/timer.json */
export interface TimerState {
  /** Jira issue key (e.g., "PROJ-123") */
  issueKey: string;
  /** ISO timestamp when timer was started */
  startedAt: string;
  /** Profile name used for this timer */
  profile: string;
  /** Optional comment for the worklog */
  comment?: string;
}

/** Get path to the timer state file */
export function getTimerPath(): string {
  return join(homedir(), ".atlcli", "timer.json");
}

/** Get path to the atlcli config directory */
function getAtlcliDir(): string {
  return join(homedir(), ".atlcli");
}

/**
 * Load the current timer state, if any.
 * Returns null if no timer is running.
 */
export function loadTimer(): TimerState | null {
  const path = getTimerPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as TimerState;
  } catch {
    return null;
  }
}

/**
 * Save a new timer state.
 * Overwrites any existing timer.
 */
export function saveTimer(state: TimerState): void {
  const dir = getAtlcliDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getTimerPath(), JSON.stringify(state, null, 2));
}

/**
 * Clear (delete) the timer state file.
 */
export function clearTimer(): void {
  const path = getTimerPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Get elapsed seconds since timer started.
 * Returns 0 if no timer is running.
 */
export function getElapsedSeconds(timer: TimerState | null): number {
  if (!timer) return 0;
  const started = new Date(timer.startedAt);
  const now = new Date();
  return Math.floor((now.getTime() - started.getTime()) / 1000);
}

/**
 * Start a new timer for an issue.
 * Throws if a timer is already running.
 */
export function startTimer(
  issueKey: string,
  profile: string,
  comment?: string
): TimerState {
  const existing = loadTimer();
  if (existing) {
    throw new Error(
      `Timer already running for ${existing.issueKey} (started ${formatElapsed(getElapsedSeconds(existing))} ago). ` +
        `Use 'jira worklog timer stop' or 'jira worklog timer cancel' first.`
    );
  }

  const state: TimerState = {
    issueKey,
    startedAt: new Date().toISOString(),
    profile,
    comment,
  };
  saveTimer(state);
  return state;
}

/**
 * Stop the timer and return the elapsed time.
 * Throws if no timer is running.
 */
export function stopTimer(): { timer: TimerState; elapsedSeconds: number } {
  const timer = loadTimer();
  if (!timer) {
    throw new Error("No timer is running. Use 'jira worklog timer start <issue>' to start one.");
  }
  const elapsedSeconds = getElapsedSeconds(timer);
  clearTimer();
  return { timer, elapsedSeconds };
}

/**
 * Cancel the timer without logging time.
 * Throws if no timer is running.
 */
export function cancelTimer(): TimerState {
  const timer = loadTimer();
  if (!timer) {
    throw new Error("No timer is running.");
  }
  clearTimer();
  return timer;
}

/**
 * Format elapsed time for display (e.g., "1h 23m" or "45m").
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}
